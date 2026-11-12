#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MATRIX_ROOT = ROOT / "build" / "s1b"
CSV_PATH = ROOT / "docs" / "experiments" / "S1b-option-matrix.csv"
VARIANTS = [
    "B", "O2", "O3", "Oz", "LTOL", "LTOA", "EHX", "MG", "M64",
    "DL", "MI", "CL", "EC", "TD2", "DE0", "ST1M", "P2P", "SIMD",
]
BOARDS = [
    ("tangnano1k", 0x0100681B),
    ("tangnano4k", 0x0100981B),
    ("tangnano9k", 0x1100481B),
    ("tangnano20k", 0x0000081B),
]
FIELDS = [
    "phase", "record_type", "candidate", "status", "repeat", "case", "elapsed_ms",
    "build_wall_s", "build_peak_rss_kib", "link_wall_s", "link_peak_rss_kib",
    "wasm_bytes", "wasm_gzip_bytes", "wasm_sha256", "mjs_bytes", "mjs_gzip_bytes",
    "mjs_sha256", "link_line", "details",
]
OPT_RE = re.compile(r"(?<!\S)-O(?:[0-3]|s|z)(?=\s|$)")
TEST_FILES = sorted((ROOT / "tests" / "sim").glob("*.test.mjs"))


def append_row(**values):
    with CSV_PATH.open("a", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS, lineterminator="\n")
        writer.writerow({field: values.get(field, "") for field in FIELDS})


def repo_paths(text):
    return text.replace(str(ROOT), "<repo>")


