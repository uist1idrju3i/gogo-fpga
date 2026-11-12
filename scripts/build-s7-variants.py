#!/usr/bin/env python3
"""Build and validate the frozen S7 openFPGALoader profiles."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
S7_ROOT = ROOT / "build/s7"
BUILD_ROOT = S7_ROOT / "build-roots"
LOG_ROOT = S7_ROOT / "build-logs"
MANIFEST = S7_ROOT / "variants.json"
CSV_PATH = S7_ROOT / "build-smoke.csv"
OPT_RE = re.compile(r"(?<!\S)-O(?:[0-3]|s|z)(?=\s|$)")
VARIANTS = (
    ("B", "B", "Os", False),
    ("B2", "B", "Os", False),
    ("B+O3", "B+O3", "O3", False),
    ("B+O3+LTOA", "B+O3+LTOA", "O3", True),
    ("B+LTOA", "B+LTOA", "Os", True),
)


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def time_values(path: Path) -> tuple[float | None, int | None]:
    text = path.read_text(encoding="utf-8", errors="replace")
    wall_match = re.search(
        r"Elapsed \(wall clock\) time .*?: ([0-9:.]+)", text
    )
    rss_match = re.search(r"Maximum resident set size \(kbytes\): (\d+)", text)
    wall = None
    if wall_match:
        parts = [float(value) for value in wall_match.group(1).split(":")]
        if len(parts) == 3:
            wall = parts[0] * 3600 + parts[1] * 60 + parts[2]
        elif len(parts) == 2:
            wall = parts[0] * 60 + parts[1]
        else:
            wall = parts[0]
    return wall, int(rss_match.group(1)) if rss_match else None


def flag_lines(output: Path) -> list[tuple[Path, int, str, int]]:
    checks: list[tuple[Path, int, str, int]] = []
    for path in sorted(output.rglob("flags.make")):
        for number, line in enumerate(
            path.read_text(encoding="utf-8", errors="replace").splitlines(), 1
        ):
            match = re.match(r"^\s*(AM_)?(C_FLAGS|CXX_FLAGS)\s*=", line)
            if match:
                checks.append((path, number, line, 0 if match.group(1) else 1))

    link_file = output / "openFPGALoader-build/CMakeFiles/openFPGALoader.dir/link.txt"
    if link_file.is_file():
        for number, line in enumerate(
            link_file.read_text(encoding="utf-8", errors="replace").splitlines(), 1
        ):
            checks.append((link_file, number, line, 1))

    libusb_makefile = output / "libusb-build/Makefile"
    if libusb_makefile.is_file():
        for number, line in enumerate(
            libusb_makefile.read_text(encoding="utf-8", errors="replace").splitlines(), 1
        ):
            match = re.match(r"^\s*(AM_)?(C|CXX)FLAGS\s*=", line)
            if match:
                checks.append(
                    (libusb_makefile, number, line, 0 if match.group(1) else 1)
                )
    return checks


def check_flags(output: Path, opt: str, lto_all: bool) -> list[str]:
    checks = flag_lines(output)
    failures = []
    rendered = []
    for path, number, line, expected_count in checks:
        matches = OPT_RE.findall(line)
        expected = [f"-{opt}"] if expected_count else []
        if len(matches) != expected_count or (matches and matches != expected):
            failures.append(
                f"{relative(path)}:{number}: -O flags {matches!r}, expected {expected!r}"
            )
        rendered.append(
            f"{relative(path)}:{number}: -O flags {matches!r}; {line.strip()}"
        )
    if not checks:
        failures.append("No flags.make or link.txt optimization lines were found.")

    loader_flags = output / "openFPGALoader-build/CMakeFiles/openFPGALoader.dir/flags.make"
    link_file = output / "openFPGALoader-build/CMakeFiles/openFPGALoader.dir/link.txt"
    loader_text = loader_flags.read_text(encoding="utf-8", errors="replace") if loader_flags.exists() else ""
    link_text = link_file.read_text(encoding="utf-8", errors="replace") if link_file.exists() else ""
    dependency_text = "\n".join(
        line
        for path, _, line, _ in checks
        if path != loader_flags and path != link_file
    )
    lto_sites = {
        "loader compile": "-flto" in loader_text,
        "link": "-flto" in link_text,
    }
    if lto_all:
        lto_sites["dependency compile"] = "-flto" in dependency_text
        if not all(lto_sites.values()):
            failures.append(f"Missing expected -flto evidence: {lto_sites}")
    elif "-flto" in "\n".join(line for _, _, line, _ in checks):
        failures.append("Unexpected -flto in flags.make, libusb Makefile, or link.txt.")
    if not lto_all and any(lto_sites.values()):
        failures.append(f"Unexpected -flto evidence: {lto_sites}")

    (output / "s7-optimization-lines.txt").write_text(
        "\n".join(rendered + [f"LTO evidence: {lto_sites}"]) + "\n",
        encoding="utf-8",
    )
    return failures


def build_variant(label: str, profile: str, opt: str, lto_all: bool) -> dict:
    build_root = BUILD_ROOT / label
    output = build_root / profile
    time_log = LOG_ROOT / f"{label}.time.log"
    driver_log = LOG_ROOT / f"{label}.build.log"
    for path in (output, time_log, driver_log):
        if path.exists():
            raise RuntimeError(f"Refusing to overwrite existing S7 output: {relative(path)}")
    build_root.mkdir(parents=True, exist_ok=True)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)

    command = [
        "/usr/bin/time",
        "-v",
        "-o",
        str(time_log),
        str(ROOT / "scripts/build-wasm.sh"),
        "--async=jspi",
        f"--variant={profile}",
    ]
    environment = os.environ.copy()
    environment["BUILD_ROOT"] = relative(build_root)
    environment["JOBS"] = os.environ.get("S7_JOBS", "2")
    with driver_log.open("w", encoding="utf-8") as log:
        result = subprocess.run(
            command,
            cwd=ROOT,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )

    wall, peak_rss = time_values(time_log)
    record = {
        "variant": label,
        "profile": profile,
        "status": "pass" if result.returncode == 0 else "fail",
        "build_wall_s": wall,
        "build_peak_rss_kib": peak_rss,
        "artifact_dir": relative(output),
        "driver_log": relative(driver_log),
        "time_log": relative(time_log),
        "wasm_sha256": "",
        "mjs_sha256": "",
        "flag_status": "not-checked",
        "details": "",
    }
    if result.returncode != 0:
        record["details"] = f"build-wasm.sh exit status {result.returncode}"
        return record

    for suffix in ("wasm", "mjs"):
        artifact = output / f"openFPGALoader.{suffix}"
        if not artifact.is_file():
            record["status"] = "fail"
            record["details"] = f"Missing artifact: {relative(artifact)}"
            return record
        record[f"{suffix}_sha256"] = sha256(artifact)

    failures = check_flags(output, opt, lto_all)
    record["flag_status"] = "pass" if not failures else "fail"
    record["details"] = "; ".join(failures)
    if failures:
        record["status"] = "fail"
    return record


def main() -> int:
    if not Path("/usr/bin/time").is_file():
        raise RuntimeError("GNU time is required at /usr/bin/time.")
    if MANIFEST.exists() or CSV_PATH.exists():
        raise RuntimeError("Refusing to overwrite build/s7/variants.json or build-smoke.csv.")
    S7_ROOT.mkdir(parents=True, exist_ok=True)

    records = []
    manifest_variants = []
    for label, profile, opt, lto_all in VARIANTS:
        record = build_variant(label, profile, opt, lto_all)
        records.append(record)
        print(
            f"{label}: {record['status']}; "
            f"wall={record['build_wall_s']}s; peak RSS={record['build_peak_rss_kib']} KiB; "
            f"flags={record['flag_status']}",
            flush=True,
        )
        if record["status"] == "pass":
            manifest_variants.append(
                {
                    "name": label,
                    "profile": profile,
                    "artifact_dir": record["artifact_dir"],
                }
            )

    with CSV_PATH.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=["phase", *records[0]])
        writer.writeheader()
        writer.writerows({"phase": "smoke", **record} for record in records)
    MANIFEST.write_text(
        json.dumps({"phase": "smoke", "variants": manifest_variants}, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0 if len(manifest_variants) == len(VARIANTS) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"S7 build harness: {error}", file=sys.stderr)
        raise SystemExit(1) from error
