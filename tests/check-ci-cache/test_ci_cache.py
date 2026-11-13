import importlib.util
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / "scripts" / f"{name}.py")
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


CACHE = module("ci-build-cache")
TIMINGS = module("ci-build-timings")


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.paths = ["scripts/build.sh", "patches/tool.patch", "RESEARCH.md", "web/lib/boards.mjs",
                      "package-lock.json", ".nvmrc", ".github/workflows/build.yml", "web/style.css"]
        for name in self.paths:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("original")
        self.revision = b"a" * 40
        self.epoch = b"123"
        self.env = {"RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "ImageOS": "ubuntu26", "ImageVersion": "20261101"}
        self.key = "build-cache-v1-decoders-" + "a" * 64
        self.output = self.root / "build/wasi/decoders"
        self.output.mkdir(parents=True)
        (self.output / "decoder.wasm").write_bytes(b"\0asm\1\0\0\0")

    def git(self, root, *args):
        if args[0] == "ls-files":
            return "\0".join(self.paths).encode() + b"\0"
        if args[0] == "ls-tree":
            return b"160000 commit " + self.revision + b"\tvendor/tool\0"
        if args[0] == "show":
            return self.epoch
        raise AssertionError(args)

    def fingerprint(self, component="decoders", env=None):
        with patch.object(CACHE, "git", self.git), patch.object(CACHE.subprocess, "check_output", return_value="gcc=15\n"):
            return CACHE.key(self.root, component, self.env if env is None else env)

    def test_key_normal_and_all_invalidation_inputs(self):
        original = self.fingerprint()
        self.assertEqual(original, self.fingerprint())
        self.assertNotEqual(original, self.fingerprint("ghdl"))
        for name in self.paths[:-1]:
            with self.subTest(name=name):
                path = self.root / name
                path.write_text("changed")
                self.assertNotEqual(original, self.fingerprint())
                path.write_text("original")
        (self.root / "web/style.css").write_text("UI change")
        self.assertEqual(original, self.fingerprint())
        for name in ("ImageVersion", "ImageOS", "RUNNER_ARCH", "RUNNER_OS", "WASI_EXTRA_CFLAGS", "CXXFLAGS", "DECODER_LTO"):
            self.assertNotEqual(original, self.fingerprint(env={**self.env, name: "changed"}))
        with patch.object(CACHE, "SALT", "v-next"):
            self.assertNotEqual(original, self.fingerprint())
        self.revision = b"b" * 40
        self.assertNotEqual(original, self.fingerprint())

    def test_flasher_epoch_scoping_and_no_event_scoping(self):
        before = self.fingerprint("flasher")
        decoder = self.fingerprint()
        self.epoch = b"456"
        self.assertNotEqual(before, self.fingerprint("flasher"))
        self.assertEqual(decoder, self.fingerprint())
        self.assertEqual(decoder, self.fingerprint(env={**self.env, "GITHUB_EVENT_NAME": "pull_request"}))

    def test_missing_key_inputs_fail_closed(self):
        with self.assertRaises(ValueError):
            self.fingerprint(env={})
        (self.root / "scripts/build.sh").unlink()
        with self.assertRaises(ValueError):
            self.fingerprint()
        self.paths = []
        with self.assertRaises(ValueError):
            self.fingerprint()

    def test_round_trip_preserves_full_manifest_and_executable_bits(self):
        executable = self.output / "native"
        executable.write_bytes(b"reference")
        executable.chmod(0o755)
        original = CACHE.tree(self.root, "decoders")
        CACHE.seal(self.root, "decoders", self.key)
        backup = self.root / "backup"
        shutil.copytree(self.output, backup)
        shutil.rmtree(self.output)
        shutil.copytree(backup, self.output)
        CACHE.check(self.root, "decoders", self.key)
        self.assertEqual(original, CACHE.tree(self.root, "decoders"))
        self.assertEqual(0o755, executable.stat().st_mode & 0o777)

    def test_tamper_missing_extra_permissions_and_wrong_key(self):
        for change in ("bytes", "delete", "extra", "mode", "key", "metadata"):
            with self.subTest(change=change):
                path = self.output / "decoder.wasm"
                path.write_bytes(b"original")
                path.chmod(0o644)
                CACHE.seal(self.root, "decoders", self.key)
                if change == "bytes":
                    path.write_bytes(b"corrupt!")
                elif change == "delete":
                    path.unlink()
                elif change == "extra":
                    (self.output / "extra").write_text("unexpected")
                elif change == "mode":
                    path.chmod(0o755)
                elif change == "metadata":
                    CACHE.manifest_path(self.root, "decoders").write_text("{")
                with self.assertRaises((ValueError, OSError)):
                    CACHE.check(self.root, "decoders", self.key + ("bad" if change == "key" else ""))
                (self.output / "extra").unlink(missing_ok=True)

    def test_empty_and_missing_outputs_fail_closed(self):
        (self.output / "decoder.wasm").unlink()
        with self.assertRaises(ValueError):
            CACHE.seal(self.root, "decoders", self.key)
        self.output.rmdir()
        with self.assertRaises(ValueError):
            CACHE.seal(self.root, "decoders", self.key)
        with self.assertRaises(OSError):
            CACHE.check(self.root, "decoders", self.key)

    def test_output_symlinks_are_verified_and_bounded(self):
        link = self.output / "alias"
        link.symlink_to("decoder.wasm")
        CACHE.seal(self.root, "decoders", self.key)
        CACHE.check(self.root, "decoders", self.key)
        link.unlink()
        link.symlink_to(self.root / "RESEARCH.md")
        with self.assertRaises(ValueError):
            CACHE.seal(self.root, "decoders", self.key)
        link.unlink()
        link.symlink_to("/etc/passwd")
        with self.assertRaises(ValueError):
            CACHE.seal(self.root, "decoders", self.key)

    def test_input_links_record_target_without_following(self):
        cache = self.root / "build/cache/pack"
        cache.mkdir(parents=True)
        (cache / "wheel").write_bytes(b"pinned download")
        (cache / "python").symlink_to("/usr/bin/python3")
        CACHE.seal(self.root, "pack-inputs", self.key)
        CACHE.check(self.root, "pack-inputs", self.key)
        (cache / "python").unlink()
        (cache / "python").symlink_to("/usr/bin/other")
        with self.assertRaises(ValueError):
            CACHE.check(self.root, "pack-inputs", self.key)

    def test_duplicate_and_nonstandard_json_fail_closed(self):
        CACHE.seal(self.root, "decoders", self.key)
        path = CACHE.manifest_path(self.root, "decoders")
        original = path.read_text()
        for value in ('{"key":"' + self.key + '",' + original[1:], 'NaN', '{"key":Infinity}'):
            path.write_text(value)
            with self.assertRaises(ValueError):
                CACHE.check(self.root, "decoders", self.key)

    def test_symlink_ancestor_fails_closed(self):
        shutil.rmtree(self.root / "build/wasi")
        (self.root / "build/wasi").symlink_to(self.root / "web")
        (self.root / "web/decoders").mkdir()
        (self.root / "web/decoders/data").write_text("redirected")
        with self.assertRaises(ValueError):
            CACHE.seal(self.root, "decoders", self.key)

    def test_timing_parser(self):
        self.assertEqual(90, TIMINGS.seconds("2026-11-13T00:00:00Z", "2026-11-13T00:01:30Z"))
        self.assertEqual(0, TIMINGS.seconds("2026-11-13T00:00:00Z", "2026-11-13T00:00:00Z"))
        with self.assertRaises(ValueError):
            TIMINGS.seconds("2026-11-13T00:01:00Z", "2026-11-13T00:00:00Z")
        with self.assertRaises(ValueError):
            TIMINGS.seconds("not a date", "not a date")

    def test_workflow_cache_writer_policy_and_no_test_skips(self):
        workflow = (ROOT / ".github/workflows/build.yml").read_text()
        self.assertEqual(set(CACHE.COMPONENTS), set(re.findall(r"COMPONENT: (\S+)", workflow)))
        for step in re.split(r"(?=^      - )", workflow, flags=re.M):
            if "uses: actions/cache/save@" in step or "ci-build-cache.py seal" in step:
                self.assertIn("github.ref == 'refs/heads/main'", step)
                self.assertIn("github.event_name == 'push' || github.event_name == 'schedule'", step)
            if any(command in step for command in ("run: node --test", "run: npx playwright", "name: Native / Pyodide gowin_pack parity", "name: 仮想 USB シミュレーション")):
                self.assertNotRegex(step, r"if:.*cache-hit")
        self.assertEqual(16, workflow.count("uses: actions/cache/save@"))
        self.assertEqual(16, workflow.count("ci-build-cache.py check"))
        self.assertEqual(16, workflow.count("lookup-only: true"))
        self.assertEqual(16, workflow.count("fail-on-cache-miss: true"))
        self.assertEqual(16, workflow.count('"$EXPECTED_HIT" == true && "$CACHE_HIT" != true'))
        self.assertNotIn("restore-keys", workflow)
        self.assertNotIn("pull_request_target", workflow)


if __name__ == "__main__":
    unittest.main()
