#!/usr/bin/env python3

import argparse
import csv
import hashlib
import json
import os
import re
import shlex
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD_ROOT = ROOT / "build/s5"
DEFAULT_CSV = ROOT / "docs/experiments/S5-wasi-build-options.csv"
sys.path.insert(0, str(ROOT / "scripts"))
from zstd_cli import require_pinned_zstd_version  # noqa: E402


BOARDS = ("tangnano1k", "tangnano4k", "tangnano9k", "tangnano20k")
VARIANTS = {
    "B": {"opt": "", "expected_opt": "-O3", "c": "", "cxx": "", "ld": ""},
    "B2": {"opt": "", "expected_opt": "-O3", "c": "", "cxx": "", "ld": ""},
    "O2": {"opt": "-O2", "expected_opt": "-O2", "c": "", "cxx": "", "ld": ""},
    "Os": {"opt": "-Os", "expected_opt": "-Os", "c": "", "cxx": "", "ld": ""},
    "Oz": {"opt": "-Oz", "expected_opt": "-Oz", "c": "", "cxx": "", "ld": ""},
    "LTO": {
        "opt": "",
        "expected_opt": "-O3",
        "c": "-flto",
        "cxx": "-flto",
        "ld": "-flto",
        "use_ipo": "OFF",
    },
    "OsLTO": {
        "opt": "-Os",
        "expected_opt": "-Os",
        "c": "-flto",
        "cxx": "-flto",
        "ld": "-flto",
        "use_ipo": "OFF",
    },
    "TLTO": {
        "opt": "",
        "expected_opt": "-O3",
        "c": "-flto=thin",
        "cxx": "-flto=thin",
        "ld": "-flto=thin",
    },
    "SIMD": {
        "opt": "",
        "expected_opt": "-O3",
        "c": "-msimd128",
        "cxx": "-msimd128",
        "ld": "-msimd128",
    },
    "TC": {
        "opt": "",
        "expected_opt": "-O3",
        "c": "-mtail-call",
        "cxx": "-mtail-call",
        "ld": "-mtail-call",
    },
}
ENV_KEYS = (
    "WASI_OPT_FLAGS",
    "WASI_EXTRA_CFLAGS",
    "WASI_EXTRA_CXXFLAGS",
    "WASI_EXTRA_LDFLAGS",
    "WASI_USE_IPO",
)
CSV_FIELDS = (
    "run_id",
    "variant",
    "repeat",
    "metric",
    "value",
    "unit",
    "valid",
    "note",
)
METRIC_UNITS = {
    "build_wall_s": "s",
    "build_peak_rss_kib": "KiB",
    "wasm_bytes": "bytes",
    "zstd19_bytes": "bytes",
    "wasm_sha256": "sha256",
    "synth_ms": "ms",
    "pnr_ms": "ms",
    "total_ms": "ms",
    "node_wall_s": "s",
    "yosys_memory_bytes": "bytes",
    "nextpnr_memory_bytes": "bytes",
    "netlist_sha256": "sha256",
    "pnr_sha256": "sha256",
    "fs_sha256": "sha256",
    "fs_bytes": "bytes",
    "identity_vs_B": "boolean",
}


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ResultWriter:
    def __init__(self, path, append=False):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_symlink():
            raise SystemExit(f"Refusing symlink CSV path: {path}")
        if append:
            if not path.is_file():
                raise SystemExit(f"Cannot append to missing CSV: {path}")
            with path.open(newline="", encoding="utf-8") as existing:
                header = next(csv.reader(existing), None)
            if header != list(CSV_FIELDS):
                raise SystemExit(f"CSV header does not match S5 schema: {path}")
            self.file = path.open("a", newline="", encoding="utf-8")
            self.writer = csv.DictWriter(self.file, fieldnames=CSV_FIELDS)
        else:
            if path.exists():
                raise SystemExit(f"Refusing to overwrite existing CSV: {path}")
            self.file = path.open("x", newline="", encoding="utf-8")
            self.writer = csv.DictWriter(self.file, fieldnames=CSV_FIELDS)
            self.writer.writeheader()
            self.file.flush()

    def write(self, **values):
        status = str(values.get("status", ""))
        note_parts = []
        for field in ("phase", "tool", "board", "output_dir", "details"):
            value = values.get(field)
            if value not in (None, ""):
                note_parts.append(f"{field}={value}")
        note = "; ".join(note_parts)
        rows = [
            {
                "run_id": values.get("run_id", ""),
                "variant": values.get("variant", ""),
                "repeat": values.get("repeat", ""),
                "metric": "status",
                "value": status,
                "unit": "status",
                "valid": str(status == "pass").lower(),
                "note": note,
            }
        ]
        for metric, value in values.items():
            if metric not in METRIC_UNITS or value in (None, ""):
                continue
            rows.append(
                {
                    "run_id": values.get("run_id", ""),
                    "variant": values.get("variant", ""),
                    "repeat": values.get("repeat", ""),
                    "metric": metric,
                    "value": value,
                    "unit": METRIC_UNITS[metric],
                    "valid": str(status == "pass").lower(),
                    "note": note,
                }
            )
        self.writer.writerows(rows)
        self.file.flush()

    def close(self):
        self.file.close()


def preflight_csv(path, append):
    if path.is_symlink():
        raise SystemExit(f"Refusing symlink CSV path: {path}")
    if append:
        if not path.is_file():
            raise SystemExit(f"Cannot append to missing CSV: {path}")
        with path.open(newline="", encoding="utf-8") as existing:
            header = next(csv.reader(existing), None)
        if header != list(CSV_FIELDS):
            raise SystemExit(f"CSV header does not match S5 schema: {path}")
    elif path.exists():
        raise SystemExit(f"Refusing to overwrite existing CSV: {path}")


def variant_root(variant):
    return BUILD_ROOT / variant


def tool_paths(variant, tool):
    directory = variant_root(variant) / tool
    if tool == "yosys":
        return directory, directory / "yosys.wasm"
    return directory, directory / "nextpnr-himbaechel-gowin.wasm"


def parse_wall_seconds(report):
    match = re.search(
        r"Elapsed \(wall clock\) time \([^)]*\):\s*(\S+)",
        report,
    )
    if not match:
        return ""
    parts = [float(value) for value in match.group(1).split(":")]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0]


def parse_peak_rss_kib(report):
    match = re.search(r"Maximum resident set size \(kbytes\):\s*(\d+)", report)
    return int(match.group(1)) if match else ""


