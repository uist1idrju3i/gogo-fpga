#!/usr/bin/env python3
"""Re-audit fixed CLI repetitions and reconstruct the published raw CSVs."""

import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import statistics

SPEC = importlib.util.spec_from_file_location("cli_audit", Path(__file__).with_name("audit-extra-solver-cli.py"))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


def summarize(prefix, output, check=False, evidence_root=None, git_repo=AUDIT.ROOT):
    baseline = None
    commit = None
    reports = {}
    for series, count in (("aa", 2), ("formal", 5)):
        buffer = io.StringIO(newline="")
        writer = csv.DictWriter(buffer, fieldnames=("run", *AUDIT.COLUMNS), lineterminator="\n")
        writer.writeheader()
        durations = {}
        for repetition in range(1, count + 1):
            directory = Path(f"{prefix}-{series}-{repetition}")
            report = AUDIT.audit(directory, evidence_root=evidence_root, git_repo=git_repo)
            AUDIT.require(report == {"status": "pass", "phase": "formal-probe", "rows": 29, "columns": 14}, "Not formal CLI evidence")
            setup = json.loads((directory / "setup.json").read_bytes())
            commit = commit or setup["commit"]
            AUDIT.require(setup["commit"] == commit and all(item["base_commit"] == commit for item in setup["builds"]), "Mixed harness/build commits")
            rows = list(csv.DictReader(io.StringIO((directory / "results.csv").read_text())))
            stable = [{key: value for key, value in row.items() if key not in ("elapsed_ms", "write_error")} for row in rows]
            baseline = baseline or stable
            AUDIT.require(stable == baseline, "Repetition bytes/status/provenance differ")
            for row in rows:
                writer.writerow({"run": f"{series}-{repetition}", **row})
                durations.setdefault(f"{row['runtime']}/{row['case']}", []).append(float(row["elapsed_ms"]))
        payload = buffer.getvalue().encode()
        destination = Path(output) / f"S15-bitwuzla-cli-{series}.csv"
        if check:
            AUDIT.require(destination.read_bytes() == payload, f"Published CSV differs: {destination}")
        else:
            destination.write_bytes(payload)
        reports[series] = {"rows": count * 29, "columns": 15, "csv_sha256": AUDIT.sha(payload),
                           "elapsed_ms": {key: {"min": min(values), "median": statistics.median(values), "max": max(values)} for key, values in durations.items()}}
    return {"status": "pass", "commit": commit, "series": reports}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--evidence-root", type=Path)
    parser.add_argument("--git-repo", type=Path, default=AUDIT.ROOT)
    args = parser.parse_args()
    print(json.dumps(summarize(args.prefix, args.out, args.check, args.evidence_root, args.git_repo), sort_keys=True))
