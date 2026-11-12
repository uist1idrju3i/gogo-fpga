#!/usr/bin/env python3

import argparse
import csv
from datetime import date, datetime, timedelta, timezone
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-script", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--start-date", required=True, type=date.fromisoformat)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    if args.repeats < 2:
        parser.error("at least two repetitions are required")
    executable = args.build_script.resolve(strict=True)
    helper = Path(__file__).resolve().parents[2] / "scripts/surfer-build-metadata.py"
    metadata = subprocess.check_output([
        "python3", str(helper), "--source", str(args.source), "--commit", args.commit,
    ], text=True).strip().split("\t")
    args.output.mkdir(parents=True, exist_ok=False)
    rows = []
    for repeat in range(1, args.repeats + 1):
        parent = args.output / f"parent-{repeat}"
        working = parent / "copy/libsurfer"
        working.mkdir(parents=True)
        day = args.start_date + timedelta(days=repeat - 1)
        stamp = int(datetime.combine(day, datetime.min.time(), timezone.utc).timestamp())
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("VERGEN_") and key != "SOURCE_DATE_EPOCH"}
        env.update({
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_AUTHOR_NAME": "Probe", "GIT_AUTHOR_EMAIL": "probe@example.invalid",
            "GIT_COMMITTER_NAME": "Probe", "GIT_COMMITTER_EMAIL": "probe@example.invalid",
            "GIT_AUTHOR_DATE": f"{day}T00:00:00Z", "GIT_COMMITTER_DATE": f"{day}T00:00:00Z",
        })
        for command in [["init", "--quiet"], ["commit", "--quiet", "--allow-empty", "-m", "parent"]]:
            subprocess.run(["git", "-C", str(parent), *command], env=env,
                           check=True, capture_output=True)
        env["SOURCE_DATE_EPOCH"] = str(stamp)
        for variant in ["before", "fixed"]:
            if variant == "fixed":
                env.update({"SOURCE_DATE_EPOCH": metadata[0],
                            "VERGEN_BUILD_DATE": metadata[1], "VERGEN_GIT_DESCRIBE": args.commit})
            result = subprocess.run([str(executable)], cwd=working, env=env,
                                    check=True, capture_output=True, text=True)
            (args.output / f"{variant}-{repeat}.log").write_text(result.stdout + result.stderr)
            for metric in ["VERGEN_GIT_DESCRIBE", "VERGEN_BUILD_DATE"]:
                prefix = f"cargo:rustc-env={metric}="
                values = [line.removeprefix(prefix) for line in result.stdout.splitlines()
                          if line.startswith(prefix)]
                if len(values) != 1 or not values[0]:
                    raise RuntimeError(f"Missing or ambiguous {metric}: {result.stdout}")
                if variant == "fixed":
                    expected = args.commit if metric == "VERGEN_GIT_DESCRIBE" else metadata[1]
                    if values[0] != expected:
                        raise RuntimeError(f"Metadata override was not applied: {values[0]}")
                rows.append(["S12C", variant, repeat, metric, values[0], "text", "true", str(day)])
                print(variant, repeat, metric, values[0])
    for metric in ["VERGEN_GIT_DESCRIBE", "VERGEN_BUILD_DATE"]:
        before = {row[4] for row in rows if row[1] == "before" and row[3] == metric}
        if len(before) != args.repeats:
            raise RuntimeError(f"Negative control did not vary {metric}")
    with (args.output / "results.csv").open("x", newline="") as output:
        writer = csv.writer(output)
        writer.writerow(["run_id", "variant", "repeat", "metric", "value", "unit", "valid", "note"])
        writer.writerows(rows)


if __name__ == "__main__":
    main()
