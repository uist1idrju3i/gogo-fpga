#!/usr/bin/env python3
"""Read all upstream SBY status rows without timestamps or mutating evidence."""

from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys


def read_status(path):
    path = Path(path).resolve(strict=True)
    for suffix in ("-wal", "-shm"):
        if Path(str(path) + suffix).exists():
            raise ValueError("Unsettled SQLite journal")
    with closing(sqlite3.connect(path.as_uri() + "?immutable=1", uri=True)) as connection:
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("Corrupt SQLite status")
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Invalid SQLite foreign key")
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        if tables != ["task", "task_property", "task_property_status", "task_status", "task_trace"]:
            raise ValueError("Unknown SQLite status schema")
        result = {}
        for table in tables:
            columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
            if "created" not in columns:
                raise ValueError("Missing status creation time")
            selected = [name for name in columns if name != "created"]
            result[table] = {"columns": selected, "rows": [[row[columns.index(name)] for name in selected]
                for row in connection.execute(f'SELECT * FROM "{table}" ORDER BY id')]}
        return result


if __name__ == "__main__":
    print(json.dumps(read_status(sys.argv[1]), sort_keys=True))
