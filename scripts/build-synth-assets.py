#!/usr/bin/env python3

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path
from pathlib import PurePosixPath

from zstd_cli import require_pinned_zstd_version


ROOT = Path(__file__).resolve().parents[1]
CHIPDB_FAMILIES = ("GW1N-9C", "GW1NS-4", "GW1NZ-1", "GW2A-18C")


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_file(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
        raise SystemExit(f"Required synthesis asset is missing or empty: {path}")


def compress_file(source, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as compressed:
        result = subprocess.run(
            ["zstd", "-19", "-q", "--no-progress", "-c", str(source)],
            check=False,
            stdout=compressed,
            stderr=subprocess.PIPE,
            text=True,
        )
    if result.returncode != 0:
        output.unlink(missing_ok=True)
        detail = result.stderr.strip()
        raise SystemExit(f"Could not compress synthesis asset {source}: {detail}")


def create_share_tar(output, yosys_share):
    if yosys_share.is_symlink() or not yosys_share.is_dir():
        raise SystemExit(f"Yosys share directory is missing: {yosys_share}")

    entries = sorted(
        yosys_share.rglob("*"),
        key=lambda path: path.relative_to(yosys_share).as_posix(),
    )
    if not entries:
        raise SystemExit(f"Yosys share directory is empty: {yosys_share}")

    with tarfile.open(output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for path in entries:
            if path.is_symlink():
                raise SystemExit(f"Symbolic links are not supported in Yosys share data: {path}")
            if not path.is_dir() and not path.is_file():
                raise SystemExit(f"Unsupported Yosys share entry: {path}")
            name = path.relative_to(yosys_share).as_posix()
            info = tarfile.TarInfo(name + ("/" if path.is_dir() else ""))
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            info.mode = 0o755 if path.is_dir() else 0o644
            if path.is_dir():
                info.type = tarfile.DIRTYPE
                info.size = 0
                archive.addfile(info)
            else:
                info.type = tarfile.REGTYPE
                info.size = path.stat().st_size
                with path.open("rb") as source:
                    archive.addfile(info, source)


def create_libraries_tar(output, libraries_archive):
    if libraries_archive.is_symlink() or not libraries_archive.is_file():
        raise SystemExit(f"GHDL library archive is missing: {libraries_archive}")

    try:
        with tarfile.open(libraries_archive, mode="r:gz") as source_archive:
            members = []
            for source_info in source_archive.getmembers():
                name = PurePosixPath(source_info.name)
                if source_info.name in ("", ".", "./"):
                    continue
                if name.is_absolute() or ".." in name.parts:
                    raise SystemExit(
                        f"Unsafe GHDL library archive path: {source_info.name}"
                    )
                if source_info.isdir():
                    kind = "directory"
                elif source_info.isfile():
                    kind = "file"
                else:
                    raise SystemExit(
                        f"Unsupported GHDL library archive entry: {source_info.name}"
                    )
                members.append((name.as_posix(), kind, source_info))
            if not members:
                raise SystemExit(f"GHDL library archive is empty: {libraries_archive}")

            with tarfile.open(output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                for name, kind, source_info in sorted(members):
                    info = tarfile.TarInfo(name + ("/" if kind == "directory" else ""))
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    info.mtime = 0
                    info.mode = 0o755 if kind == "directory" else 0o644
                    if kind == "directory":
                        info.type = tarfile.DIRTYPE
                        info.size = 0
                        archive.addfile(info)
                    else:
                        content = source_archive.extractfile(source_info)
                        if content is None:
                            raise SystemExit(
                                f"Could not read GHDL library archive entry: {name}"
                            )
                        info.type = tarfile.REGTYPE
                        info.size = source_info.size
                        archive.addfile(info, content)
    except (OSError, tarfile.TarError) as error:
        raise SystemExit(
            f"Could not read GHDL library archive {libraries_archive}: {error}"
        ) from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dist-output", type=Path)
    args = parser.parse_args()
    try:
        require_pinned_zstd_version(ROOT)
    except RuntimeError as error:
        raise SystemExit(str(error)) from error

    requested_output = args.output.absolute()
    if requested_output.is_symlink():
        raise SystemExit(f"Refusing symlink synthesis asset output path: {requested_output}")
    output = requested_output.resolve()
    if output == Path(output.anchor) or output == ROOT:
        raise SystemExit(f"Refusing unsafe synthesis asset output path: {output}")

    asset_root = Path(os.environ.get("S5_ASSET_DIR", "build/wasi"))
    if not asset_root.is_absolute():
        asset_root = ROOT / asset_root
    ghdl_asset_root = Path(os.environ.get("GHDL_ASSET_DIR", "build/ghdl-wasm"))
    if not ghdl_asset_root.is_absolute():
        ghdl_asset_root = ROOT / ghdl_asset_root
    yosys_build = asset_root / "yosys"
    nextpnr_build = asset_root / "nextpnr"
    ghdl_wasm = ghdl_asset_root / "ghdl-synth.wasm"
    ghdl_libraries = ghdl_asset_root / "libraries.tar.gz"
    yosys_share = yosys_build / "share"
    chipdb_source = nextpnr_build / "share/himbaechel/gowin"
    yosys = yosys_build / "yosys.wasm"
    nextpnr = nextpnr_build / "nextpnr-himbaechel-gowin.wasm"
    for path in (yosys, nextpnr, ghdl_wasm, ghdl_libraries):
        require_file(path)
    for family in CHIPDB_FAMILIES:
        require_file(chipdb_source / f"chipdb-{family}.bin")

    if output.exists():
        if output.is_dir():
            shutil.rmtree(output)
        else:
            output.unlink()
    (output / "chipdb").mkdir(parents=True)
    shutil.copyfile(yosys, output / "yosys.wasm")
    shutil.copyfile(nextpnr, output / "nextpnr-himbaechel-gowin.wasm")
    shutil.copyfile(ghdl_wasm, output / "ghdl-synth.wasm")
    create_libraries_tar(output / "libraries.tar", ghdl_libraries)
    create_share_tar(output / "yosys-share.tar", yosys_share)
    for family in CHIPDB_FAMILIES:
        shutil.copyfile(
            chipdb_source / f"chipdb-{family}.bin",
            output / "chipdb" / f"chipdb-{family}.bin",
        )

    asset_paths = sorted(
        (path for path in output.rglob("*") if path.is_file()),
        key=lambda entry: entry.relative_to(output).as_posix(),
    )
    assets = []
    for path in asset_paths:
        relative_path = path.relative_to(output).as_posix()
        compressed_path = output / f"{relative_path}.zst"
        compress_file(path, compressed_path)
        assets.append(
            {
                "path": relative_path,
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
                "encoding": "zstd",
                "compressed_size": compressed_path.stat().st_size,
                "compressed_sha256": sha256_file(compressed_path),
            }
        )
    manifest = {"format_version": 1, "assets": assets}
    manifest_path = output / "manifest.json"
    manifest_path.write_text(
        f"{json.dumps(manifest, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )

    if args.dist_output:
        requested_dist_output = args.dist_output.absolute()
        if requested_dist_output.is_symlink():
            raise SystemExit(
                f"Refusing symlink synthesis distribution output path: {requested_dist_output}"
            )
        dist_output = requested_dist_output.resolve()
        if (
            dist_output in (Path(dist_output.anchor), ROOT, output)
            or dist_output in output.parents
            or output in dist_output.parents
        ):
            raise SystemExit(
                f"Refusing unsafe synthesis distribution output path: {dist_output}"
            )
        if dist_output.exists():
            if dist_output.is_dir():
                shutil.rmtree(dist_output)
            else:
                dist_output.unlink()
        dist_output.mkdir(parents=True)
        shutil.copyfile(manifest_path, dist_output / "manifest.json")
        for asset in assets:
            relative_path = Path(f"{asset['path']}.zst")
            source = output / relative_path
            destination = dist_output / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)

    print(json.dumps({"output": str(output), "assets": len(assets)}, sort_keys=True))


if __name__ == "__main__":
    main()
