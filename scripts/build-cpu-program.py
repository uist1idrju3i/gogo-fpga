#!/usr/bin/env python3
"""Assemble the RV32I CPU fixture with upstream LLVM tools, retaining evidence."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assembler", required=True)
    parser.add_argument("--linker", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=False)
    source = ROOT / "tests/fixtures/cpus/program.S"
    metadata = {"status": "failed", "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "tools": {}}
    commands = [
        [args.assembler, "--triple=riscv32", "--mattr=+i,-relax", "--filetype=obj", str(source), "-o", str(output / "program.o")],
        [args.linker, "-m", "elf32lriscv", "--image-base=0", "-Ttext=0", "--entry=_start", "--no-relax", "--oformat=binary", str(output / "program.o"), "-o", str(output / "program.bin")],
    ]
    metadata["commands"] = commands
    try:
        for name, executable in (("assembler", args.assembler), ("linker", args.linker)):
            metadata["tools"][name] = subprocess.check_output([executable, "--version"], text=True).strip()
        for index, command in enumerate(commands):
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            (output / f"stage-{index}.stdout").write_text(result.stdout)
            (output / f"stage-{index}.stderr").write_text(result.stderr)
            result.check_returncode()
        binary = (output / "program.bin").read_bytes()
        if len(binary) != 72:
            raise ValueError("Expected exactly 18 RV32I instructions")
        text = "".join(f"{int.from_bytes(binary[offset:offset + 4], 'little'):08x}\n" for offset in range(0, len(binary), 4))
        (output / "program.hex").write_text(text, encoding="ascii")
        metadata["binary_sha256"] = hashlib.sha256(binary).hexdigest()
        metadata["hex_sha256"] = hashlib.sha256(text.encode("ascii")).hexdigest()
        metadata["status"] = "passed"
    finally:
        (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
