import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("formal_build", ROOT / "scripts/build-formal-python.py")
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class NativeTransport(ast.NodeTransformer):
    def visit_Name(self, node):
        if node.id in ("Popen", "check_output"):
            return ast.Attribute(value=ast.Name(id="subprocess", ctx=ast.Load()), attr=node.id, ctx=node.ctx)
        return node

    def visit_Assign(self, node):
        if any(ast.dump(node) == ast.dump(ast.parse(f"{name} = subprocess.{name}").body[0])
               for name in ("Popen", "check_output")):
            return None
        return self.generic_visit(node)

    def visit_If(self, node):
        condition = ast.unparse(node.test)
        if condition == "sys.platform == 'emscripten'":
            return [result for item in node.orelse if (result := self.visit(item)) is not None]
        if condition == "os.name == 'posix' and sys.platform != 'emscripten'":
            node.test = ast.parse('os.name == "posix"', mode="eval").body
        return self.generic_visit(node)


def normalized(text):
    tree = NativeTransport().visit(ast.parse(text))
    combined = []
    for node in tree.body:
        if combined and isinstance(node, ast.If) and isinstance(combined[-1], ast.If) and \
                not node.orelse and not combined[-1].orelse and ast.dump(node.test) == ast.dump(combined[-1].test):
            combined[-1].body.extend(node.body)
        else:
            combined.append(node)
    tree.body = combined
    return ast.dump(tree, include_attributes=False)


class FormalPythonBuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        cls.out = Path(cls.tmp.name) / "first"
        BUILD.build(ROOT, cls.out)
        cls.manifest = json.loads((cls.out / "manifest.json").read_text())

    def test_staged_sources_and_licenses_match_pinned_originals_except_smtio(self):
        for name, origin in self.manifest["origins"].items():
            with self.subTest(name=name):
                commit = self.manifest["pins"][origin["submodule"]]
                original = subprocess.check_output(["git", "-C", str(ROOT / "vendor" / origin["submodule"]),
                                                    "show", f'{commit}:{origin["source"]}'])
                self.assertEqual(hashlib.sha256(original).hexdigest(), origin["original_sha256"])
                if name not in {"smtio.py", "sby.py", "sby_core.py", "sby_jobserver.py"}:
                    self.assertEqual((self.out / name).read_bytes(), original)
        self.assertEqual(set(self.manifest["pins"]), {"yosys", "sby", "click"})
        self.assertEqual((self.out / "formal_process.py").read_bytes(), (ROOT / "web/formal_process.py").read_bytes())
        self.assertEqual((self.out / "formal_trace.py").read_bytes(), (ROOT / "web/formal_trace.py").read_bytes())
        for asset in self.manifest["assets"]:
            raw = (self.out / asset["path"]).read_bytes()
            self.assertEqual(len(raw), asset["size"])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), asset["sha256"])

    def original(self):
        pin = self.manifest["pins"]["yosys"]
        return subprocess.check_output(["git", "-C", str(ROOT / "vendor/yosys"), "show", f"{pin}:backends/smt2/smtio.py"]).decode()

    def test_entire_smtio_ast_is_unchanged_when_only_transport_branches_are_removed(self):
        self.assertEqual(normalized(self.original()), normalized((self.out / "smtio.py").read_text()))

    def test_entire_sby_ast_is_unchanged_when_only_browser_transport_branches_are_removed(self):
        for name in ("sby.py", "sby_core.py", "sby_jobserver.py"):
            pin = self.manifest["pins"]["sby"]
            original = subprocess.check_output(["git", "-C", str(ROOT / "vendor/sby"), "show", f"{pin}:sbysrc/{name}"]).decode()
            with self.subTest(name=name):
                self.assertEqual(normalized(original), normalized((self.out / name).read_text()))

    def test_browser_jobserver_never_creates_os_pipes_or_helper_processes(self):
        code = '''
import os, sys, subprocess
from unittest.mock import patch
import sby_jobserver
def forbidden(*args, **kwargs):
    raise AssertionError("Native process boundary was reached")
with patch.object(sys, "platform", "emscripten"), patch.object(os, "pipe", forbidden), patch.object(subprocess, "Popen", forbidden), patch.object(subprocess, "run", forbidden):
    sby_jobserver.process_jobserver_environment()
    client = sby_jobserver.SbyJobClient(1)
    first = client.request_lease()
    second = client.request_lease()
    assert first.is_ready and not second.is_ready
    client.return_lease()
    assert second.is_ready
    assert client.poll_fds() == []
    client.poll()
    assert client.helper_process is None
    try:
        sby_jobserver.SbyJobClient(2)
    except ValueError:
        pass
    else:
        raise AssertionError("Parallel jobs were not rejected")
'''
        subprocess.run([sys.executable, "-c", code], cwd=self.out, check=True, timeout=10)

    def test_ast_guard_rejects_a_forged_smt_status_even_with_the_transport_adapter(self):
        tree = ast.parse((self.out / "smtio.py").read_text())
        changed = 0
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and node.value == "sat":
                node.value = "unsat"
                changed += 1
                break
        self.assertEqual(changed, 1)
        self.assertNotEqual(normalized(self.original()), normalized(ast.unparse(tree)))

    def test_build_is_reproducible_and_refuses_to_overwrite_evidence(self):
        second = Path(self.tmp.name) / "second"
        BUILD.build(ROOT, second)
        self.assertEqual((self.out / "manifest.json").read_bytes(), (second / "manifest.json").read_bytes())
        for asset in self.manifest["assets"]:
            self.assertEqual((self.out / asset["path"]).read_bytes(), (second / asset["path"]).read_bytes())
        with self.assertRaises(FileExistsError):
            BUILD.build(ROOT, second)


if __name__ == "__main__":
    unittest.main()
