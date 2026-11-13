#!/usr/bin/env python3
import argparse
import csv
from datetime import datetime
import json
from pathlib import Path
import subprocess


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def seconds(start, end):
    duration = (datetime.fromisoformat(end.replace("Z", "+00:00")) -
                datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds()
    if duration < 0:
        raise ValueError("Negative API duration")
    return int(duration)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="uist1idrju3i/gogo-fpga")
    parser.add_argument("--run", action="append", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output already exists")
    rows = []
    for run_id in args.run:
        prefix = f"repos/{args.repo}/actions/runs/{run_id}"
        run = api(prefix)
        if run["conclusion"] != "success" or run["path"] != ".github/workflows/build.yml":
            raise ValueError("Expected a successful build.yml run")
        jobs = []
        page = 1
        while True:
            batch = api(f"{prefix}/attempts/{run['run_attempt']}/jobs?per_page=100&page={page}")["jobs"]
            jobs.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        active_start = min(job["started_at"] for job in jobs if job["started_at"])
        active_end = max(job["completed_at"] for job in jobs if job["completed_at"])
        print(f"Run {run_id} {run['event']} {run['head_sha']} "
              f"queued_wall={seconds(run['created_at'], run['updated_at'])}s "
              f"active_wall={seconds(active_start, active_end)}s")
        for job in jobs:
            def row(kind, name, start, end, conclusion):
                elapsed = seconds(start, end) if start and end else ""
                return [run_id, run["run_attempt"], run["head_sha"], run["event"], job["id"],
                        job["name"], kind, name, start, end, elapsed, conclusion]
            rows.append(row("job", job["name"], job["started_at"], job["completed_at"], job["conclusion"]))
            major = []
            for step in job["steps"]:
                rows.append(row("step", step["name"], step.get("started_at"),
                                step.get("completed_at"), step["conclusion"]))
                if step.get("started_at") and step.get("completed_at"):
                    major.append((seconds(step["started_at"], step["completed_at"]), step["name"]))
            print(job["name"], rows[-len(job['steps'])-1][10], sorted(major, reverse=True)[:3])
    with args.output.open("x", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(["run_id", "attempt", "sha", "event", "job_id", "job", "kind", "step",
                         "started_at", "completed_at", "seconds", "conclusion"])
        writer.writerows(rows)


if __name__ == "__main__":
    main()