def run_command(command, env, timeout, log_path):
    with log_path.open("wb") as log:
        try:
            return subprocess.run(
                command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired:
            log.write(b"\nDriver timeout expired.\n")
            return None


def time_values(path):
    text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    wall = re.search(r"Elapsed \(wall clock\) time .*?: ([0-9:.]+)", text)
    rss = re.search(r"Maximum resident set size \(kbytes\): (\d+)", text)
    return (
        wall.group(1) if wall else "",
        rss.group(1) if rss else "",
    )


def check_optimization_lines(out):
    checks = []
    for path in sorted(out.rglob("flags.make")):
        for line_number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            match = re.match(r"^\s*(AM_)?(C_FLAGS|CXX_FLAGS)\s*=", line)
            if match:
                checks.append((path, line_number, line, 0 if match.group(1) else 1))
    link_file = out / "openFPGALoader-build/CMakeFiles/openFPGALoader.dir/link.txt"
    if link_file.exists():
        for line_number, line in enumerate(link_file.read_text(errors="replace").splitlines(), 1):
            checks.append((link_file, line_number, line, 1))
    libusb_makefile = out / "libusb-build/Makefile"
    if libusb_makefile.exists():
        for line_number, line in enumerate(libusb_makefile.read_text(errors="replace").splitlines(), 1):
            match = re.match(r"^\s*(AM_)?(C|CXX)FLAGS\s*=", line)
            if match:
                checks.append(
                    (libusb_makefile, line_number, line, 0 if match.group(1) else 1)
                )
    lines = []
    failures = []
    for path, line_number, line, expected_count in checks:
        count = len(OPT_RE.findall(line))
        rendered = (
            f"{path.relative_to(ROOT)}:{line_number}: {count} "
            f"(expected {expected_count}) {line.strip()}"
        )
        lines.append(rendered)
        if count != expected_count:
            failures.append(rendered)
    if not checks:
        failures.append("No compile/link flag lines were found.")
    (out / "optimization-lines.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return failures


def artifact_values(out):
    values = {}
    for suffix in ("wasm", "mjs"):
        path = out / f"openFPGALoader.{suffix}"
        data = path.read_bytes()
        values[f"{suffix}_bytes"] = len(data)
        values[f"{suffix}_gzip_bytes"] = len(
            subprocess.run(["gzip", "-n", "-c", str(path)], check=True, capture_output=True).stdout,
        )
        values[f"{suffix}_sha256"] = hashlib.sha256(data).hexdigest()
    return values


def gate(candidate, phase, run_number, matrix_root):
    env = os.environ.copy()
    env.update({
        "WASM_BUILD_ROOT": str(matrix_root.relative_to(ROOT)),
        "WASM_VARIANT": candidate,
        "WASM_VARIANTS": candidate,
    })
    log = matrix_root / candidate / f"{phase}-gate-{run_number}.log"
    command = [
        "node", "--test", *[str(path.relative_to(ROOT)) for path in TEST_FILES],
    ]
    completed = run_command(command, env, 300, log)
    passed = completed is not None and completed.returncode == 0
    details = f"timeout 300s; command: {' '.join(command)}"
    if not passed:
        details += f"; exit={completed.returncode if completed else 'timeout'}"
        details += f"; log={log.relative_to(ROOT)}"
    append_row(
        phase=phase, record_type="gate", candidate=candidate,
        status="pass" if passed else "fail", repeat=run_number, details=details,
    )
    print(f"{phase}: gate {candidate} run {run_number}: {'PASS' if passed else 'FAIL'}", flush=True)
    return passed


def positive_cases():
    cases = []
    for board, _idcode in BOARDS:
        fixture = f"build/fixtures/{board}.fs"
        cases.append((f"{board}-sram", board, ["-b", board, fixture]))
        cases.append((f"{board}-flash", board, ["-b", board, "-f", fixture]))
    return cases


def measure_program(candidate, board, args, matrix_root, phase, case, repeat):
    idcode = dict(BOARDS)[board]
    env = os.environ.copy()
    env["WASM_BUILD_ROOT"] = str(matrix_root.relative_to(ROOT))
    command = [
        "node", "tests/sim/run-program.mjs", candidate, f"{idcode:x}",
        json.dumps(args, separators=(",", ":")), "{}",
    ]
    try:
        result = subprocess.run(
            command, cwd=ROOT, env=env, capture_output=True, text=True,
            timeout=90, check=False,
        )
    except subprocess.TimeoutExpired:
        append_row(
            phase=phase, record_type="speed", candidate=candidate, status="timeout",
            repeat=repeat, case=case, details="90-second programming subprocess timeout",
        )
        return False
    match = re.search(r"__PROGRAM_RESULT__(\{[^\r\n]*\})", result.stderr)
    if result.returncode != 0 or not match:
        append_row(
            phase=phase, record_type="speed", candidate=candidate, status="fail",
            repeat=repeat, case=case,
            details=repo_paths(f"exit={result.returncode}; stderr={result.stderr[-2000:]}"),
        )
        return False
    data = json.loads(match.group(1))
    if data["exitCode"] != 0:
        append_row(
            phase=phase, record_type="speed", candidate=candidate, status="fail",
            repeat=repeat, case=case, elapsed_ms=f"{data['elapsedMs']:.3f}",
            details=repo_paths(
                f"loader exit={data['exitCode']}; output={result.stdout[-2000:]}"
            ),
        )
        return False
    append_row(
        phase=phase, record_type="speed", candidate=candidate, status="pass",
        repeat=repeat, case=case, elapsed_ms=f"{data['elapsedMs']:.3f}",
        details="module import/instantiate and callMain",
    )
    return True


def measure_instantiate(candidate, matrix_root, phase, repeat):
    env = os.environ.copy()
    env["WASM_BUILD_ROOT"] = str(matrix_root.relative_to(ROOT))
    command = ["node", "tests/sim/run-instantiate.mjs", candidate]
    try:
        result = subprocess.run(
            command, cwd=ROOT, env=env, capture_output=True, text=True,
            timeout=90, check=False,
        )
    except subprocess.TimeoutExpired:
        append_row(
            phase=phase, record_type="speed", candidate=candidate, status="timeout",
            repeat=repeat, case="instantiate",
            details="90-second instantiate subprocess timeout",
        )
        return False
    match = re.search(r"__INSTANTIATE_RESULT__(\{[^\r\n]*\})", result.stdout)
    if result.returncode != 0 or not match:
        append_row(
            phase=phase, record_type="speed", candidate=candidate, status="fail",
            repeat=repeat, case="instantiate",
            details=repo_paths(f"exit={result.returncode}; stderr={result.stderr[-2000:]}"),
        )
        return False
    data = json.loads(match.group(1))
    append_row(
        phase=phase, record_type="speed", candidate=candidate, status="pass",
        repeat=repeat, case="instantiate", elapsed_ms=f"{data['elapsedMs']:.3f}",
        details="module import and instantiate",
    )
    return True


def interleaved_speed(candidates, phase, matrix_root):
    failures = set()
    for repeat in range(1, 8):
        for case, board, args in positive_cases():
            for candidate in candidates:
                if candidate not in failures and not measure_program(
                    candidate, board, args, matrix_root, phase, case, repeat,
                ):
                    failures.add(candidate)
        for candidate in candidates:
            if candidate not in failures and not measure_instantiate(
                candidate, matrix_root, phase, repeat,
            ):
                failures.add(candidate)
        print(f"{phase}: completed interleaved repeat {repeat}/7", flush=True)
    return failures


def build_candidate(candidate, matrix_root, timing_root, phase="matrix"):
    out = matrix_root / candidate
    time_file = timing_root / f"{candidate}-build-time.txt"
    command_file = timing_root / f"{candidate}-command.txt"
    command = [
        "/usr/bin/time", "-v", "-o", str(time_file),
        str(ROOT / "scripts/build-wasm.sh"), f"--variant={candidate}",
    ]
    command_file.write_text(
        f'PATH="$(brew --prefix)/bin:$PATH" BUILD_ROOT=build/s1b JOBS=2 '
        f"/usr/bin/time -v -o build/s1b/timing/{candidate}-build-time.txt "
        f"./scripts/build-wasm.sh --variant={candidate}\n",
        encoding="utf-8",
    )
    prebuilt = out.exists()
    if prebuilt and not all((out / name).is_file() for name in ("openFPGALoader.mjs", "openFPGALoader.wasm")):
        append_row(
            phase=phase, record_type="build", candidate=candidate,
            status="incomplete-existing-output",
            details=f"Existing output is incomplete: {out.relative_to(ROOT)}",
        )
        return False
    if not prebuilt:
        env = os.environ.copy()
        env["BUILD_ROOT"] = str(matrix_root.relative_to(ROOT))
        env["JOBS"] = "2"
        brew = shutil.which("brew")
        if brew:
            prefix = subprocess.run(
                [brew, "--prefix"], cwd=ROOT, check=True, capture_output=True, text=True,
            ).stdout.strip()
            env["PATH"] = f"{prefix}/bin:{env.get('PATH', '')}"
        driver_log = timing_root / f"{candidate}-driver.log"
        completed = run_command(command, env, 7200, driver_log)
    else:
        completed = subprocess.CompletedProcess(command, 0)
    build_wall, build_rss = time_values(time_file)
    if completed is None or completed.returncode != 0:
        log_path = out / "build.log"
        text = log_path.read_text(errors="replace") if log_path.exists() else driver_log.read_text(errors="replace")
        details = repo_paths(
            f"command: {command_file.relative_to(ROOT)}; {text[-3000:]}"
        )
        append_row(
            phase=phase, record_type="build", candidate=candidate,
            status="fail", build_wall_s=build_wall, build_peak_rss_kib=build_rss,
            details=details,
        )
        print(f"{phase}: build {candidate}: FAIL", flush=True)
        return False
    failures = check_optimization_lines(out)
    if failures:
        append_row(
            phase=phase, record_type="build", candidate=candidate,
            status="invalid-opt-lines", build_wall_s=build_wall,
            build_peak_rss_kib=build_rss,
            details=repo_paths("; ".join(failures)),
        )
        print(f"{phase}: build {candidate}: invalid -O lines", flush=True)
        return False
    link_wall, link_rss = time_values(out / "openFPGALoader-build/link-time.txt")
    values = artifact_values(out)
    link_file = out / "openFPGALoader-build/CMakeFiles/openFPGALoader.dir/link.txt"
    link_line = link_file.read_text(errors="replace").strip().replace(str(ROOT), "<repo>")
    append_row(
        phase=phase, record_type="build", candidate=candidate, status="pass",
        build_wall_s=build_wall, build_peak_rss_kib=build_rss,
        link_wall_s=link_wall, link_peak_rss_kib=link_rss, **values,
        link_line=link_line,
        details=f"command: {command_file.relative_to(ROOT)}; exact link: "
                f"{link_file.relative_to(ROOT)}",
    )
    print(
        f"{phase}: build {candidate}: PASS; wall={build_wall}s RSS={build_rss} KiB "
        f"wasm-gzip={values['wasm_gzip_bytes']}",
        flush=True,
    )
    return True


def open_new_matrix():
    free = shutil.disk_usage(ROOT).free
    print(f"free disk before matrix: {free} bytes", flush=True)
    if free < 10 * 1024**3:
        raise SystemExit("Less than 10 GiB free; refusing to start the matrix.")
    if CSV_PATH.exists():
        raise SystemExit(f"Experiment CSV already exists: {CSV_PATH.relative_to(ROOT)}")
    if MATRIX_ROOT.exists():
        if not (
            (MATRIX_ROOT / "B/openFPGALoader.mjs").is_file()
            and (MATRIX_ROOT / "B/openFPGALoader.wasm").is_file()
            and (MATRIX_ROOT / "timing").is_dir()
        ):
            raise SystemExit(f"Matrix output already exists: {MATRIX_ROOT.relative_to(ROOT)}")
        timing_root = MATRIX_ROOT / "timing"
    else:
        MATRIX_ROOT.mkdir(parents=True)
        timing_root = MATRIX_ROOT / "timing"
        timing_root.mkdir()
    CSV_PATH.write_text(",".join(FIELDS) + "\n", encoding="utf-8")
    preflight = MATRIX_ROOT / "preflight-B-duplicate-O3"
    if preflight.exists():
        build_wall, build_rss = time_values(timing_root / "preflight-B-build-time.txt")
        link_wall, link_rss = time_values(
            preflight / "openFPGALoader-build/link-time.txt",
        )
        values = artifact_values(preflight)
        link_file = (
            preflight / "openFPGALoader-build/CMakeFiles/openFPGALoader.dir/link.txt"
        )
        link_line = link_file.read_text(errors="replace").strip().replace(str(ROOT), "<repo>")
        failure_lines = (preflight / "optimization-lines.txt").read_text(errors="replace")
        append_row(
            phase="preflight", record_type="build", candidate="B",
            status="invalid-opt-lines", build_wall_s=build_wall,
            build_peak_rss_kib=build_rss, link_wall_s=link_wall,
            link_peak_rss_kib=link_rss, **values, link_line=link_line,
            details=repo_paths(
                "Preflight rejected: upstream ENABLE_OPTIM=ON injected -O3, "
                "producing two optimization levels; disabled for matrix build. "
                f"Flag evidence: {failure_lines.strip()}"
            ),
        )
    return timing_root


def run_matrix():
    timing_root = open_new_matrix()
    built = []
    for candidate in VARIANTS:
        if not build_candidate(candidate, MATRIX_ROOT, timing_root):
            continue
        passed = True
        for run_number in range(1, 6):
            if not gate(candidate, "matrix", run_number, MATRIX_ROOT):
                passed = False
                break
        if passed:
            built.append(candidate)
    (MATRIX_ROOT / "gate-passers.txt").write_text("\n".join(built) + "\n", encoding="utf-8")
    if not built:
        raise SystemExit("No candidate passed the five-run stability gate.")
    failures = interleaved_speed(built, "matrix", MATRIX_ROOT)
    (MATRIX_ROOT / "speed-failures.txt").write_text(
        "\n".join(sorted(failures)) + ("\n" if failures else ""), encoding="utf-8",
    )
    print(f"matrix complete; gate passers: {', '.join(built)}", flush=True)


def run_compare(c_profile):
    if not CSV_PATH.exists():
        raise SystemExit(f"Missing matrix CSV: {CSV_PATH.relative_to(ROOT)}")
    c_out = MATRIX_ROOT / c_profile
    if not all(
        (c_out / name).is_file()
        for name in ("openFPGALoader.mjs", "openFPGALoader.wasm")
    ):
        if not build_candidate(
            c_profile, MATRIX_ROOT, MATRIX_ROOT / "timing", phase="compare",
        ):
            print(f"compare: {c_profile} build failed; comparison skipped.", flush=True)
            return
    candidates = ["B", c_profile]
    for candidate in candidates:
        out = MATRIX_ROOT / candidate
        if not (out / "openFPGALoader.mjs").exists():
            raise SystemExit(f"Missing built candidate {candidate}: {out.relative_to(ROOT)}")
    all_passed = True
    for candidate in candidates:
        passed = True
        for run_number in range(1, 6):
            if not gate(candidate, "compare", run_number, MATRIX_ROOT):
                passed = False
                all_passed = False
                break
        if not passed:
            print(f"compare: {candidate} failed stability gate", flush=True)
    if all_passed:
        failures = interleaved_speed(candidates, "compare", MATRIX_ROOT)
        (MATRIX_ROOT / "compare-speed-failures.txt").write_text(
            "\n".join(sorted(failures)) + ("\n" if failures else ""), encoding="utf-8",
        )
    else:
        print("compare speed protocol skipped because a stability gate failed.", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("matrix", "compare"), default="matrix")
    parser.add_argument("--c-profile", help="Composite --variant profile for the C comparison.")
    args = parser.parse_args()
    if args.phase == "matrix":
        if args.c_profile:
            parser.error("--c-profile is only valid with --phase=compare")
        run_matrix()
    else:
        if not args.c_profile:
            parser.error("--c-profile is required with --phase=compare")
        run_compare(args.c_profile)


if __name__ == "__main__":
    main()
