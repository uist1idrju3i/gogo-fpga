#!/usr/bin/env python3
"""Check repository pin consistency and report upstream pin updates."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[2]
ACTION_PIN = re.compile(r"^[ \t]*(?:-[ \t]*)?uses:[ \t]*(\S+)(?:[ \t]+#[ \t]*(.*))?$", re.MULTILINE)
FULL_SHA = re.compile(r"^[0-9a-fA-F]{40}$")
VERSION_COMMENT = re.compile(r"^v[0-9][A-Za-z0-9.+-]*$")
VERSION_RE = re.compile(r"(?<![A-Za-z0-9])v?(\d+(?:\.\d+)*)(?:[-+][A-Za-z0-9.-]+)?")
RUNS_ON = re.compile(r"^\s*runs-on:\s*['\"]?([A-Za-z0-9._-]+)", re.MULTILINE)
NODE_VERSION = re.compile(r"^\s*node-version:\s*['\"]?([^'\"#\s]+)", re.MULTILINE)
ACTIONLINT_ENV = re.compile(r"^\s*ACTIONLINT_(VERSION|SHA256):\s*['\"]?([^'\"#\s]+)", re.MULTILINE)
GITMODULE_SECTION = re.compile(r"^\s*\[submodule\s+['\"]([^'\"]+)['\"]\]\s*$")
GITMODULE_KEY = re.compile(r"^\s*(path|url|shallow|branch)\s*=\s*(.*?)\s*$")

TAGGED_SUBMODULES = (
    "openFPGALoader",
    "libusb",
    "zlib",
    "emsdk",
    "yosys",
    "nextpnr",
    "ghdl",
    "iverilog",
    "surfer",
    "zstd",
    "xz-embedded",
    "yices2",
    "z3",
    "boolector",
    "bitwuzla",
    "click",
)
BRANCH_SUBMODULES = ("libftdi", "sby")
FORMAL_SOURCES = {
    "sby": "COPYING",
    "yices2": "LICENSE.txt",
    "z3": "LICENSE.txt",
    "boolector": "COPYING",
    "bitwuzla": "COPYING",
    "click": "LICENSE.txt",
}
ARCHIVE_TAG_SOURCES = {
    "boost": "https://github.com/boostorg/boost.git",
    "eigen": "https://gitlab.com/libeigen/eigen.git",
    "adawebpack": "https://github.com/godunko/adawebpack.git",
}
ARCHIVE_INDEX_SOURCES = {
    "gmp": "https://ftp.gnu.org/gnu/gmp/",
    "mpfr": "https://ftp.gnu.org/gnu/mpfr/",
}
GCC_SOURCE = "https://gcc.gnu.org/git/gcc.git"
GCC_LIBGNAT_TAG = "releases/gcc-14.1.0"
APYCULA_REQUIREMENTS = "requirements-nextpnr.txt"
APYCULA_PYPI_RELEASE = "https://pypi.org/pypi/apycula/json"
NODE_INDEX = "https://nodejs.org/dist/index.json"
ACTIONLINT_RELEASE = "https://api.github.com/repos/rhysd/actionlint/releases/latest"
RUNNER_IMAGES_README = "https://raw.githubusercontent.com/actions/runner-images/main/README.md"
WASI_SDK_RELEASE = "https://api.github.com/repos/WebAssembly/wasi-sdk/releases/latest"
RUST_STABLE_CHANNEL = "https://static.rust-lang.org/dist/channel-rust-stable.toml"
SURFER_TOOL_RELEASES = {
    "trunk": "https://api.github.com/repos/trunk-rs/trunk/releases/latest",
    "wasm-bindgen-cli": "https://api.github.com/repos/rustwasm/wasm-bindgen/releases/latest",
    "binaryen": "https://api.github.com/repos/WebAssembly/binaryen/releases/latest",
}


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def parse_gitmodules(text: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in text.splitlines():
        section = GITMODULE_SECTION.match(line)
        if section:
            if current is not None:
                entries.append(current)
            current = {"name": section.group(1)}
            continue
        match = GITMODULE_KEY.match(line)
        if current is not None and match:
            current[match.group(1)] = match.group(2).strip('"')
    if current is not None:
        entries.append(current)
    return entries


def parse_research_commits(text: str) -> dict[str, str]:
    lines = text.splitlines()
    header_index = None
    for index, line in enumerate(lines):
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if cells[:4] == ["依存", "版", "commit", "取得元"]:
            header_index = index
            break

    commits: dict[str, str] = {}
    if header_index is None:
        return commits
    for line in lines[header_index + 2:]:
        if not line.lstrip().startswith("|"):
            break
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 4 and cells[0] and cells[2]:
            commits[cells[0]] = cells[2]
    return commits


def parse_research_dependency(text: str, dependency: str) -> dict[str, str]:
    lines = text.splitlines()
    header_index = None
    for index, line in enumerate(lines):
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if cells[:4] == ["依存", "版", "commit", "取得元"]:
            header_index = index
            break
    if header_index is None:
        raise RuntimeError("RESEARCH.md に submodule pin 表がありません")
    for line in lines[header_index + 2:]:
        if not line.lstrip().startswith("|"):
            break
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 4 and cells[0] == dependency:
            return {"version": cells[1], "commit": cells[2], "url": cells[3]}
    raise RuntimeError(f"RESEARCH.md に {dependency} の pin がありません")


def parse_formal_pins(text: str) -> dict[str, dict[str, str]]:
    pins = {}
    for name in FORMAL_SOURCES:
        pin = parse_research_dependency(text, name)
        if not FULL_SHA.fullmatch(pin["commit"]):
            raise RuntimeError(f"{name}: formal source pin requires a full commit SHA")
        prefix = {"yices2": "yices-", "z3": "z3-"}.get(name, "")
        pattern = "snapshot" if name == "sby" else re.escape(prefix) + r"\d+\.\d+\.\d+"
        if not re.fullmatch(pattern, pin["version"]):
            raise RuntimeError(f"{name}: invalid formal source release tag")
        pins[name] = pin
    return pins


def formal_source_errors(root: Path, modules: list[dict[str, str]]) -> list[str]:
    by_path = {module.get("path"): module for module in modules}
    documented = parse_research_commits(read_text(root / "RESEARCH.md"))
    if not any(f"vendor/{name}" in by_path or name in documented for name in FORMAL_SOURCES):
        return []
    try:
        pins = parse_formal_pins(read_text(root / "RESEARCH.md"))
    except RuntimeError as error:
        return [str(error)]
    errors = []
    for name, license_path in FORMAL_SOURCES.items():
        path = f"vendor/{name}"
        if by_path.get(path, {}).get("url") != pins[name]["url"]:
            errors.append(f"{path}: formal source URL differs from RESEARCH.md")
        if not read_text(root / path / license_path).strip():
            errors.append(f"{path}: missing formal source license {license_path}")
        for notice in ("NOTICE", "THIRD_PARTY_NOTICES.md"):
            if name not in read_text(root / notice).lower():
                errors.append(f"{notice}: missing formal source attribution for {name}")
    return errors


def latest_archive_version(index: str, name: str) -> str:
    versions = re.findall(r'href=[\"\']' + re.escape(name) + r'-(\d+(?:\.\d+)+)\.tar\.xz[\"\']', index)
    if not versions:
        raise RuntimeError(f"{name}: stable source archive is missing from the index")
    return max(versions, key=parse_version)


def parse_surfer_tool_pins(text: str) -> dict[str, dict[str, str]]:
    lines = text.splitlines()
    header_index = None
    for index, line in enumerate(lines):
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if cells[:4] == ["Tool", "Version", "SHA-256", "URL"]:
            header_index = index
            break
    if header_index is None:
        raise RuntimeError("RESEARCH.md に Surfer tool pin 表がありません")
    pins: dict[str, dict[str, str]] = {}
    for line in lines[header_index + 2:]:
        if not line.lstrip().startswith("|"):
            break
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 4 and cells[0]:
            pins[cells[0]] = {"version": cells[1], "sha256": cells[2], "url": cells[3]}
    required = {"rust", "trunk", "wasm-bindgen-cli", "binaryen"}
    if set(pins) != required:
        raise RuntimeError(f"Surfer tool pin 表が不完全です: {sorted(pins)}")
    if not pins["rust"]["version"] or pins["rust"]["sha256"] != "-":
        raise RuntimeError("Rust toolchain pin が不正です")
    for name in ("trunk", "wasm-bindgen-cli", "binaryen"):
        if not re.fullmatch(r"[0-9a-f]{64}", pins[name]["sha256"]):
            raise RuntimeError(f"{name} の SHA-256 が不正です")
        if not pins[name]["url"].startswith("https://"):
            raise RuntimeError(f"{name} の asset URL が不正です")
    return pins


def parse_archive_pin(text: str, dependency: str) -> dict[str, str]:
    lines = text.splitlines()
    header_index = None
    for index, line in enumerate(lines):
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if cells[:4] == ["依存", "版", "SHA-256", "取得元"]:
            header_index = index
            break
    if header_index is None:
        raise RuntimeError("RESEARCH.md にアーカイブ固定値表がありません")

    matches = []
    for line in lines[header_index + 2:]:
        if not line.lstrip().startswith("|"):
            break
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 4 and cells[0] == dependency:
            matches.append((cells[1], cells[2], cells[3]))
    if len(matches) != 1:
        raise RuntimeError(f"RESEARCH.md の {dependency} 固定値は一件必要です")
    version, sha256, url = matches[0]
    if not re.fullmatch(r"\d+(?:\.\d+)+", version):
        raise RuntimeError(f"RESEARCH.md の {dependency} version が不正です")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", sha256):
        raise RuntimeError(f"RESEARCH.md の {dependency} SHA-256 が不正です")
    if not url.startswith("https://"):
        raise RuntimeError(f"RESEARCH.md の {dependency} URL は HTTPS が必要です")
    return {
        "version": version,
        "sha256": sha256.lower(),
        "asset": url.rsplit("/", 1)[-1],
        "url": url,
    }


def parse_wasi_sdk_pin(text: str) -> dict[str, str]:
    pin = parse_archive_pin(text, "wasi-sdk")
    if not re.fullmatch(
        rf"wasi-sdk-{re.escape(pin['version'])}-x86_64-linux\.tar\.gz",
        pin["asset"],
    ):
        raise RuntimeError("RESEARCH.md の WASI SDK asset URL が不正です")
    return pin


def parse_apycula_package_hashes(text: str) -> tuple[str, dict[str, list[str]]]:
    package = None
    version = None
    package_hashes: dict[str, list[str]] = {}
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        requirement = re.match(r"^([A-Za-z0-9_.-]+)==([A-Za-z0-9.+!-]+)", line)
        if requirement:
            package = requirement.group(1).lower().replace("_", "-")
            version = requirement.group(2)
            package_hashes.setdefault(package, [])
        if package is None:
            raise RuntimeError("requirements-nextpnr.txt に hash なしの行があります")
        found = re.findall(r"--hash=sha256:([0-9a-fA-F]{64})", line)
        package_hashes[package].extend(value.lower() for value in found)
    apycula_versions = re.findall(r"(?mi)^\s*apycula==([A-Za-z0-9.+!-]+)", text)
    if len(apycula_versions) != 1:
        raise RuntimeError("requirements-nextpnr.txt の Apycula 固定値は一件必要です")
    if not package_hashes or any(not found for found in package_hashes.values()):
        raise RuntimeError("requirements-nextpnr.txt の全依存に SHA-256 hash が必要です")
    return apycula_versions[0], {
        name: sorted(set(values)) for name, values in package_hashes.items()
    }


def parse_apycula_requirements(text: str) -> tuple[str, list[str]]:
    version, package_hashes = parse_apycula_package_hashes(text)
    return version, sorted({value for values in package_hashes.values() for value in values})


def parse_apycula_wheel_info(
    requirements_text: str, release_text: str
) -> tuple[str, str, str]:
    version, package_hashes = parse_apycula_package_hashes(requirements_text)
    try:
        release = json.loads(release_text)
    except json.JSONDecodeError as error:
        raise RuntimeError("Apycula release JSON を解析できません") from error
    filename = f"apycula-{version}-py3-none-any.whl"
    matches = [
        item
        for item in release.get("urls", [])
        if item.get("filename") == filename
        and item.get("digests", {}).get("sha256") in package_hashes.get("apycula", [])
    ]
    if len(matches) != 1:
        raise RuntimeError(
            f"requirements-nextpnr.txt に一致する Apycula wheel pin がありません: {filename}"
        )
    return filename, matches[0]["digests"]["sha256"], matches[0]["url"]


def apycula_wheel_info() -> tuple[str, str, str]:
    requirements = read_text(ROOT / APYCULA_REQUIREMENTS)
    version, _ = parse_apycula_package_hashes(requirements)
    url = f"https://pypi.org/pypi/apycula/{version}/json"
    request = urllib.request.Request(url, headers={"User-Agent": "toolchain-pin-check/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        release_text = response.read().decode("utf-8")
    return parse_apycula_wheel_info(requirements, release_text)


def parse_wasi_sdk_release(release_text: str) -> tuple[str, str | None]:
    try:
        release = json.loads(release_text)
    except json.JSONDecodeError as error:
        raise RuntimeError("wasi-sdk release JSON を解析できません") from error
    candidates = []
    for asset in release.get("assets", []):
        name = asset.get("name", "")
        match = re.fullmatch(r"wasi-sdk-(\d+(?:\.\d+)+)-x86_64-linux\.tar\.gz", name)
        if match:
            candidates.append((parse_version(match.group(1)) or (), match.group(1), asset.get("digest")))
    if not candidates:
        raise RuntimeError("wasi-sdk release に Linux x86_64 asset がありません")
    _, version, digest = max(candidates, key=lambda candidate: candidate[0])
    sha256 = digest.removeprefix("sha256:").lower() if isinstance(digest, str) else None
    if sha256 is not None and not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise RuntimeError("wasi-sdk release asset digest が SHA-256 ではありません")
    return version, sha256


def parse_node_major(value: str) -> int | None:
    match = re.search(r"(?<![A-Za-z0-9])v?(\d+)(?:\.\d+)*", value.strip())
    return int(match.group(1)) if match else None


def parse_version(value: str) -> tuple[int, ...] | None:
    dashed_date = re.search(
        r"(?<![A-Za-z0-9])v?(\d{4})-(\d{2})-(\d{2})(?![A-Za-z0-9])",
        value,
    )
    if dashed_date:
        return tuple(int(part) for part in dashed_date.groups())
    compact_date = re.search(
        r"(?<![A-Za-z0-9])v?(\d{4})(\d{2})(\d{2})(?![A-Za-z0-9])",
        value,
    )
    if compact_date:
        return tuple(int(part) for part in compact_date.groups())
    match = VERSION_RE.search(value)
    if not match:
        return None
    return tuple(int(part) for part in match.group(1).split("."))


def is_stable_tag(tag: str, dependency: str | None = None) -> bool:
    if dependency == "ghdl":
        return re.fullmatch(r"v\d+\.\d+\.\d+", tag) is not None
    return not re.search(r"(?i)(?:rc|alpha|beta|pre)", tag)


def remote_tag_targets(output: str) -> dict[str, str]:
    targets: dict[str, str] = {}
    peeled: dict[str, str] = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) != 2 or not FULL_SHA.fullmatch(fields[0]):
            continue
        ref = fields[1]
        if not ref.startswith("refs/tags/"):
            continue
        tag = ref.removeprefix("refs/tags/")
        if tag.endswith("^{}"):
            peeled[tag[:-3]] = fields[0].lower()
        else:
            targets[tag] = fields[0].lower()
    for tag, commit in peeled.items():
        if tag in targets:
            targets[tag] = commit
    return targets


def latest_stable_tag(output: str, dependency: str | None = None) -> str | None:
    stable: list[tuple[tuple[int, ...], str]] = []
    for tag in remote_tag_targets(output):
        if not is_stable_tag(tag, dependency):
            continue
        version = parse_version(tag)
        if version is not None:
            stable.append((version, tag))
    return max(stable, default=((), None), key=lambda entry: entry[0])[1]


def fixed_stable_tag(commit: str, output: str, dependency: str | None = None) -> str | None:
    matches = [
        (version, tag)
        for tag, target in remote_tag_targets(output).items()
        if target == commit.lower()
        and is_stable_tag(tag, dependency)
        and (version := parse_version(tag)) is not None
    ]
    return max(matches, default=((), None), key=lambda entry: entry[0])[1]


def gitlink_sha(name: str, root: Path) -> str:
    path = name if name.startswith("third_party/") else f"vendor/{name}"
    tree_line = run("git", "ls-tree", "HEAD", path, cwd=root).strip()
    if not tree_line:
        raise RuntimeError(f"{path}: HEAD に gitlink がありません")
    metadata, separator, _ = tree_line.partition("\t")
    fields = metadata.split()
    if not separator or len(fields) != 3 or fields[0] != "160000" or fields[1] != "commit":
        raise RuntimeError(f"{path}: HEAD の entry が gitlink ではありません")
    if not FULL_SHA.fullmatch(fields[2]):
        raise RuntimeError(f"{path}: gitlink SHA が不正です")
    return fields[2].lower()


def remote_ref_sha(output: str, ref: str) -> str:
    for line in output.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1] == ref and FULL_SHA.fullmatch(fields[0]):
            return fields[0].lower()
    raise RuntimeError(f"upstream ref がありません: {ref}")


def parse_node_lts(index_text: str) -> tuple[str, str] | None:
    try:
        releases = json.loads(index_text)
    except json.JSONDecodeError:
        return None
    for release in releases:
        lts = release.get("lts")
        if lts:
            return release.get("version", ""), str(lts)
    return None


def parse_runner_labels(readme: str) -> dict[str, str]:
    labels: dict[str, str] = {}
    section = "listed"
    for line in readme.splitlines():
        heading = re.match(r"^\s*#{1,4}\s+(.+?)\s*#*\s*$", line)
        if heading:
            title = heading.group(1).lower()
            if "beta" in title:
                section = "beta"
            elif "preview" in title:
                section = "preview"
            elif "ga" in title or "available images" in title:
                section = "listed"
        for label in re.findall(r"`([A-Za-z0-9][A-Za-z0-9.-]*-[A-Za-z0-9][A-Za-z0-9.-]*)`", line):
            previous = labels.get(label)
            rank = {"listed": 0, "beta": 1, "preview": 2}
            if previous is None or rank[section] > rank[previous]:
                labels[label] = section
    return labels


def parse_action_pins(workflow_text: str) -> list[tuple[str, str | None, str | None]]:
    pins = []
    for match in ACTION_PIN.finditer(workflow_text):
        reference, comment = match.groups()
        if "@" not in reference:
            pins.append((reference, None, comment))
            continue
        action, sha = reference.rsplit("@", 1)
        pins.append((action, sha, comment))
    return pins


def ghdl_build_pin_errors(root: Path) -> list[str]:
    errors: list[str] = []
    script = read_text(root / "scripts/build-ghdl-wasm.sh")
    report = read_text(root / "docs/experiments/S0-ghdl-wasm.md")
    research = read_text(root / "RESEARCH.md")

    def constant(name: str) -> str | None:
        match = re.search(rf"(?m)^readonly {re.escape(name)}=([^\s]+)$", script)
        return match.group(1).strip("'\"") if match else None

    def report_row(name: str) -> list[str] | None:
        for line in report.splitlines():
            if not line.lstrip().startswith("|"):
                continue
            cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
            if cells and cells[0].replace("`", "") == name.replace("`", ""):
                return cells
        return None

    adawebpack = parse_archive_pin(research, "adawebpack")
    if constant("adawebpack_version") != adawebpack["version"]:
        errors.append("build-ghdl-wasm.sh: AdaWebPack version が RESEARCH.md と一致しません")
    if constant("adawebpack_sha256") != adawebpack["sha256"]:
        errors.append("build-ghdl-wasm.sh: AdaWebPack SHA-256 が RESEARCH.md と一致しません")
    gcc_row = report_row("GCC libgnat tag object")
    if gcc_row is None or len(gcc_row) < 2 or constant("gcc_pin") != gcc_row[1].strip("`"):
        errors.append("build-ghdl-wasm.sh: GCC libgnat tag が S0.md と一致しません")

    for label, constant_name in (
        ("libxml2 for AdaWebPack", "libxml2_sha256"),
        ("libicu74 for AdaWebPack", "libicu74_sha256"),
    ):
        row = report_row(label)
        if (
            row is None
            or len(row) < 3
            or constant(constant_name) != row[2].strip("`")
            or row[1] not in script
        ):
            errors.append(f"build-ghdl-wasm.sh: {label} SHA-256 が S0.md と一致しません")

    version_case = script.split("expected_package_version() {", 1)[-1].split("\n}", 1)[0]
    sha_case = script.split("expected_package_sha256() {", 1)[-1].split("\n}", 1)[0]
    versions: dict[str, str] = {}
    for names, version in re.findall(
        r"(?m)^\s*([a-z0-9|-]+)\)\s*printf '%s' '([^']+)'",
        version_case,
    ):
        for name in names.split("|"):
            versions[name] = version
    hashes = re.findall(
        r"(?m)^\s*([a-z0-9-]+):([a-z0-9]+)\) printf '%s' ([0-9a-f]{64})",
        sha_case,
    )
    for name, architecture, sha256 in hashes:
        label = f"{name} ({architecture})"
        row = report_row(label)
        if row is None or len(row) < 3 or row[2].strip("`") != sha256:
            errors.append(f"build-ghdl-wasm.sh: {label} package SHA-256 が S0.md と一致しません")
        elif versions.get(name) != row[1]:
            errors.append(f"build-ghdl-wasm.sh: {label} package version が S0.md と一致しません")
    return errors


def ghdl_browser_build_errors(root: Path = ROOT) -> list[str]:
    paths = (
        ".gitmodules",
        ".github/dependabot.yml",
        "scripts/build-ghdl-wasm.sh",
        "scripts/build-info.py",
        ".github/workflows/build.yml",
        ".github/workflows/release.yml",
        "scripts/package-release.sh",
    )
    return [
        f"{path}: GHDL WASM build must not reference ghdl-browser"
        for path in paths
        if "ghdl-browser" in read_text(root / path).lower()
    ]


def run(*args: str, cwd: Path = ROOT) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def library_catalog_errors(root: Path, modules: list[dict[str, str]]) -> list[str]:
    paths = [module.get("path", "") for module in modules if module.get("path", "").startswith("third_party/")]
    catalog_path = root / "libraries/catalog.json"
    if not paths and not catalog_path.exists():
        return []
    errors: list[str] = []
    try:
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        if catalog.get("formatVersion") != 1 or not isinstance(catalog.get("entries"), list):
            raise ValueError("未対応のカタログ形式です")
        catalog_paths: list[str] = []
        for entry in catalog["entries"]:
            if not isinstance(entry, dict) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", entry.get("id", "")):
                raise ValueError("部品の ID が不正です")
            path = entry.get("submodule", "")
            if path != f'third_party/{entry["id"]}':
                raise ValueError("部品の ID と submodule が一致しません")
            if any(key in entry for key in ("url", "revision", "pin", "commit")):
                raise ValueError("取得元と固定版は .gitmodules と gitlink から導いてください")
            catalog_paths.append(path)
        if len(paths) != len(set(paths)) or len(catalog_paths) != len(set(catalog_paths)) or set(paths) != set(catalog_paths):
            errors.append("libraries/catalog.json: third_party の登録とカタログが一致しません")
        for module in modules:
            path = module.get("path", "")
            if path not in paths:
                continue
            if not module.get("branch", "").strip():
                errors.append(f"{path}: 更新監視用の branch がありません")
            try:
                gitlink_sha(path, root)
            except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
                errors.append(f"{path}: {error}")
    except (OSError, ValueError, TypeError, AttributeError) as error:
        errors.append(f"libraries/catalog.json: {error}")
    return errors


def consistency(root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    gitmodules_path = root / ".gitmodules"
    modules = parse_gitmodules(read_text(gitmodules_path))
    if not modules:
        errors.append(".gitmodules に submodule がありません")
    for module in modules:
        path = module.get("path", "")
        if module.get("shallow", "").lower() != "true":
            errors.append(f"{path}: shallow = true が必要です")
    errors.extend(library_catalog_errors(root, modules))
    errors.extend(formal_source_errors(root, modules))

    research = parse_research_commits(read_text(root / "RESEARCH.md"))
    try:
        tool_pins = parse_surfer_tool_pins(read_text(root / "RESEARCH.md"))
        if "surfer-tool-pins" not in read_text(root / "scripts/build-surfer.sh"):
            errors.append("scripts/build-surfer.sh: pin checker の surfer-tool-pins を使っていません")
        expected_assets = {
            "trunk": "trunk-x86_64-unknown-linux-gnu.tar.gz",
            "wasm-bindgen-cli": "wasm-bindgen-" + tool_pins["wasm-bindgen-cli"]["version"]
            + "-x86_64-unknown-linux-musl.tar.gz",
            "binaryen": "binaryen-" + tool_pins["binaryen"]["version"]
            + "-x86_64-linux.tar.gz",
        }
        for name, asset in expected_assets.items():
            if not tool_pins[name]["url"].endswith(asset):
                errors.append(f"RESEARCH.md: {name} asset URL が pin と一致しません")
    except RuntimeError as error:
        errors.append(f"RESEARCH.md: {error}")
    try:
        parse_wasi_sdk_pin(read_text(root / "RESEARCH.md"))
    except RuntimeError as error:
        errors.append(f"RESEARCH.md: {error}")
    for dependency in (*ARCHIVE_TAG_SOURCES, *ARCHIVE_INDEX_SOURCES):
        try:
            pin = parse_archive_pin(read_text(root / "RESEARCH.md"), dependency)
            expected_url = {
                "boost": (
                    f"https://github.com/boostorg/boost/releases/download/boost-{pin['version']}/"
                    f"boost-{pin['version']}-b2-nodocs.tar.xz"
                ),
                "eigen": (
                    f"https://gitlab.com/libeigen/eigen/-/archive/{pin['version']}/"
                    f"eigen-{pin['version']}.tar.gz"
                ),
                "adawebpack": (
                    f"https://github.com/godunko/adawebpack/releases/download/{pin['version']}/"
                    f"adawebpack-{pin['version']}.tar.gz"
                ),
                "gmp": f"https://ftp.gnu.org/gnu/gmp/gmp-{pin['version']}.tar.xz",
                "mpfr": f"https://ftp.gnu.org/gnu/mpfr/mpfr-{pin['version']}.tar.xz",
            }[dependency]
            if pin["url"] != expected_url:
                errors.append(f"RESEARCH.md: {dependency} asset URL が pin と一致しません")
        except RuntimeError as error:
            errors.append(f"RESEARCH.md: {error}")
    try:
        errors.extend(ghdl_build_pin_errors(root))
    except RuntimeError as error:
        errors.append(f"GHDL WASM pins: {error}")
    errors.extend(ghdl_browser_build_errors(root))
    try:
        parse_apycula_requirements(read_text(root / APYCULA_REQUIREMENTS))
    except RuntimeError as error:
        errors.append(f"{APYCULA_REQUIREMENTS}: {error}")
    for module in modules:
        path = module.get("path", "")
        if not path.startswith("vendor/"):
            continue
        dependency = path.removeprefix("vendor/")
        documented = research.get(dependency)
        if not documented:
            errors.append(f"RESEARCH.md: {dependency} の commit がありません")
            continue
        try:
            tree_line = run("git", "ls-tree", "HEAD", path, cwd=root).strip()
        except (OSError, subprocess.CalledProcessError) as error:
            errors.append(f"{path}: gitlink を取得できません: {error}")
            continue
        if not tree_line:
            errors.append(f"{path}: HEAD に gitlink がありません")
            continue
        fields = tree_line.split("\t", 1)[0].split()
        if len(fields) < 3 or fields[1] != "commit":
            errors.append(f"{path}: HEAD の entry が gitlink ではありません")
            continue
        gitlink = fields[2]
        if not gitlink.startswith(documented):
            errors.append(
                f"RESEARCH.md: {dependency} commit {documented} が gitlink {gitlink} と一致しません"
            )

    workflows = sorted((root / ".github/workflows").glob("*.yml"))
    if not workflows:
        errors.append(".github/workflows/*.yml がありません")
    action_shas: dict[str, str] = {}
    runner_labels: set[str] = set()
    node_declarations: list[tuple[str, int]] = []
    for workflow in workflows:
        text = read_text(workflow)
        for action, sha, comment in parse_action_pins(text):
            if sha is None or not FULL_SHA.fullmatch(sha):
                errors.append(f"{workflow.name}: uses: {action} は 40 桁の SHA で固定してください")
                continue
            if comment is None or not VERSION_COMMENT.fullmatch(comment.strip()):
                errors.append(f"{workflow.name}: uses: {action} に # vX.Y.Z が必要です")
            previous = action_shas.setdefault(action.lower(), sha.lower())
            if previous != sha.lower():
                errors.append(f"{workflow.name}: {action} の SHA が workflow 間で一致しません")
        runner_labels.update(RUNS_ON.findall(text))
        for value in NODE_VERSION.findall(text):
            major = parse_node_major(value)
            if major is None:
                errors.append(f"{workflow.name}: node-version を解釈できません: {value}")
            else:
                node_declarations.append((workflow.name, major))

    if len(runner_labels) != 1:
        errors.append(
            "全 workflow の runs-on は同じ label が必要です: "
            + (", ".join(sorted(runner_labels)) if runner_labels else "未設定")
        )

    build_text = read_text(root / ".github/workflows/build.yml")
    build_values = NODE_VERSION.findall(build_text)
    build_major = parse_node_major(build_values[0]) if len(build_values) == 1 else None
    if build_major is None:
        errors.append("build.yml に node-version を一つだけ設定してください")
    else:
        for source, major in node_declarations:
            if major != build_major:
                errors.append(
                    f"{source}: Node.js major {major} が build.yml の {build_major} と一致しません"
                )

    for filename in (".nvmrc", ".node-version"):
        path = root / filename
        if path.exists():
            major = parse_node_major(read_text(path))
            if major is None:
                errors.append(f"{filename}: Node.js major を解釈できません")
            elif build_major is not None and major != build_major:
                errors.append(f"{filename}: Node.js major {major} が build.yml の {build_major} と一致しません")
    package_path = root / "package.json"
    if package_path.exists():
        try:
            engines = json.loads(read_text(package_path)).get("engines", {}).get("node")
        except (json.JSONDecodeError, AttributeError):
            engines = None
        if engines:
            major = parse_node_major(str(engines))
            if major is None:
                errors.append("package.json engines.node を解釈できません")
            elif build_major is not None and major != build_major:
                errors.append(f"package.json engines.node major {major} が build.yml の {build_major} と一致しません")

    lint_text = read_text(root / ".github/workflows/lint.yml")
    lint_values = dict(ACTIONLINT_ENV.findall(lint_text))
    if not re.fullmatch(r"\d+\.\d+\.\d+", lint_values.get("VERSION", "")):
        errors.append("lint.yml に有効な ACTIONLINT_VERSION が必要です")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", lint_values.get("SHA256", "")):
        errors.append("lint.yml に有効な ACTIONLINT_SHA256 が必要です")
    return errors


def fetch(url: str) -> str:
    headers = {"User-Agent": "toolchain-check-pins"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def compare_status(fixed: str, latest: str) -> str:
    fixed_version = parse_version(fixed)
    latest_version = parse_version(latest)
    if fixed_version is None or latest_version is None:
        return "最新" if fixed == latest else "更新あり"
    return "最新" if fixed_version == latest_version else "更新あり"


def rust_stable_version(text: str) -> str:
    try:
        version = tomllib.loads(text)["pkg"]["rust"]["version"]
    except (tomllib.TOMLDecodeError, KeyError, TypeError) as error:
        raise RuntimeError("Rust stable channel の pkg.rust.version が読めません") from error
    match = re.fullmatch(
        r"(\d+\.\d+\.\d+)(?: \([0-9a-f]{7,40} \d{4}-\d{2}-\d{2}\))?", version,
    ) if isinstance(version, str) else None
    if match is None:
        raise RuntimeError("Rust stable channel の version が不正です")
    return match.group(1)


def upstream_report(root: Path = ROOT) -> str:
    rows: list[tuple[str, str, str, str]] = []

    def add_row(name: str, fixed: str, latest: str, status: str) -> None:
        rows.append((name, fixed, latest, status))

    modules = {item.get("path", "").removeprefix("vendor/"): item for item in parse_gitmodules(read_text(root / ".gitmodules"))}
    for name in TAGGED_SUBMODULES:
        module = modules.get(name)
        if module is None:
            add_row(name, "未設定", "取得できません", "要確認")
            continue
        try:
            pinned = gitlink_sha(name, root)
            remote = run("git", "ls-remote", "--tags", module["url"], cwd=root)
            fixed = fixed_stable_tag(pinned, remote, name)
            latest = latest_stable_tag(remote, name)
            if not fixed:
                raise RuntimeError("gitlink に一致する安定版タグがありません")
            if not latest:
                raise RuntimeError("安定版タグがありません")
            if name in FORMAL_SOURCES:
                declared = parse_research_dependency(read_text(root / "RESEARCH.md"), name)["version"]
                if remote_tag_targets(remote).get(declared) != pinned:
                    raise RuntimeError("formal source release tag differs from its gitlink")
            add_row(name, fixed, latest, compare_status(fixed, latest))
        except (KeyError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
            print(f"{name}: upstream を取得できません: {error}", file=sys.stderr)
            add_row(name, "取得できません", "取得できません", "要確認")

    for name in BRANCH_SUBMODULES:
        module = modules.get(name)
        if module is None:
            add_row(f"{name} (branch)", "未設定", "取得できません", "要確認")
            continue
        try:
            pinned = gitlink_sha(name, root)
            branch = module.get("branch", "").strip() or "HEAD"
            ref = "HEAD" if branch == "HEAD" else f"refs/heads/{branch}"
            remote = run("git", "ls-remote", module["url"], ref, cwd=root)
            latest = remote_ref_sha(remote, ref)
            status = "最新" if pinned == latest else "更新あり"
            add_row(f"{name} (branch)", pinned[:12], latest[:12], status)
        except (KeyError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
            print(f"{name}: upstream を取得できません: {error}", file=sys.stderr)
            add_row(f"{name} (branch)", "取得できません", "取得できません", "要確認")

    for path, module in modules.items():
        if not path.startswith("third_party/"):
            continue
        try:
            pinned = gitlink_sha(path, root)
            branch = module["branch"].strip()
            if not branch:
                raise RuntimeError("更新監視用の branch がありません")
            ref = f"refs/heads/{branch}"
            remote = run("git", "ls-remote", module["url"], ref, "refs/tags/*", cwd=root)
            latest = remote_ref_sha(remote, ref)
            latest_tag = latest_stable_tag(remote)
            label = latest[:12] + (f" / tag {latest_tag}" if latest_tag else " / 安定版タグなし")
            add_row(f"{path} (branch)", pinned[:12], label, "最新" if pinned == latest else "更新あり")
        except (KeyError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
            print(f"{path}: upstream を取得できません: {error}", file=sys.stderr)
            add_row(f"{path} (branch)", "取得できません", "取得できません", "要確認")

    try:
        pin = parse_wasi_sdk_pin(read_text(root / "RESEARCH.md"))
        latest_version, latest_sha = parse_wasi_sdk_release(fetch(WASI_SDK_RELEASE))
        fixed = f"{pin['version']} ({pin['sha256'][:12]})"
        latest = f"{latest_version} ({latest_sha[:12]})" if latest_sha else latest_version
        status = compare_status(pin["version"], latest_version)
        if latest_sha is not None and latest_sha != pin["sha256"]:
            status = "更新あり"
        add_row("wasi-sdk", fixed, latest, status)
    except (OSError, urllib.error.URLError, RuntimeError) as error:
        print(f"wasi-sdk: upstream を取得できません: {error}", file=sys.stderr)
        add_row("wasi-sdk", "取得できません", "取得できません", "要確認")

    for name, url in ARCHIVE_TAG_SOURCES.items():
        try:
            pin = parse_archive_pin(read_text(root / "RESEARCH.md"), name)
            latest_tag = latest_stable_tag(run("git", "ls-remote", "--tags", url, cwd=root))
            if latest_tag is None:
                raise RuntimeError("安定版タグがありません")
            latest_version = parse_version(latest_tag)
            if latest_version is None:
                raise RuntimeError("最新タグの version を読めません")
            fixed = f"{pin['version']} ({pin['sha256'][:12]})"
            latest = latest_tag
            add_row(f"{name} archive", fixed, latest, compare_status(pin["version"], latest))
        except (OSError, urllib.error.URLError, RuntimeError, subprocess.CalledProcessError) as error:
            print(f"{name}: upstream を取得できません: {error}", file=sys.stderr)
            add_row(f"{name} archive", "取得できません", "取得できません", "要確認")

    for name, url in ARCHIVE_INDEX_SOURCES.items():
        try:
            pin = parse_archive_pin(read_text(root / "RESEARCH.md"), name)
            latest = latest_archive_version(fetch(url), name)
            add_row(f"{name} archive", pin["version"], latest, compare_status(pin["version"], latest))
        except (OSError, urllib.error.URLError, RuntimeError) as error:
            print(f"{name}: upstream を取得できません: {error}", file=sys.stderr)
            add_row(f"{name} archive", "取得できません", "取得できません", "要確認")

    try:
        s0 = read_text(root / "docs/experiments/S0-ghdl-wasm.md")
        tag_match = re.search(
            r"^\|\s*GCC libgnat tag object\s*\|\s*`?([0-9a-f]{40})`?\s*\|$",
            s0,
            re.MULTILINE,
        )
        if tag_match is None:
            raise RuntimeError("S0.md に GCC libgnat tag object がありません")
        pinned = tag_match.group(1)
        remote = run(
            "git", "ls-remote", "--tags", GCC_SOURCE,
            f"refs/tags/{GCC_LIBGNAT_TAG}",
            f"refs/tags/{GCC_LIBGNAT_TAG}^{{}}",
            cwd=root,
        )
        latest = remote_ref_sha(remote, f"refs/tags/{GCC_LIBGNAT_TAG}")
        add_row(
            "GCC libgnat",
            f"{GCC_LIBGNAT_TAG} ({pinned[:12]})",
            f"{GCC_LIBGNAT_TAG} ({latest[:12]})",
            "最新" if pinned == latest else "更新あり",
        )
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"GCC libgnat: upstream を取得できません: {error}", file=sys.stderr)
        add_row("GCC libgnat", "取得できません", "取得できません", "要確認")

    try:
        apycula_version, _ = parse_apycula_requirements(
            read_text(root / APYCULA_REQUIREMENTS)
        )
        pypi = json.loads(fetch(APYCULA_PYPI_RELEASE))
        latest_apycula = str(pypi.get("info", {}).get("version", ""))
        if not latest_apycula:
            raise RuntimeError("PyPI の latest version がありません")
        add_row("Apycula", apycula_version, latest_apycula, compare_status(apycula_version, latest_apycula))
    except (OSError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Apycula: pin を取得できません: {error}", file=sys.stderr)
        add_row("Apycula", "取得できません", "取得できません", "要確認")

    try:
        node = parse_node_lts(fetch(NODE_INDEX))
        if node is None:
            raise RuntimeError("Active LTS が見つかりません")
        node_version, lts_name = node
        node_pin_values = NODE_VERSION.findall(read_text(root / ".github/workflows/build.yml"))
        pinned_major = parse_node_major(node_pin_values[0]) if node_pin_values else None
        if pinned_major is None:
            raise RuntimeError("build.yml の node-version が読めません")
        latest_major = parse_node_major(node_version)
        state = "最新" if pinned_major == latest_major else "更新あり"
        add_row("Node.js Active LTS", str(pinned_major), f"{node_version} {lts_name} (major {latest_major})", state)
    except (OSError, urllib.error.URLError, RuntimeError) as error:
        print(f"Node.js: upstream を取得できません: {error}", file=sys.stderr)
        add_row("Node.js Active LTS", "取得できません", "取得できません", "要確認")

    try:
        rust_pin = parse_surfer_tool_pins(read_text(root / "RESEARCH.md"))["rust"]["version"]
        latest_rust = rust_stable_version(fetch(RUST_STABLE_CHANNEL))
        add_row("Rust toolchain", rust_pin, latest_rust, compare_status(rust_pin, latest_rust))
    except (OSError, urllib.error.URLError, RuntimeError) as error:
        print(f"Rust toolchain: upstream を取得できません: {error}", file=sys.stderr)
        add_row("Rust toolchain", "取得できません", "取得できません", "要確認")

    try:
        tool_pins = parse_surfer_tool_pins(read_text(root / "RESEARCH.md"))
        for name, url in SURFER_TOOL_RELEASES.items():
            release = json.loads(fetch(url))
            tag = str(release.get("tag_name", ""))
            latest = tag[1:] if re.fullmatch(r"v\d+(?:\.\d+)*", tag) else tag
            fixed = tool_pins[name]["version"]
            if not latest:
                raise RuntimeError(f"{name} latest release tag is missing")
            add_row(name, fixed, latest, compare_status(fixed, latest))
    except (OSError, urllib.error.URLError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Surfer build tools: upstream を取得できません: {error}", file=sys.stderr)
        for name in SURFER_TOOL_RELEASES:
            add_row(name, "取得できません", "取得できません", "要確認")

    lint_values = dict(ACTIONLINT_ENV.findall(read_text(root / ".github/workflows/lint.yml")))
    try:
        release = json.loads(fetch(ACTIONLINT_RELEASE))
        latest = str(release.get("tag_name", "")).removeprefix("v")
        fixed = lint_values.get("VERSION", "")
        if not latest:
            raise RuntimeError("latest release tag がありません")
        add_row("actionlint", fixed, latest, compare_status(fixed, latest))
    except (OSError, urllib.error.URLError, json.JSONDecodeError, RuntimeError) as error:
        print(f"actionlint: upstream を取得できません: {error}", file=sys.stderr)
        add_row("actionlint", lint_values.get("VERSION", "未設定"), "取得できません", "要確認")

    try:
        runner_text = fetch(RUNNER_IMAGES_README)
        runner_labels = parse_runner_labels(runner_text)
        workflow_text = "\n".join(read_text(path) for path in (root / ".github/workflows").glob("*.yml"))
        labels = sorted(set(RUNS_ON.findall(workflow_text)))
        if len(labels) != 1:
            raise RuntimeError(f"workflow runner label が一意ではありません: {labels}")
        label = labels[0]
        runner_status = runner_labels.get(label)
        if runner_status is None:
            add_row("GitHub-hosted runner", label, "README に未掲載", "更新あり")
        else:
            status = "最新" if runner_status == "listed" else "更新あり"
            add_row("GitHub-hosted runner", label, runner_status, status)
    except (OSError, urllib.error.URLError, RuntimeError) as error:
        print(f"runner-images: upstream を取得できません: {error}", file=sys.stderr)
        add_row("GitHub-hosted runner", "取得できません", "取得できません", "要確認")

    lines = [
        "| 依存 | 固定値 | 最新 | 状態 |",
        "|---|---|---|---|",
    ]
    lines.extend(f"| {name} | {fixed} | {latest} | {status} |" for name, fixed, latest, status in rows)
    return "\n".join(lines) + "\n"


def parse_report_rows(report: str) -> list[tuple[str, str, str, str]]:
    lines = report.splitlines()
    header = ["依存", "固定値", "最新", "状態"]
    header_index = None
    for index, line in enumerate(lines):
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells == header:
            header_index = index
            break
    if header_index is None or header_index + 1 >= len(lines):
        raise ValueError("固定版レポートの表ヘッダーがありません")

    separator = [
        cell.strip()
        for cell in lines[header_index + 1].strip().strip("|").split("|")
    ]
    if len(separator) != len(header) or not all(
        re.fullmatch(r":?-{3,}:?", cell) for cell in separator
    ):
        raise ValueError("固定版レポートの表区切りが不正です")

    rows = []
    for line in lines[header_index + 2:]:
        if not line.lstrip().startswith("|"):
            break
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != len(header):
            raise ValueError("固定版レポートの列数が不正です")
        rows.append(tuple(cells))
    if not rows:
        raise ValueError("固定版レポートに依存行がありません")
    return rows


def needs_update(rows: Iterable[tuple[str, str, str, str]]) -> bool:
    return any(row[3] != "最新" for row in rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("consistency", help="offline repository consistency checks")
    subparsers.add_parser("wasi-sdk-pin", help="print the pinned WASI SDK values")
    subparsers.add_parser("yosys-pin", help="print the pinned Yosys values")
    subparsers.add_parser("nextpnr-pin", help="print the pinned nextpnr values")
    subparsers.add_parser("iverilog-pin", help="print the pinned Icarus Verilog values")
    subparsers.add_parser("surfer-tool-pins", help="print pinned Surfer build tools")
    subparsers.add_parser("formal-pins", help="print pinned formal sources as JSON")
    archive_pin = subparsers.add_parser("archive-pin", help="print a pinned source archive")
    archive_pin.add_argument("dependency", choices=(*ARCHIVE_TAG_SOURCES, *ARCHIVE_INDEX_SOURCES))
    subparsers.add_parser("pnr-cache-pin", help="print the PnR dependency cache inputs")
    subparsers.add_parser("apycula-wheel-pins", help="print the Apycula wheel requirement hashes")
    subparsers.add_parser("apycula-wheel-info", help="print the pinned Apycula wheel asset")
    upstream = subparsers.add_parser("upstream", help="report upstream pin updates")
    upstream.add_argument("--report", required=True, type=Path)
    upstream.add_argument("--github-output", type=Path)
    args = parser.parse_args()

    if args.command == "consistency":
        errors = consistency()
        if errors:
            for error in errors:
                print(f"error: {error}", file=sys.stderr)
            return 1
        print("pin consistency: OK")
        return 0
    if args.command == "wasi-sdk-pin":
        pin = parse_wasi_sdk_pin(read_text(ROOT / "RESEARCH.md"))
        print("\t".join((pin["version"], pin["sha256"], pin["asset"], pin["url"])))
        return 0
    if args.command == "yosys-pin":
        pin = parse_research_dependency(read_text(ROOT / "RESEARCH.md"), "yosys")
        print("\t".join((pin["version"], pin["commit"], pin["url"])))
        return 0
    if args.command == "nextpnr-pin":
        pin = parse_research_dependency(read_text(ROOT / "RESEARCH.md"), "nextpnr")
        print("\t".join((pin["version"], pin["commit"], pin["url"])))
        return 0
    if args.command == "iverilog-pin":
        pin = parse_research_dependency(read_text(ROOT / "RESEARCH.md"), "iverilog")
        print("\t".join((pin["version"], pin["commit"], pin["url"])))
        return 0
    if args.command == "surfer-tool-pins":
        pins = parse_surfer_tool_pins(read_text(ROOT / "RESEARCH.md"))
        values = [
            pins["rust"]["version"],
            pins["trunk"]["version"], pins["trunk"]["sha256"], pins["trunk"]["url"],
            pins["wasm-bindgen-cli"]["version"], pins["wasm-bindgen-cli"]["sha256"],
            pins["wasm-bindgen-cli"]["url"],
            pins["binaryen"]["version"], pins["binaryen"]["sha256"], pins["binaryen"]["url"],
        ]
        print("\t".join(values))
        return 0
    if args.command == "formal-pins":
        print(json.dumps(parse_formal_pins(read_text(ROOT / "RESEARCH.md")), sort_keys=True))
        return 0
    if args.command == "archive-pin":
        pin = parse_archive_pin(read_text(ROOT / "RESEARCH.md"), args.dependency)
        print("\t".join((pin["version"], pin["sha256"], pin["asset"], pin["url"])))
        return 0
    if args.command == "pnr-cache-pin":
        wasi = parse_wasi_sdk_pin(read_text(ROOT / "RESEARCH.md"))
        archives = [
            parse_archive_pin(read_text(ROOT / "RESEARCH.md"), dependency)
            for dependency in ("boost", "eigen")
        ]
        apycula_version, apycula_hashes = parse_apycula_requirements(
            read_text(ROOT / APYCULA_REQUIREMENTS)
        )
        print(
            "\t".join(
                [
                    wasi["version"],
                    wasi["sha256"],
                    *(value for pin in archives for value in (pin["version"], pin["sha256"])),
                    apycula_version,
                    *apycula_hashes,
                ]
            )
        )
        return 0
    if args.command == "apycula-wheel-info":
        filename, sha256, url = apycula_wheel_info()
        print("\t".join((filename, sha256, url)))
        return 0
    if args.command == "apycula-wheel-pins":
        version, packages = parse_apycula_package_hashes(
            read_text(ROOT / APYCULA_REQUIREMENTS)
        )
        print("\t".join((version, *packages["apycula"])))
        return 0

    report = upstream_report()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(report, encoding="utf-8")
    if args.github_output is not None:
        rows = parse_report_rows(report)
        output_value = str(needs_update(rows)).lower()
        args.github_output.parent.mkdir(parents=True, exist_ok=True)
        args.github_output.write_text(f"needs_update={output_value}\n", encoding="utf-8")
    print(report, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