def zstd19_size(path):
    result = subprocess.run(
        ["zstd", "-19", "-q", "--no-progress", "-c", str(path)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip()
        raise RuntimeError(f"zstd -19 failed for {path.name}: {detail}")
    return len(result.stdout)


def optimization_flags(build_directory):
    expected_flags = []
    for flags_path in build_directory.rglob("flags.make"):
        for line in flags_path.read_text(errors="replace").splitlines():
            if not re.match(r"\s*(?:C_FLAGS|CXX_FLAGS)\s*=", line):
                continue
            flags = line.split("=", 1)[1]
            found = re.findall(r"(?<!\S)-O(?:[0-3]|[sz])(?=\s|$)", flags)
            if found:
                expected_flags.append((flags_path, line, found))
    return expected_flags


def check_build_flags(variant, tool, directory):
    expected_opt = VARIANTS[variant]["expected_opt"]
    found_flags = optimization_flags(directory)
    if not found_flags:
        raise RuntimeError(f"No optimization flags found under {directory.relative_to(ROOT)}")
    for flags_path, line, found in found_flags:
        if found.count(expected_opt) != 1 or found[-1] != expected_opt:
            raise RuntimeError(
                f"Expected one final {expected_opt} in {flags_path.relative_to(ROOT)}; "
                f"found {found}: {line}"
            )

    config = VARIANTS[variant]
    for field, token in (("c", "C_FLAGS"), ("cxx", "CXX_FLAGS")):
        required = shlex.split(config[field])
        if required:
            evidence_lines = [
                line
                for flags_path in directory.rglob("flags.make")
                for line in flags_path.read_text(errors="replace").splitlines()
                if re.match(rf"\s*{token}\s*=", line)
            ]
            cache_key = (
                "CMAKE_C_FLAGS" if token == "C_FLAGS" else "CMAKE_CXX_FLAGS"
            )
            cache_path = directory / "CMakeCache.txt"
            if cache_path.is_file():
                evidence_lines.extend(
                    line.split("=", 1)[1]
                    for line in cache_path.read_text(errors="replace").splitlines()
                    if line.startswith(f"{cache_key}:STRING=")
                )
            if token == "C_FLAGS" and not evidence_lines:
                continue
            evidence = "\n".join(evidence_lines)
            missing = [
                flag
                for flag in required
                if not re.search(rf"(?<!\S){re.escape(flag)}(?=\s|$)", evidence)
            ]
            if missing:
                raise RuntimeError(f"{tool} {token} is missing flags: {', '.join(missing)}")
    if config["ld"]:
        link_files = list(directory.rglob("link.txt"))
        link_text = "\n".join(path.read_text(errors="replace") for path in link_files)
        missing = [
            flag
            for flag in shlex.split(config["ld"])
            if not re.search(rf"(?<!\S){re.escape(flag)}(?=\s|$)", link_text)
        ]
        if missing:
            raise RuntimeError(f"{tool} link command is missing flags: {', '.join(missing)}")
    if variant in ("LTO", "OsLTO") and tool == "nextpnr":
        cache_path = directory / "CMakeCache.txt"
        cache = cache_path.read_text(errors="replace") if cache_path.is_file() else ""
        if "USE_IPO:BOOL=OFF" not in cache:
            raise RuntimeError("nextpnr LTO build did not configure USE_IPO=OFF")
        all_compile_flags = "\n".join(
            path.read_text(errors="replace")
            for path in directory.rglob("flags.make")
        )
        all_link_commands = "\n".join(
            path.read_text(errors="replace")
            for path in directory.rglob("link.txt")
        )
        if "-flto=thin" in all_compile_flags or "-flto=thin" in all_link_commands:
            raise RuntimeError("nextpnr LTO build must not contain -flto=thin")
        target_dir = (
            directory
            / "himbaechel/uarch/gowin/CMakeFiles/nextpnr-himbaechel-gowin.dir"
        )
        flags_path = target_dir / "flags.make"
        flags = flags_path.read_text(errors="replace") if flags_path.is_file() else ""
        if "-flto" not in flags or "-flto=thin" in flags:
            raise RuntimeError(
                f"nextpnr LTO compile flags must contain -flto and no -flto=thin: "
                f"{flags_path.relative_to(ROOT)}"
            )
        link_path = target_dir / "link.txt"
        link = link_path.read_text(errors="replace") if link_path.is_file() else ""
        if "-flto" not in link or "-flto=thin" in link:
            raise RuntimeError(
                f"nextpnr LTO link command must contain -flto and no -flto=thin: "
                f"{link_path.relative_to(ROOT)}"
            )
        objects = [*directory.rglob("*.obj"), *directory.rglob("*.o")]
        if not objects or any(
            path.read_bytes()[:4] != b"BC\xc0\xde" for path in objects
        ):
            raise RuntimeError(
                f"nextpnr LTO objects are not all LLVM bitcode: "
                f"found {len(objects)} .obj files"
            )
    return len(found_flags)


def absolute_path(path):
    return path if path.is_absolute() else ROOT / path


def build_environment(variant, tool, jobs):
    environment = os.environ.copy()
    for key in ENV_KEYS:
        environment.pop(key, None)
    config = VARIANTS[variant]
    environment["WASI_OPT_FLAGS"] = config["opt"]
    environment["WASI_EXTRA_CFLAGS"] = config["c"]
    environment["WASI_EXTRA_CXXFLAGS"] = config["cxx"]
    environment["WASI_EXTRA_LDFLAGS"] = config["ld"]
    environment["WASI_USE_IPO"] = config.get("use_ipo", "ON")
    build_directory, _ = tool_paths(variant, tool)
    environment["WASI_BUILD_DIR"] = build_directory.relative_to(ROOT).as_posix()
    environment["JOBS"] = str(jobs)
    return environment


def build_tool(variant, tool, jobs, sink):
    variant_directory = variant_root(variant)
    build_directory, artifact = tool_paths(variant, tool)
    log_path = variant_directory / f"{tool}-build.log"
    time_path = variant_directory / f"{tool}-time.txt"
    command = (
        "scripts/build-synth-wasm.sh"
        if tool == "yosys"
        else "scripts/build-pnr-wasm.sh"
    )
    with log_path.open("wb") as log:
        result = subprocess.run(
            ["/usr/bin/time", "-v", "-o", str(time_path), command],
            cwd=ROOT,
            env=build_environment(variant, tool, jobs),
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    report = time_path.read_text(errors="replace") if time_path.exists() else ""
    wall = parse_wall_seconds(report)
    peak_rss = parse_peak_rss_kib(report)
    status = "pass"
    details = (
        f"command={command}; JOBS={jobs}; "
        f"opt={VARIANTS[variant]['opt'] or 'CMAKE_BUILD_TYPE=Release default'}; "
        f"extra_c={VARIANTS[variant]['c']}; extra_cxx={VARIANTS[variant]['cxx']}; "
        f"extra_ld={VARIANTS[variant]['ld']}; "
        f"log={log_path.relative_to(ROOT)}"
    )
    wasm_bytes = ""
    compressed_bytes = ""
    digest = ""
    flags_count = ""
    if result.returncode != 0:
        status = "build-failed"
        details += f"; exit={result.returncode}"
    elif wall == "" or peak_rss == "":
        status = "invalid-build"
        details += "; /usr/bin/time -v did not report wall time or peak RSS"
    elif not artifact.is_file():
        status = "build-failed"
        details += f"; missing artifact={artifact.relative_to(ROOT)}"
    else:
        try:
            flags_count = check_build_flags(variant, tool, build_directory)
            wasm_bytes = artifact.stat().st_size
            compressed_bytes = zstd19_size(artifact)
            digest = sha256_file(artifact)
            details += f"; optimization flag entries={flags_count}"
            if variant == "LTO" and tool == "nextpnr":
                _, baseline_artifact = tool_paths("B", "nextpnr")
                baseline_digest = sha256_file(baseline_artifact)
                if digest == baseline_digest:
                    raise RuntimeError(
                        "nextpnr LTO WASM SHA-256 matches B despite full-LTO flags"
                    )
                details += (
                    f"; full-LTO SHA differs from B={baseline_digest}; "
                    f"sha256={digest}"
                )
        except (RuntimeError, OSError) as error:
            status = "invalid-build"
            details += f"; {error}"

    sink.write(
        run_id=f"build-{variant}-{tool}",
        phase="build",
        variant=variant,
        tool=tool,
        status=status,
        build_wall_s=f"{wall:.3f}" if wall != "" else "",
        build_peak_rss_kib=peak_rss,
        wasm_bytes=wasm_bytes,
        zstd19_bytes=compressed_bytes,
        wasm_sha256=digest,
        output_dir=variant_directory.relative_to(ROOT).as_posix(),
        details=details,
    )
    return {
        "status": status,
        "build_wall_s": wall,
        "build_peak_rss_kib": peak_rss,
        "wasm_bytes": wasm_bytes,
        "zstd19_bytes": compressed_bytes,
        "wasm_sha256": digest,
        "flags_count": flags_count,
        "artifact": artifact.relative_to(ROOT).as_posix(),
        "log": log_path.relative_to(ROOT).as_posix(),
    }


def build_variant(variant, jobs, sink, tools=("yosys", "nextpnr")):
    output = variant_root(variant)
    if output.is_symlink():
        raise SystemExit(f"Refusing symlink build output: {output.relative_to(ROOT)}")
    output.mkdir(parents=True, exist_ok=True)
    selected_tools = tools
    tool_metrics = {}
    for tool in selected_tools:
        directory, _ = tool_paths(variant, tool)
        if directory.exists() or directory.is_symlink():
            raise SystemExit(
                f"Refusing to overwrite tool build: {directory.relative_to(ROOT)}"
            )
        tool_metrics[tool] = build_tool(variant, tool, jobs, sink)
    passed = all(metrics["status"] == "pass" for metrics in tool_metrics.values())
    if passed and set(tool_metrics) == {"yosys", "nextpnr"}:
        metadata = {
            "format_version": 1,
            "variant": variant,
            "jobs": jobs,
            "tools": tool_metrics,
        }
        metadata_path = output / "s5-build-metrics.json"
        metadata_path.write_text(f"{json.dumps(metadata, indent=2, sort_keys=True)}\n")
    return passed


def check_variant_artifacts(variant):
    for tool in ("yosys", "nextpnr"):
        _, artifact = tool_paths(variant, tool)
        if artifact.is_symlink() or not artifact.is_file():
            raise SystemExit(
                f"Missing {tool} build for {variant}: {artifact.relative_to(ROOT)}"
            )
    if variant == "OsLTO":
        for tool in ("yosys", "nextpnr"):
            _, candidate = tool_paths("OsLTO", tool)
            candidate_digest = sha256_file(candidate)
            for comparison in ("B", "LTO", "Os"):
                _, reference = tool_paths(comparison, tool)
                if not reference.is_file():
                    raise SystemExit(
                        f"Missing {comparison} {tool} reference for OsLTO hash validation: "
                        f"{reference.relative_to(ROOT)}"
                    )
                if candidate_digest == sha256_file(reference):
                    raise SystemExit(
                        f"OsLTO {tool} SHA-256 must differ from {comparison}: "
                        f"{candidate.relative_to(ROOT)}"
                    )


def write_reused_build_rows(variant, sink):
    metadata_path = variant_root(variant) / "s5-build-metrics.json"
    if not metadata_path.is_file():
        raise SystemExit(
            f"Missing build metrics for reused {variant}: {metadata_path.relative_to(ROOT)}"
        )
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("variant") != variant:
        raise SystemExit(f"Build metrics variant does not match {variant}")
    for tool in ("yosys", "nextpnr"):
        metrics = metadata["tools"][tool]
        sink.write(
            run_id=f"build-{variant}-{tool}",
            phase="build",
            variant=variant,
            tool=tool,
            status=metrics["status"],
            build_wall_s=f"{metrics['build_wall_s']:.3f}",
            build_peak_rss_kib=metrics["build_peak_rss_kib"],
            wasm_bytes=metrics["wasm_bytes"],
            zstd19_bytes=metrics["zstd19_bytes"],
            wasm_sha256=metrics["wasm_sha256"],
            output_dir=variant_root(variant).relative_to(ROOT).as_posix(),
            details=(
                f"reused build; JOBS={metadata['jobs']}; "
                f"artifact={metrics['artifact']}; log={metrics['log']}"
            ),
        )
    return all(metadata["tools"][tool]["status"] == "pass" for tool in ("yosys", "nextpnr"))


def write_s5_reuse_rows(variants, sink):
    groups = {}
    with DEFAULT_CSV.open(newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source):
            if not row["note"].startswith("phase=build;"):
                continue
            groups.setdefault(row["run_id"], {})[row["metric"]] = row
    baseline_hashes = {}
    for tool in ("yosys", "nextpnr"):
        baseline_matches = [
            values
            for run_id, values in groups.items()
            if run_id.endswith(f"-{tool}")
            and values.get("status", {}).get("variant") == "B"
            and values.get("status", {}).get("value") == "pass"
            and values.get("wasm_sha256", {}).get("value")
        ]
        if not baseline_matches:
            raise SystemExit(f"S5 CSV lacks a passing B {tool} build hash")
        baseline_hashes[tool] = baseline_matches[-1]["wasm_sha256"]["value"]
    for variant in variants:
        for tool in ("yosys", "nextpnr"):
            matches = [
                (run_id, values)
                for run_id, values in groups.items()
                if run_id.endswith(f"-{tool}")
                and values.get("status", {}).get("value") == "pass"
                and values.get("status", {}).get("note", "").find(f"tool={tool}") >= 0
                and values["status"]["variant"] == variant
                and values.get("wasm_sha256", {}).get("value")
                != baseline_hashes[tool]
            ]
            if not matches:
                raise SystemExit(f"No successful S5 build record for {variant} {tool}")
            run_id, values = matches[-1]
            status_row = values["status"]
            output_match = re.search(r"(?:^|; )output_dir=([^;]+)", status_row["note"])
            if not output_match:
                raise SystemExit(f"S5 build record {run_id} has no output directory")
            output_directory = output_match.group(1)
            log_match = re.search(r"(?:^|; )log=([^;]+)", status_row["note"])
            artifact = (
                ROOT / output_directory / tool / "yosys.wasm"
                if tool == "yosys"
                else ROOT / output_directory / "nextpnr/nextpnr-himbaechel-gowin.wasm"
            )
            expected_digest = values.get("wasm_sha256", {}).get("value", "")
            if not artifact.is_file() or sha256_file(artifact) != expected_digest:
                raise SystemExit(
                    f"S5 artifact SHA-256 does not match CSV for {variant} {tool}: "
                    f"{artifact.relative_to(ROOT)}"
                )
            sink.write(
                run_id=f"s5-reuse-{variant}-{tool}",
                phase="build-reuse",
                variant=variant,
                tool=tool,
                status="pass",
                build_wall_s=values["build_wall_s"]["value"],
                build_peak_rss_kib=values["build_peak_rss_kib"]["value"],
                wasm_bytes=values["wasm_bytes"]["value"],
                zstd19_bytes=values["zstd19_bytes"]["value"],
                wasm_sha256=expected_digest,
                output_dir=output_directory,
                details=(
                    f"reused S5 artifact; source_run_id={run_id}; "
                    f"source_csv=docs/experiments/S5-wasi-build-options.csv; "
                    f"source_log={log_match.group(1) if log_match else 'unavailable'}"
                ),
            )


def write_tlto_nextpnr_reuse_row(sink):
    _, artifact = tool_paths("TLTO", "nextpnr")
    _, baseline_artifact = tool_paths("B", "nextpnr")
    digest = sha256_file(artifact)
    baseline_digest = sha256_file(baseline_artifact)
    if digest != baseline_digest:
        raise SystemExit("TLTO nextpnr must reuse the B artifact byte-for-byte")
    sink.write(
        run_id="build-TLTO-nextpnr-reuse-B",
        phase="build",
        variant="TLTO",
        tool="nextpnr",
        status="pass",
        wasm_bytes=artifact.stat().st_size,
        zstd19_bytes=zstd19_size(artifact),
        wasm_sha256=digest,
        output_dir=variant_root("B").relative_to(ROOT).as_posix(),
        details=(
            "reused B nextpnr artifact; "
            "効果なし（B は upstream の USE_IPO で ThinLTO 済み）"
        ),
    )


def record_default_identity(variants, build_statuses, sink):
    if not {"B", "B2"}.issubset(variants):
        return True
    passed = True
    for tool in ("yosys", "nextpnr"):
        if not build_statuses.get("B") or not build_statuses.get("B2"):
            passed = False
            sink.write(
                run_id=f"default-identity-{tool}",
                phase="default-identity",
                variant="B/B2",
                tool=tool,
                status="identity-unavailable",
                details="B or B2 build did not produce a complete successful build",
            )
            continue
        _, b_artifact = tool_paths("B", tool)
        _, b2_artifact = tool_paths("B2", tool)
        current = (
            ROOT / "build/wasi/yosys/yosys.wasm"
            if tool == "yosys"
            else ROOT / "build/wasi/nextpnr/nextpnr-himbaechel-gowin.wasm"
        )
        hashes = {
            "B": sha256_file(b_artifact),
            "B2": sha256_file(b2_artifact),
            "current": sha256_file(current),
        }
        matched = hashes["B"] == hashes["B2"]
        current_matches = hashes["B"] == hashes["current"]
        passed = passed and matched
        sink.write(
            run_id=f"default-identity-{tool}",
            phase="default-identity",
            variant="B/B2",
            tool=tool,
            status="pass" if matched else "identity-mismatch",
            wasm_sha256=hashes["B"],
            identity_vs_B=str(matched).lower(),
            details=(
                f"sha256 B={hashes['B']} B2={hashes['B2']} current={hashes['current']}; "
                f"B/B2 match={matched}; current matches B={current_matches}"
            ),
        )
    return passed


def prepare_output_directory(path, variants):
    if path.is_symlink() or path.exists():
        raise SystemExit(f"Refusing to overwrite output directory: {path}")
    for variant in variants:
        build = variant_root(variant)
        if path == build or path in build.parents or build in path.parents:
            raise SystemExit(
                f"Run output overlaps build output: {path.relative_to(ROOT)} and "
                f"{build.relative_to(ROOT)}"
            )
    path.mkdir(parents=True)


def mutate_copy(source, destination):
    shutil.copyfile(source, destination)
    with destination.open("r+b") as target:
        target.seek(0, os.SEEK_END)
        size = target.tell()
        if size == 0:
            raise RuntimeError(f"Cannot mutate empty comparator input: {source.name}")
        offset = size // 2
        target.seek(offset)
        original = target.read(1)
        target.seek(offset)
        target.write(bytes([original[0] ^ 1]))


def negative_control(run_directory, board, repeat, baseline, sink):
    directory = run_directory / "negative-control"
    directory.mkdir()
    digests = {}
    for name, key in (("netlist.json", "netlist_sha256"), ("top.fs", "fs_sha256")):
        mutated = directory / f"mutated-{name}"
        mutate_copy(run_directory / name, mutated)
        digest = sha256_file(mutated)
        digests[name] = digest
        if digest == baseline[key]:
            sink.write(
                run_id=f"negative-control-{board}",
                phase="negative-control",
                variant="B",
                board=board,
                repeat=repeat,
                tool="sha256-comparator",
                status="negative-control-missed",
                identity_vs_B="true",
                output_dir=directory.relative_to(ROOT).as_posix(),
                details=f"One-byte mutation of {name} was accepted",
            )
            return False
    sink.write(
        run_id=f"negative-control-{board}",
        phase="negative-control",
        variant="B",
        board=board,
        repeat=repeat,
        tool="sha256-comparator",
        status="pass",
        netlist_sha256=digests["netlist.json"],
        fs_sha256=digests["top.fs"],
        identity_vs_B="false",
        output_dir=directory.relative_to(ROOT).as_posix(),
        details="One-byte mutations of copied B netlist and .fs were rejected",
    )
    return True


def run_wasm_corruption_controls(variant, output_directory, sink):
    failures = False
    for tool in ("yosys", "nextpnr"):
        _, source = tool_paths(variant, tool)
        corrupted = output_directory / f"{tool}.corrupted.wasm"
        shutil.copyfile(source, corrupted)
        with corrupted.open("r+b") as target:
            original = target.read(1)
            if not original:
                raise RuntimeError(f"Cannot corrupt empty WASM artifact: {source}")
            target.seek(0)
            target.write(bytes([original[0] ^ 1]))
        corrupted_digest = sha256_file(corrupted)
        source_digest = sha256_file(source)
        command = [
            "node",
            "--input-type=module",
            "-e",
            (
                "import { readFile } from 'node:fs/promises'; "
                "const bytes = await readFile(process.argv[1]); "
                "try { await WebAssembly.compile(bytes); "
                "console.error('corrupt WASM accepted'); process.exitCode = 1; } "
                "catch (error) { console.log(`rejected: ${error.message}`); }"
            ),
            str(corrupted),
        ]
        result = subprocess.run(
            command,
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        log_path = output_directory / f"{tool}.corruption.log"
        log_path.write_text(
            f"$ {' '.join(command)}\n{result.stdout}\n{result.stderr}\n",
            encoding="utf-8",
        )
        passed = (
            corrupted_digest != source_digest
            and result.returncode == 0
            and result.stdout.startswith("rejected:")
        )
        if not passed:
            failures = True
        sink.write(
            run_id=f"corruption-{variant}-{tool}",
            phase="corruption-control",
            variant=variant,
            tool=tool,
            status="pass" if passed else "corruption-not-rejected",
            wasm_sha256=corrupted_digest,
            output_dir=output_directory.relative_to(ROOT).as_posix(),
            details=(
                f"original_sha256={source_digest}; corrupted_sha256={corrupted_digest}; "
                f"exit={result.returncode}; log={log_path.relative_to(ROOT)}"
            ),
        )
    return not failures


def run_node_trial(variant, board, repeat, run_directory, environment):
    command = [
        "node",
        "scripts/s5-wasi-runner.mjs",
        "--board",
        board,
        "--workdir",
        str(run_directory),
    ]
    started = time.perf_counter()
    result = subprocess.run(
        command,
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    runner_wall_s = time.perf_counter() - started
    log_path = run_directory.parent / f"repeat-{repeat:02d}.runner.log"
    if result.stdout or result.stderr:
        log_path.write_text(
            f"$ {' '.join(command)}\n{result.stdout}\n{result.stderr}",
            encoding="utf-8",
        )
    if result.returncode != 0:
        return None, f"runner exited {result.returncode}; log={log_path.relative_to(ROOT)}"
    line = next(
        (line.removeprefix("S5_NODE_METRIC ") for line in result.stdout.splitlines()
         if line.startswith("S5_NODE_METRIC ")),
        None,
    )
    if line is None:
        return None, f"runner emitted no metric; log={log_path.relative_to(ROOT)}"
    try:
        metric = json.loads(line)
    except json.JSONDecodeError as error:
        return None, f"invalid runner JSON: {error}; log={log_path.relative_to(ROOT)}"
    metric["runner_wall_s"] = runner_wall_s
    return metric, ""


def summarize_node_trials(rows):
    for variant in sorted({row["variant"] for row in rows}):
        for board in BOARDS:
            samples = [
                row for row in rows
                if row["variant"] == variant and row["board"] == board and row["status"] == "pass"
            ]
            if not samples:
                continue
            for key, label in (("synth_ms", "yosys"), ("pnr_ms", "nextpnr")):
                values = [float(row[key]) for row in samples]
                print(
                    f"S5_NODE_SUMMARY variant={variant} board={board} tool={label} "
                    f"median_ms={statistics.median(values):.3f} "
                    f"range_ms={min(values):.3f}..{max(values):.3f}",
                    flush=True,
                )
    aa_b = [row for row in rows if row["variant"] == "B" and row["status"] == "pass"]
    aa_b2 = [row for row in rows if row["variant"] == "B2" and row["status"] == "pass"]
    if aa_b and aa_b2:
        for board in BOARDS:
            b = [float(row["synth_ms"]) + float(row["pnr_ms"]) for row in aa_b if row["board"] == board]
            b2 = [float(row["synth_ms"]) + float(row["pnr_ms"]) for row in aa_b2 if row["board"] == board]
            if b and b2:
                b_median = statistics.median(b)
                b2_median = statistics.median(b2)
                print(
                    f"S5_AA_NOISE board={board} B_median_ms={b_median:.3f} "
                    f"B2_median_ms={b2_median:.3f} "
                    f"absolute_difference_ms={abs(b_median - b2_median):.3f}",
                    flush=True,
                )


def load_s5_node_baselines():
    grouped = {}
    with DEFAULT_CSV.open(newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source):
            if row["variant"] != "B" or not row["run_id"].startswith("node-B-"):
                continue
            parts = row["run_id"].split("-")
            if len(parts) != 4 or parts[2] not in BOARDS:
                continue
            grouped.setdefault(row["run_id"], {})[row["metric"]] = row["value"]
    baselines = {}
    for board in BOARDS:
        for run_id, values in grouped.items():
            parts = run_id.split("-")
            if parts[2] != board or parts[3] != "1":
                continue
            if values.get("status") != "pass":
                continue
            hashes = {
                key: values.get(key, "")
                for key in ("netlist_sha256", "pnr_sha256", "fs_sha256")
            }
            if all(hashes.values()):
                baselines[board] = hashes
                break
    if set(baselines) != set(BOARDS):
        raise SystemExit("S5 CSV lacks passing B Node hashes for all four boards")
    return baselines


def run_node_trials(
    variants, boards, repeats, output_directory, sink, unavailable=(), baseline=None
):
    baseline = baseline or {}
    metrics_rows = []
    failures = False
    for repeat in range(1, repeats + 1):
        order = variants[repeat - 1 :] + variants[: repeat - 1]
        for board in boards:
            for variant in order:
                if variant in unavailable:
                    failures = True
                    sink.write(
                        run_id=f"node-{variant}-{board}-{repeat}",
                        phase="node",
                        variant=variant,
                        board=board,
                        repeat=repeat,
                        tool="node:wasi",
                        status="build-failed",
                        details="The variant did not produce both WASI tools.",
                    )
                    continue
                run_directory = output_directory / variant / board / f"repeat-{repeat:02d}"
                if run_directory.exists() or run_directory.is_symlink():
                    raise SystemExit(
                        f"Refusing to overwrite run output: {run_directory.relative_to(ROOT)}"
                    )
                run_directory.parent.mkdir(parents=True, exist_ok=True)
                environment = os.environ.copy()
                environment["S5_WASI_ROOT"] = (
                    variant_root(variant).relative_to(ROOT).as_posix()
                )
                metric, error = run_node_trial(
                    variant, board, repeat, run_directory, environment
                )
                if metric is None:
                    failures = True
                    sink.write(
                        run_id=f"node-{variant}-{board}-{repeat}",
                        phase="node",
                        variant=variant,
                        board=board,
                        repeat=repeat,
                        tool="node:wasi",
                        status="failed",
                        output_dir=run_directory.relative_to(ROOT).as_posix(),
                        details=error,
                    )
                    print(
                        f"S5_NODE_FAIL variant={variant} board={board} repeat={repeat}: {error}",
                        flush=True,
                    )
                    continue

                reference = baseline.get(board)
                if reference is None and variant == "B":
                    baseline[board] = metric
                    reference = metric
                identity = bool(
                    reference
                    and all(
                        metric[key] == reference[key]
                        for key in ("netlist_sha256", "pnr_sha256", "fs_sha256")
                    )
                )
                status = "pass" if identity else "identity-mismatch"
                if not identity:
                    failures = True
                row = {
                    "run_id": f"node-{variant}-{board}-{repeat}",
                    "phase": "node",
                    "variant": variant,
                    "board": board,
                    "repeat": repeat,
                    "tool": "node:wasi",
                    "status": status,
                    "synth_ms": f"{float(metric['synth_ms']):.3f}",
                    "pnr_ms": f"{float(metric['nextpnr_ms']):.3f}",
                    "node_wall_s": f"{float(metric['runner_wall_s']):.3f}",
                    "yosys_memory_bytes": metric["yosys_memory_bytes"],
                    "nextpnr_memory_bytes": metric["nextpnr_memory_bytes"],
                    "netlist_sha256": metric["netlist_sha256"],
                    "pnr_sha256": metric["pnr_sha256"],
                    "fs_sha256": metric["fs_sha256"],
                    "fs_bytes": metric["fs_bytes"],
                    "identity_vs_B": str(identity).lower(),
                    "output_dir": run_directory.relative_to(ROOT).as_posix(),
                    "details": (
                        f"pack_ms={metric['pack_ms']:.3f}; "
                        f"runner_log={(run_directory.parent / f'repeat-{repeat:02d}.runner.log').relative_to(ROOT)}"
                    ),
                }
                sink.write(**row)
                metrics_rows.append(row)
                print(
                    f"S5_NODE_METRIC variant={variant} board={board} repeat={repeat} "
                    f"synth_ms={row['synth_ms']} pnr_ms={row['pnr_ms']} "
                    f"wall_s={row['node_wall_s']} "
                    f"memory={row['yosys_memory_bytes']}/{row['nextpnr_memory_bytes']} "
                    f"identity={row['identity_vs_B']}",
                    flush=True,
                )
                if variant == "B" and repeat == 1:
                    if not negative_control(run_directory, board, repeat, metric, sink):
                        failures = True
    summarize_node_trials(metrics_rows)
    return not failures


def run_chromium(variants, repeats, output_directory, port, sink):
    if "OsLTO" in variants:
        return run_interleaved_chromium(variants, repeats, output_directory, port, sink)
    if "B" not in variants or "B2" in variants or len(variants) > 3:
        raise SystemExit(
            "Chromium phase requires B plus up to two finalists; B2 is only the A/A control"
        )
    failures = False
    for variant in variants:
        check_variant_artifacts(variant)
        variant_output = output_directory / variant
        variant_output.mkdir()
        playwright_output = variant_output / "test-results"
        if playwright_output.exists():
            raise SystemExit(f"Refusing to overwrite Playwright output: {playwright_output}")
        environment = os.environ.copy()
        environment.update(
            {
                "S5_ASSET_DIR": variant_root(variant).relative_to(ROOT).as_posix(),
                "S5_CHROMIUM_VARIANT": variant,
                "S5_CHROMIUM_REPEATS": str(repeats),
                "S5_PLAYWRIGHT_OUTPUT_DIR": str(playwright_output),
                "PLAYWRIGHT_PORT": str(port),
            }
        )
        command = [
            "npx",
            "playwright",
            "test",
            "tests/e2e/s5-synthesis.spec.mjs",
        ]
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        output_lines = []
        metric_rows = []
        for line in process.stdout:
            print(line, end="", flush=True)
            output_lines.append(line)
            marker = "S5_BROWSER_METRIC "
            marker_index = line.find(marker)
            if marker_index >= 0:
                try:
                    metric_rows.append(json.loads(line[marker_index + len(marker) :]))
                except json.JSONDecodeError:
                    failures = True
        return_code = process.wait()
        log_path = variant_output / "playwright.log"
        log_path.write_text("".join(output_lines), encoding="utf-8")
        by_trial = {
            (metric["board"], int(metric["repeat"])): metric
            for metric in metric_rows
        }
        for board in BOARDS:
            for repeat in range(1, repeats + 1):
                metric = by_trial.get((board, repeat))
                status = "pass" if metric else "failed"
                if status != "pass":
                    failures = True
                sink.write(
                    run_id=f"chromium-{variant}-{board}-{repeat}",
                    phase="chromium",
                    variant=variant,
                    board=board,
                    repeat=repeat,
                    tool="chromium",
                    status=status,
                    synth_ms=f"{metric['synth_ms']:.3f}" if metric else "",
                    pnr_ms=f"{metric['pnr_ms']:.3f}" if metric else "",
                    fs_sha256=metric["fs_sha256"] if metric else "",
                    fs_bytes=metric["fs_size"] if metric else "",
                    identity_vs_B="true" if metric else "",
                    output_dir=variant_output.relative_to(ROOT).as_posix(),
                    details=(
                        f"Playwright exit={return_code}; log={log_path.relative_to(ROOT)}"
                        if status != "pass" or return_code != 0
                        else f"Playwright timing event; log={log_path.relative_to(ROOT)}"
                    ),
                )
        if return_code != 0:
            failures = True
        print(
            f"S5_CHROMIUM_SUMMARY variant={variant} trials={len(metric_rows)} "
            f"exit={return_code} log={log_path.relative_to(ROOT)}",
            flush=True,
        )
    return not failures


def run_interleaved_chromium(variants, repeats, output_directory, port, sink):
    order = ("B", "B2", "LTO", "Os", "OsLTO")
    if set(variants) != set(order):
        raise SystemExit("S5B Chromium requires B, B2, LTO, Os, and OsLTO")
    for variant in order:
        check_variant_artifacts(variant)

    asset_root = BUILD_ROOT / "asset-bundles"
    if asset_root.exists() or asset_root.is_symlink():
        raise SystemExit(f"Refusing to overwrite asset bundles: {asset_root.relative_to(ROOT)}")
    asset_root.mkdir(parents=True)
    failures = False
    for variant in order:
        raw_output = BUILD_ROOT / "asset-stage" / variant
        bundle_output = asset_root / variant
        if raw_output.exists() or raw_output.is_symlink():
            raise SystemExit(f"Refusing to overwrite asset stage: {raw_output.relative_to(ROOT)}")
        raw_output.parent.mkdir(parents=True, exist_ok=True)
        command = [
            "python3",
            "scripts/build-synth-assets.py",
            "--output",
            str(raw_output),
            "--dist-output",
            str(bundle_output),
        ]
        environment = os.environ.copy()
        environment["S5_ASSET_DIR"] = variant_root(variant).relative_to(ROOT).as_posix()
        log_path = output_directory / f"assets-{variant}.log"
        with log_path.open("w", encoding="utf-8") as log:
            log.write(f"$ {' '.join(command)}\n")
            result = subprocess.run(
                command,
                cwd=ROOT,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
                text=True,
            )
            log.write(f"\nexit={result.returncode}\n")
        if result.returncode != 0:
            failures = True
            sink.write(
                run_id=f"chromium-assets-{variant}",
                phase="chromium-assets",
                variant=variant,
                tool="build-synth-assets",
                status="failed",
                output_dir=raw_output.relative_to(ROOT).as_posix(),
                details=f"exit={result.returncode}; log={log_path.relative_to(ROOT)}",
            )
        else:
            sink.write(
                run_id=f"chromium-assets-{variant}",
                phase="chromium-assets",
                variant=variant,
                tool="build-synth-assets",
                status="pass",
                output_dir=bundle_output.relative_to(ROOT).as_posix(),
                details=f"log={log_path.relative_to(ROOT)}",
            )
    if failures:
        return False

    playwright_output = output_directory / "test-results"
    environment = os.environ.copy()
    environment.update(
        {
            "S5_ASSET_DIR": variant_root("B").relative_to(ROOT).as_posix(),
            "S5_WASI_ROOT": variant_root("B").relative_to(ROOT).as_posix(),
            "S5_ASSET_BUNDLE_ROOT": asset_root.relative_to(ROOT).as_posix(),
            "S5_CHROMIUM_VARIANTS": ",".join(order),
            "S5_CHROMIUM_REPEATS": str(repeats),
            "S5_PLAYWRIGHT_OUTPUT_DIR": str(playwright_output),
            "PLAYWRIGHT_PORT": str(port),
        }
    )
    command = [
        "npx",
        "playwright",
        "test",
        "tests/e2e/s5-synthesis.spec.mjs",
    ]
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    output_lines = []
    metric_rows = []
    for line in process.stdout:
        print(line, end="", flush=True)
        output_lines.append(line)
        marker = "S5_BROWSER_METRIC "
        marker_index = line.find(marker)
        if marker_index >= 0:
            try:
                metric_rows.append(json.loads(line[marker_index + len(marker) :]))
            except json.JSONDecodeError:
                failures = True
    return_code = process.wait()
    log_path = output_directory / "playwright.log"
    log_path.write_text("".join(output_lines), encoding="utf-8")
    metrics = {
        (int(metric["repeat"]), metric["board"], metric["variant"]): metric
        for metric in metric_rows
    }
    expected_keys = {
        (repeat, board, variant)
        for repeat in range(1, repeats + 1)
        for board in BOARDS
        for variant in order
    }
    if len(metrics) != len(metric_rows) or set(metrics) != expected_keys:
        failures = True
    baseline = {
        board: metrics[(1, board, "B")]["fs_sha256"]
        for board in BOARDS
        if (1, board, "B") in metrics
    }
    for repeat in range(1, repeats + 1):
        for board in BOARDS:
            for variant in order:
                metric = metrics.get((repeat, board, variant))
                identity = bool(
                    metric and baseline.get(board) == metric.get("fs_sha256")
                )
                status = (
                    "pass"
                    if metric and return_code == 0 and identity
                    else "identity-mismatch"
                    if metric and not identity
                    else "failed"
                )
                if status != "pass":
                    failures = True
                synth_ms = float(metric["synth_ms"]) if metric else None
                pnr_ms = float(metric["pnr_ms"]) if metric else None
                sink.write(
                    run_id=f"chromium-{variant}-{board}-{repeat}",
                    phase="chromium",
                    variant=variant,
                    board=board,
                    repeat=repeat,
                    tool="chromium",
                    status=status,
                    synth_ms=f"{synth_ms:.3f}" if synth_ms is not None else "",
                    pnr_ms=f"{pnr_ms:.3f}" if pnr_ms is not None else "",
                    total_ms=f"{synth_ms + pnr_ms:.3f}"
                    if synth_ms is not None and pnr_ms is not None
                    else "",
                    fs_sha256=metric["fs_sha256"] if metric else "",
                    fs_bytes=metric["fs_size"] if metric else "",
                    identity_vs_B=str(identity).lower() if metric else "",
                    output_dir=output_directory.relative_to(ROOT).as_posix(),
                    details=(
                        f"Playwright exit={return_code}; order=repeat,board,variant; "
                        f"log={log_path.relative_to(ROOT)}"
                    ),
                )
    print(
        f"S5B_CHROMIUM_SUMMARY order={','.join(order)} trials={len(metric_rows)} "
        f"exit={return_code} log={log_path.relative_to(ROOT)}",
        flush=True,
    )
    return not failures


def selected_variants(args):
    selected = args.variant or list(VARIANTS)
    return [variant for variant in VARIANTS if variant in selected]


def main():
    parser = argparse.ArgumentParser(
        description="Build and measure the pre-registered S5 WASI variants."
    )
    parser.add_argument(
        "--phase",
        choices=("build", "node", "matrix", "chromium", "corruption", "reuse-s5"),
        default="matrix",
    )
    parser.add_argument(
        "--variant",
        action="append",
        choices=tuple(VARIANTS),
        help="Select a variant; repeat the option to select more than one.",
    )
    parser.add_argument(
        "--board",
        action="append",
        choices=BOARDS,
        help="Select a Node WASI smoke board; default: all four boards.",
    )
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--jobs", type=int, default=10)
    parser.add_argument("--build-root", type=Path)
    parser.add_argument(
        "--tool",
        action="append",
        choices=("yosys", "nextpnr"),
        help="Select a tool for --phase build; repeat to select both.",
    )
    parser.add_argument("--output-csv", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--reuse-builds", action="store_true")
    parser.add_argument(
        "--append",
        action="store_true",
        help="Append rows to an existing S5 CSV after validating its header.",
    )
    parser.add_argument("--playwright-port", type=int, default=8123)
    args = parser.parse_args()

    if args.build_root:
        global BUILD_ROOT
        BUILD_ROOT = absolute_path(args.build_root)
    variants = selected_variants(args)
    boards = args.board or list(BOARDS)
    build_tools = args.tool or ["yosys", "nextpnr"]
    if args.repeats < 1 or args.jobs < 1:
        parser.error("--repeats and --jobs must be positive")
    if args.phase == "chromium" and args.board:
        parser.error("The Chromium phase always measures all four boards")
    if args.phase == "chromium":
        if not args.variant:
            parser.error("Select the S5B Chromium variants with --variant")
        if "OsLTO" in variants:
            if set(variants) != {"B", "B2", "LTO", "Os", "OsLTO"}:
                parser.error("S5B Chromium requires B, B2, LTO, Os, and OsLTO")
        elif "B" not in variants or "B2" in variants or len(variants) > 3:
            parser.error("Chromium phase requires B plus up to two finalists; B2 is A/A only")
        if not args.append:
            parser.error("Chromium phase appends to the existing Node matrix CSV; pass --append")
    if args.phase == "corruption" and variants != ["OsLTO"]:
        parser.error("The corruption control requires only --variant OsLTO")
    if args.phase == "reuse-s5":
        if not args.variant or not set(variants).issubset({"LTO", "Os"}):
            parser.error("S5 reuse requires explicit --variant LTO and/or --variant Os")
        if not args.append:
            parser.error("S5 reuse rows append to an existing CSV; pass --append")
    if args.tool and args.phase != "build":
        parser.error("--tool is only valid for --phase build")
    if args.append and args.phase not in (
        "build", "node", "chromium", "corruption", "reuse-s5"
    ):
        parser.error(
            "--append is only valid for build, node, chromium, corruption, or S5 reuse"
        )
    if args.phase == "build" and args.reuse_builds:
        parser.error("--reuse-builds is only valid for --phase matrix")
    if args.phase == "chromium" and args.repeats != 5:
        parser.error("The pre-registered Chromium phase requires five repeats")

    csv_path = absolute_path(args.output_csv or (
        BUILD_ROOT / "phase1-build.csv"
        if args.phase == "build"
        else DEFAULT_CSV
    ))
    output_directory = (
        absolute_path(args.output_dir)
        if args.output_dir
        else (
            BUILD_ROOT / "chromium-runs"
            if args.phase == "chromium"
            else BUILD_ROOT / "runs"
        )
    )

    preflight_csv(csv_path, args.append)
    if args.phase in ("node", "matrix", "chromium", "corruption"):
        if args.phase == "matrix":
            for variant in variants:
                directory = variant_root(variant)
                if directory.exists() and not args.reuse_builds:
                    raise SystemExit(
                        f"Build exists; use --reuse-builds or select a fresh output: "
                        f"{directory.relative_to(ROOT)}"
                    )
        for variant in variants:
            if args.phase in ("node", "chromium", "corruption") or (
                args.phase == "matrix" and args.reuse_builds and variant_root(variant).exists()
            ):
                check_variant_artifacts(variant)
        prepare_output_directory(output_directory, variants)
    elif args.phase == "build":
        for variant in variants:
            if variant_root(variant).is_symlink():
                raise SystemExit(
                    f"Refusing symlink build output: {variant_root(variant).relative_to(ROOT)}"
                )
            if not args.tool and variant_root(variant).exists():
                raise SystemExit(
                    f"Refusing to overwrite build output: "
                    f"{variant_root(variant).relative_to(ROOT)}"
                )
            for tool in build_tools:
                directory, _ = tool_paths(variant, tool)
                if directory.exists() or directory.is_symlink():
                    raise SystemExit(
                        f"Refusing to overwrite tool build: {directory.relative_to(ROOT)}"
                    )

    sink = ResultWriter(csv_path, append=args.append)

    ok = True
    try:
        build_statuses = {}
        if args.phase == "build":
            require_pinned_zstd_version(ROOT)
            for variant in variants:
                build_statuses[variant] = build_variant(
                    variant, args.jobs, sink, tools=build_tools
                )
                if not build_statuses[variant]:
                    ok = False
        if args.phase == "matrix":
            require_pinned_zstd_version(ROOT)
            for variant in variants:
                directory = variant_root(variant)
                if directory.exists():
                    build_statuses[variant] = write_reused_build_rows(variant, sink)
                    if not build_statuses[variant]:
                        ok = False
                    continue
                build_statuses[variant] = build_variant(variant, args.jobs, sink)
                if not build_statuses[variant]:
                    ok = False
            if not record_default_identity(variants, build_statuses, sink):
                ok = False
        if args.phase in ("node", "matrix"):
            require_pinned_zstd_version(ROOT)
            if args.phase == "node":
                for variant in variants:
                    check_variant_artifacts(variant)
            node_baseline = (
                load_s5_node_baselines()
                if args.phase == "node" and variants == ["OsLTO"]
                else None
            )
            if "B" not in variants and node_baseline is None:
                raise SystemExit("Node phase requires B for per-board output identity comparisons")
            if args.phase == "node" and "TLTO" in variants:
                write_tlto_nextpnr_reuse_row(sink)
            if not run_node_trials(
                variants,
                boards,
                args.repeats,
                output_directory,
                sink,
                unavailable=(
                    {variant for variant, passed in build_statuses.items() if not passed}
                    if args.phase == "matrix"
                    else ()
                ),
                baseline=node_baseline,
            ):
                ok = False
        if args.phase == "chromium":
            if not run_chromium(
                variants,
                args.repeats,
                output_directory,
                args.playwright_port,
                sink,
            ):
                ok = False
        if args.phase == "corruption":
            if not run_wasm_corruption_controls("OsLTO", output_directory, sink):
                ok = False
        if args.phase == "reuse-s5":
            write_s5_reuse_rows(variants, sink)
    finally:
        sink.close()
    if not ok:
        raise SystemExit("One or more S5 instrument or experiment rows failed.")


if __name__ == "__main__":
    main()
