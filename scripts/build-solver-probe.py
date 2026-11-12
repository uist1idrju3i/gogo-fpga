#!/usr/bin/env python3
"""Build isolated formal solver diagnostics, without replacing product assets."""

from __future__ import annotations

import argparse
import configparser
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pin(*arguments: str):
    return subprocess.check_output(
        ["python3", str(ROOT / ".github/scripts/check-pins.py"), *arguments], text=True
    ).strip()


def stage_source(name: str, expected: str, output: Path):
    source = ROOT / "vendor" / name
    if (source / ".git").exists():
        actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True).strip():
            raise ValueError(f"Modified upstream source: {name}")
        archive = subprocess.check_output(["git", "-C", str(source), "archive", "HEAD"])
    else:
        actual = (source / ".gitcommit").read_text().strip()
    if actual != expected:
        raise ValueError(f"Upstream pin mismatch: {name}")
    if (source / ".git").exists():
        output.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive)) as entries:
            entries.extractall(output, filter="data")
    else:
        shutil.copytree(source, output, ignore=shutil.ignore_patterns(".git"), symlinks=True)
    (output / ".gitcommit").write_text(expected + "\n")


def setup_dependency(source: Path, name: str) -> dict[str, str]:
    text = (source / "contrib" / f"setup-{name}.sh").read_text()
    commits = re.findall(r'^COMMIT_ID="([0-9a-f]{40})"$', text, re.MULTILINE)
    urls = re.findall(r'download_github "([A-Za-z0-9_-]+/[A-Za-z0-9_-]+)" "\$COMMIT_ID"', text)
    if len(commits) != 1 or len(urls) != 1:
        raise ValueError(f"Unrecognized upstream dependency pin: {name}")
    return {"commit": commits[0], "url": f"https://github.com/{urls[0]}.git"}


def stage_dependency(name, dependency, output, metadata, run):
    repository = output / f"{name}-git"
    source = output / f"{name}-source"
    metadata.setdefault("dependencies", {})[name] = {**dependency}
    run(f"{name}-init", ["git", "init", "--bare", repository])
    run(f"{name}-fetch", ["git", "--git-dir", repository, "fetch", "--depth=1",
                          dependency["url"], dependency["commit"]])
    actual = subprocess.check_output(["git", "--git-dir", str(repository), "rev-parse", "FETCH_HEAD"], text=True).strip()
    if actual != dependency["commit"]:
        raise ValueError(f"Fetched upstream pin mismatch: {name}")
    archive = subprocess.check_output(["git", "--git-dir", str(repository), "archive", actual])
    archive_path = output / f"{name}-source.tar"
    archive_path.write_bytes(archive)
    source.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as entries:
        entries.extractall(source, filter="data")
    licenses = sorted(p for p in source.iterdir() if p.name.startswith(("LICENSE", "COPYING")))
    if not licenses or any(not p.is_file() or p.is_symlink() or not p.stat().st_size for p in licenses):
        raise ValueError(f"Missing or unsafe dependency license: {name}")
    metadata["dependencies"][name].update(
        archive_sha256=digest(archive_path), licenses={p.name: digest(p) for p in licenses},
    )
    return source


def apply_source_patch(name, source, output, metadata, run, label):
    patch = ROOT / "patches" / name
    snapshot = output / f"{label}.patch"
    with snapshot.open("xb") as stream:
        stream.write(patch.read_bytes())
    metadata["patches"].append({"path": str(patch.relative_to(ROOT)), "sha256": digest(snapshot),
                                "snapshot": snapshot.name})
    run(label, ["patch", "--batch", "--fuzz=0", "-p1", "-i", snapshot], source)


def build_boolector(args, output, source, metadata, run, environment, compiler, compiler_cxx, c_flags, link_flags, sdk):
    metadata["cmake"] = subprocess.check_output([args.cmake, "--version"], text=True)
    cxx_flags = c_flags.replace(" -std=gnu17", "")
    if args.runtime == "native":
        cxx_flags = f"{cxx_flags} {args.cxx_flags}".strip()
        link_flags = args.cxx_link_flags
    environment = {**environment, "CC": compiler, "CXX": compiler_cxx,
                   "CFLAGS": c_flags, "CXXFLAGS": cxx_flags, "LDFLAGS": link_flags,
                   "GIT_CEILING_DIRECTORIES": str(output)}
    if args.runtime == "wasi":
        environment.update(AR=str(sdk / "bin/llvm-ar"), RANLIB=str(sdk / "bin/llvm-ranlib"))
    prefix = output / "dependencies"
    (prefix / "include").mkdir(parents=True)
    (prefix / "lib").mkdir()
    cadical = stage_dependency("cadical", setup_dependency(source, "cadical"), output, metadata, run)
    btor = stage_dependency("btor2tools", setup_dependency(source, "btor2tools"), output, metadata, run)
    cadical_options = []
    if args.runtime == "wasi":
        for index, name in enumerate(("cadical-wasi-cross.patch", "cadical-wasi-pipes.patch",
                                      "cadical-wasi-resources.patch", "cadical-wasi-alarm.patch")):
            apply_source_patch(name, cadical, output, metadata, run, f"cadical-patch-{index}")
        apply_source_patch("btor2tools-wasi-ids.patch", btor, output, metadata, run, "btor2tools-ids-patch")
        apply_source_patch("boolector-wasi-trace.patch", source, output, metadata, run, "boolector-trace-patch")
        cadical_options = ["--cross"]
        metadata["cadical_native_rss_available"] = False
        environment["LDFLAGS"] = f"{link_flags} -lunwind -lsetjmp"
    run("cadical-configure", [cadical / "configure", "-O2", *cadical_options], cadical, environment)
    run("cadical-build", ["make", f"-j{args.jobs}", "libcadical.a"], cadical / "build", environment)
    shutil.copyfile(cadical / "build/libcadical.a", prefix / "lib/libcadical.a")
    shutil.copyfile(cadical / "src/ccadical.h", prefix / "include/ccadical.h")
    toolchain = [f"-DCMAKE_EXE_LINKER_FLAGS={link_flags}"]
    if args.runtime == "wasi":
        toolchain = [f"-DCMAKE_TOOLCHAIN_FILE={sdk}/share/cmake/wasi-sdk-p1.cmake",
                     f"-DCMAKE_EXE_LINKER_FLAGS={link_flags}",
                     "-DCMAKE_CXX_STANDARD_LIBRARIES=-lunwind -lsetjmp",
                     "-DCMAKE_CROSSCOMPILING_EMULATOR="]
    elif args.cxx_libraries:
        toolchain += [f"-DCMAKE_CXX_STANDARD_LIBRARIES={args.cxx_libraries}"]
    common = [*toolchain, f"-DCMAKE_C_COMPILER={compiler}", f"-DCMAKE_CXX_COMPILER={compiler_cxx}",
              f"-DCMAKE_C_FLAGS={c_flags}", f"-DCMAKE_CXX_FLAGS={environment['CXXFLAGS']}",
              "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DBUILD_SHARED_LIBS=OFF"]
    run("btor2tools-configure", [args.cmake, "-S", btor, "-B", output / "btor2tools-build", *common], env=environment)
    run("btor2tools-build", [args.cmake, "--build", output / "btor2tools-build", "--target", "btor2parser",
                            "--parallel", str(args.jobs)], env=environment)
    shutil.copyfile(output / "btor2tools-build/lib/libbtor2parser.a", prefix / "lib/libbtor2parser.a")
    shutil.copyfile(btor / "src/btor2parser/btor2parser.h", prefix / "include/btor2parser.h")
    run("configure", [args.cmake, "-S", source, "-B", output / "objects", *common,
                      f"-DCMAKE_PREFIX_PATH={prefix}", "-DONLY_CADICAL=ON", "-DUSE_GMP=OFF",
                      "-DPYTHON=OFF", "-DTESTING=OFF", "-DTIME_STATS=OFF",
                      "-DCMAKE_DISABLE_FIND_PACKAGE_Threads=TRUE"], env=environment)
    run("build", [args.cmake, "--build", output / "objects", "--target", "boolector-bin",
                  "--parallel", str(args.jobs)], env=environment)
    metadata["static_libraries"] = {}
    for name, library in (("boolector", output / "objects/lib/libboolector.a"),
                          ("cadical", prefix / "lib/libcadical.a"),
                          ("btor2parser", prefix / "lib/libbtor2parser.a")):
        metadata["static_libraries"][name] = {
            "path": str(library.relative_to(output)), "bytes": library.stat().st_size,
            "sha256": digest(library),
        }
    return output / "objects/bin/boolector"


def bitwuzla_dependencies(source):
    result = {}
    for name, section in (("cadical", "wrap-file"), ("symfpu", "wrap-git")):
        path = source / "subprojects" / f"{name}.wrap"
        parser = configparser.ConfigParser(interpolation=None)
        parser.read_string(path.read_text())
        values = dict(parser[section])
        if section == "wrap-file":
            if (not re.fullmatch(r"[A-Za-z0-9_.-]+", values["directory"])
                    or values["directory"] in (".", "..")
                    or not re.fullmatch(r"[A-Za-z0-9_.-]+\.tar\.gz", values["source_filename"])
                    or not re.fullmatch(r"[0-9a-f]{64}", values["source_hash"])
                    or not values["source_url"].startswith("https://github.com/")):
                raise ValueError("Invalid pinned CaDiCaL wrap")
        elif (not re.fullmatch(r"[0-9a-f]{40}", values["revision"])
              or not re.fullmatch(r"https://github.com/[\w-]+/[\w.-]+\.git", values["url"])):
            raise ValueError("Invalid pinned SymFPU wrap")
        if values["patch_directory"] != name:
            raise ValueError("Unexpected Meson overlay")
        result[name] = {**values, "wrap_sha256": digest(path)}
    return result


def check_bitwuzla_meson_dependencies(entries, prefix, versions):
    found = {entry["name"]: entry for entry in entries}
    if len(found) != len(entries) or set(found) - {"gmp", "mpfr", "threads"}:
        raise ValueError("Unexpected external Bitwuzla dependency")
    for name in ("gmp", "mpfr"):
        entry = found.get(name, {})
        libraries = [str(prefix / f"lib/lib{name}.a")]
        if name == "mpfr":
            libraries.append(str(prefix / "lib/libgmp.a"))
        if (entry.get("version") != versions[name]
                or entry.get("compile_args") != [f"-I{prefix}/include"]
                or entry.get("link_args") != libraries):
            raise ValueError(f"Meson did not select the staged {name} headers and libraries")
    return entries


def build_bitwuzla(args, output, source, metadata, run, environment, compiler, compiler_cxx, c_flags, link_flags, sdk):
    metadata["meson"] = subprocess.check_output([args.meson, "--version"], text=True)
    metadata["ninja"] = subprocess.check_output(["ninja", "--version"], text=True)
    metadata["pkg_config"] = subprocess.check_output(["pkg-config", "--version"], text=True)
    cxx_flags = c_flags.replace(" -std=gnu17", "")
    if args.runtime == "native":
        cxx_flags = f"{cxx_flags} {args.cxx_flags}".strip()
        link_flags = args.cxx_link_flags
    else:
        link_flags = f"-fwasm-exceptions {link_flags}"
    prefix = output / "dependencies"
    env = {**environment, "CC": compiler, "CXX": compiler_cxx, "CFLAGS": c_flags,
           "CXXFLAGS": cxx_flags, "LDFLAGS": link_flags,
           "GIT_CEILING_DIRECTORIES": str(output),
           "PKG_CONFIG_LIBDIR": str(prefix / "lib/pkgconfig"), "PKG_CONFIG_PATH": ""}
    if sdk:
        env.update(AR=str(sdk / "bin/llvm-ar"), RANLIB=str(sdk / "bin/llvm-ranlib"))
        env["LDFLAGS"] = f"{link_flags} -lunwind -lsetjmp"
    for name in ("gmp", "mpfr"):
        version, sha256, asset, _url = pin("archive-pin", name).split("\t")
        archive = ROOT / "vendor/formal-archives" / asset
        if not archive.exists():
            archive = ROOT / "build/cache" / asset
        if digest(archive) != sha256:
            raise ValueError(f"{name} archive pin mismatch")
        metadata[name] = {"version": version, "archive_sha256": sha256}
        arithmetic = output / f"{name}-source"
        objects = output / f"{name}-objects"
        arithmetic.mkdir()
        objects.mkdir()
        shutil.copyfile(archive, output / asset)
        run(f"{name}-extract", ["tar", "-xJf", archive, "--strip-components=1", "-C", arithmetic])
        metadata[name]["licenses"] = {p.name: digest(p) for p in arithmetic.glob("COPYING*") if p.is_file()}
        if not metadata[name]["licenses"]:
            raise ValueError(f"Missing {name} license")
        options = [f"--prefix={prefix}", "--disable-shared", "--enable-static"]
        if name == "gmp":
            options += ["--disable-assembly", "--enable-cxx"]
        else:
            options += [f"--with-gmp={prefix}"]
            if sdk:
                options += ["--disable-thread-safe"]
        if sdk:
            options += ["--host=wasm32-unknown-wasi"]
        run(f"{name}-configure", [arithmetic / "configure", *options], objects, env)
        run(f"{name}-build", ["make", f"-j{args.jobs}"], objects, env)
        run(f"{name}-install", ["make", "install"], objects, env)
        metadata[name]["library_sha256"] = digest(prefix / f"lib/lib{name}.a")
        headers = ("gmp.h", "gmpxx.h") if name == "gmp" else ("mpfr.h",)
        metadata[name]["headers"] = {header: digest(prefix / "include" / header) for header in headers}

    wraps = bitwuzla_dependencies(source)
    metadata["wraps"] = wraps
    cadical_wrap = wraps["cadical"]
    archive = output / cadical_wrap["source_filename"]
    run("cadical-download", ["curl", "--fail", "--location", "--output", archive, cadical_wrap["source_url"]])
    if digest(archive) != cadical_wrap["source_hash"]:
        raise ValueError("CaDiCaL wrap archive hash mismatch")
    unpacked = output / "cadical-extract"
    unpacked.mkdir()
    with tarfile.open(archive) as entries:
        entries.extractall(unpacked, filter="data")
    cadical = source / "subprojects" / cadical_wrap["directory"]
    shutil.move(unpacked / cadical_wrap["directory"], cadical)
    metadata.setdefault("dependencies", {})["cadical"] = {
        "url": cadical_wrap["source_url"], "archive_sha256": digest(archive),
        "licenses": {p.name: digest(p) for p in cadical.glob("LICENSE*") if p.is_file()}}
    if not metadata["dependencies"]["cadical"]["licenses"]:
        raise ValueError("Missing CaDiCaL license")
    symfpu = stage_dependency("symfpu", {"url": wraps["symfpu"]["url"],
                                         "commit": wraps["symfpu"]["revision"]}, output, metadata, run)
    symfpu_target = source / "subprojects/symfpu"
    shutil.move(symfpu, symfpu_target)
    for name, target in (("cadical", cadical), ("symfpu", symfpu_target)):
        overlay = source / "subprojects/packagefiles" / name
        files = sorted(p for p in overlay.rglob("*") if p.is_file())
        if not files or any(p.is_symlink() for p in files):
            raise ValueError("Missing or unsafe upstream Meson overlay")
        metadata["dependencies"][name]["overlay"] = {
            str(p.relative_to(overlay)): digest(p) for p in files}
        shutil.copytree(overlay, target, dirs_exist_ok=True)

    apply_source_patch("bitwuzla-gmp-limb-width.patch", source, output, metadata, run, "bitwuzla-limb-patch")
    if sdk:
        apply_source_patch("bitwuzla-wasi-exit.patch", source, output, metadata, run, "bitwuzla-exit-patch")
        apply_source_patch("cadical-wasi-process-boundary.patch", cadical, output, metadata, run, "cadical-process-patch")
        apply_source_patch("cadical-wasi-random-seed.patch", cadical, output, metadata, run, "cadical-random-patch")
        apply_source_patch("bitwuzla-wasi-time-limit.patch", source, output, metadata, run, "bitwuzla-time-limit-patch")
        apply_source_patch("bitwuzla-wasi-rss.patch", source, output, metadata, run, "bitwuzla-rss-patch")
        metadata["cadical_native_rss_available"] = False
        metadata["bitwuzla_native_rss_available"] = False
        metadata["cadical_process_clock"] = "WASI SDK wall-clock emulation, not native CPU time"

    machine = output / "meson-machine.ini"
    binaries = {"c": compiler, "cpp": compiler_cxx, "ar": env.get("AR", "ar"),
                "strip": str(sdk / "bin/llvm-strip") if sdk else "strip", "pkg-config": "pkg-config"}
    if sdk:
        adapter = output / "wasi-meson-compiler.py"
        shutil.copyfile(ROOT / "scripts/wasi-meson-compiler.py", adapter)
        metadata["meson_compiler_adapter_sha256"] = digest(adapter)
        binaries.update(c=[sys.executable, str(adapter), compiler], cpp=[sys.executable, str(adapter), compiler_cxx])
    settings = {"c_args": shlex.split(c_flags), "cpp_args": shlex.split(cxx_flags),
                "c_link_args": shlex.split(link_flags),
                "cpp_link_args": shlex.split(link_flags) + (["-lunwind", "-lsetjmp"] if sdk else shlex.split(args.cxx_libraries))}
    text = "[binaries]\n" + "".join(f"{key} = {value!r}\n" for key, value in binaries.items())
    text += "[built-in options]\n" + "".join(f"{key} = {value!r}\n" for key, value in settings.items())
    if sdk:
        text += "[host_machine]\nsystem = 'wasi'\ncpu_family = 'wasm32'\ncpu = 'wasm32'\nendian = 'little'\n"
        text += f"[properties]\nneeds_exe_wrapper = true\npkg_config_libdir = {str(prefix / 'lib/pkgconfig')!r}\n"
    machine.write_text(text)
    metadata["meson_machine_sha256"] = digest(machine)
    run("configure", [args.meson, "setup", output / "objects", source,
                      "--cross-file" if sdk else "--native-file", machine, "--wrap-mode=nodownload",
                      "-Dtesting=disabled", "-Dunit_testing=disabled", "-Ddefault_library=static",
                      "-Doptimization=2", "-Dstrip=false"], env=env)
    entries = json.loads((output / "objects/meson-info/intro-dependencies.json").read_text())
    metadata["meson_dependencies"] = check_bitwuzla_meson_dependencies(
        entries, prefix, {name: metadata[name]["version"] for name in ("gmp", "mpfr")})
    run("build", [args.meson, "compile", "-C", output / "objects", "-j", str(args.jobs), "-v"], env=env)
    metadata["libraries"] = {}
    for library in sorted((output / "objects").rglob("*.a")) + sorted((prefix / "lib").glob("*.a")):
        metadata["libraries"][str(library.relative_to(output))] = {
            "bytes": library.stat().st_size, "sha256": digest(library)}
    if not (output / "objects/subprojects" / cadical_wrap["directory"] / "src/libcadical.a").is_file():
        raise ValueError("Expected the staged CaDiCaL library, not a system dependency")
    return output / "objects/src/main/bitwuzla"


def build(args):
    output = args.out.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Diagnostic output already exists")
    output.mkdir(parents=True)
    metadata = {
        "format": 1, "purpose": __doc__, "solver": args.solver, "runtime": args.runtime,
        "script_sha256": digest(Path(__file__)), "commands": [], "patches": [],
        "status": "error", "started_unix": time.time(),
    }
    environment = {**os.environ, "LC_ALL": "C", "TZ": "UTC", "SOURCE_DATE_EPOCH": "0"}

    def run(label, command, cwd=output, env=None):
        if not label.replace("-", "").isalnum():
            raise ValueError("Invalid log label")
        record = {"label": label, "argv": [str(item) for item in command], "cwd": str(cwd)}
        selected_env = env or environment
        record["environment"] = {key: selected_env[key] for key in (
            "CC", "CXX", "AR", "RANLIB", "STRIP", "CPPFLAGS", "CFLAGS", "CXXFLAGS",
            "LDFLAGS", "LIBS", "LC_ALL", "TZ", "SOURCE_DATE_EPOCH",
            "GIT_CEILING_DIRECTORIES",
            "PKG_CONFIG_LIBDIR", "PKG_CONFIG_PATH",
        ) if key in selected_env}
        metadata["commands"].append(record)
        (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
        with (output / f"{label}.log").open("x") as log:
            log.write(shlex.join(record["argv"]) + "\n")
            log.flush()
            start = time.monotonic()
            result = subprocess.run(record["argv"], cwd=cwd, env=selected_env,
                                    stdout=log, stderr=log, check=False)
            record.update(exit_status=result.returncode, elapsed_seconds=time.monotonic() - start)
            record["log_sha256"] = digest(output / f"{label}.log")
            result.check_returncode()

    try:
        snapshot = output / "build-solver-probe.py"
        snapshot.write_bytes(Path(__file__).read_bytes())
        if digest(snapshot) != metadata["script_sha256"]:
            raise ValueError("Build driver changed while starting")
        metadata["script_snapshot"] = snapshot.name
        solver_pin = json.loads(pin("formal-pins"))[args.solver]
        metadata["source"] = solver_pin
        metadata["base_commit"] = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
        metadata["worktree_status"] = subprocess.check_output(["git", "-C", str(ROOT), "status", "--porcelain"], text=True)
        source = output / "source"
        stage_source(args.solver, solver_pin["commit"], source)
        for index, patch_name in enumerate(args.patch or []):
            patch = patch_name.resolve()
            metadata["patches"].append({"path": str(patch_name), "sha256": digest(patch)})
            run(f"patch-{index}", ["patch", "--batch", "--fuzz=0", "-p1", "-i", patch], cwd=source)
        c_flags = "-O2 -DNDEBUG -std=gnu17"
        link_flags = ""
        compiler = os.environ.get("CC", "gcc")
        compiler_cxx = os.environ.get("CXX", "g++")
        sdk = None
        if args.runtime == "wasi":
            version, archive_hash, asset, _url = pin("wasi-sdk-pin").split("\t")
            sdk = (ROOT / "build" / asset.removesuffix(".tar.gz")).resolve()
            archive = ROOT / "build/cache" / asset
            if digest(archive) != archive_hash or not (sdk / "bin/clang").is_file():
                raise ValueError("Missing or mismatched pinned WASI SDK")
            metadata["wasi_sdk"] = {"version": version, "archive_sha256": archive_hash}
            compiler = str(sdk / "bin/clang")
            compiler_cxx = str(sdk / "bin/clang++")
            c_flags += " -fwasm-exceptions -mllvm -wasm-enable-sjlj"
            c_flags += " -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN"
            link_flags = "-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman"
            link_flags += " -Wl,-z,stack-size=8388608 -Wl,--initial-memory=33554432 -Wl,--max-memory=536870912"
        metadata["compiler"] = subprocess.check_output([compiler, "--version"], text=True)
        if args.solver != "yices2":
            metadata["compiler_cxx"] = subprocess.check_output([compiler_cxx, "--version"], text=True)
        metadata["host"] = {"os": os.uname().sysname, "release": os.uname().release,
                            "machine": os.uname().machine, "cpus": os.cpu_count(),
                            "distribution": platform.freedesktop_os_release()}
        if args.solver == "z3":
            metadata["cmake"] = subprocess.check_output([args.cmake, "--version"], text=True)
            command = [args.cmake, "-S", source, "-B", output / "objects", "-DCMAKE_BUILD_TYPE=Release",
                       "-DBUILD_SHARED_LIBS=OFF", "-DZ3_SINGLE_THREADED=ON", "-DZ3_POLLING_TIMER=ON",
                       "-DZ3_USE_LIB_GMP=OFF", "-DZ3_BUILD_PYTHON_BINDINGS=OFF",
                       "-DZ3_BUILD_TEST_EXECUTABLES=OFF", "-DZ3_INCLUDE_GIT_HASH=OFF",
                       "-DZ3_INCLUDE_GIT_DESCRIBE=OFF", "-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG"]
            if args.runtime == "wasi":
                cxx_flags = c_flags.replace(" -std=gnu17", "")
                command += [f"-DCMAKE_TOOLCHAIN_FILE={sdk}/share/cmake/wasi-sdk-p1.cmake",
                            f"-DCMAKE_CXX_FLAGS={cxx_flags}", f"-DCMAKE_EXE_LINKER_FLAGS={link_flags}",
                            "-DCMAKE_CXX_STANDARD_LIBRARIES=-lunwind -lsetjmp"]
            else:
                command += [f"-DCMAKE_CXX_COMPILER={compiler_cxx}",
                            f"-DCMAKE_CXX_FLAGS={args.cxx_flags}",
                            f"-DCMAKE_EXE_LINKER_FLAGS={args.cxx_link_flags}",
                            f"-DCMAKE_CXX_STANDARD_LIBRARIES={args.cxx_libraries}"]
            run("configure", command)
            run("build", [args.cmake, "--build", output / "objects", "--target", "shell", "--parallel", str(args.jobs)])
            binary = output / "objects/z3"
        elif args.solver == "boolector":
            binary = build_boolector(args, output, source, metadata, run, environment,
                                     compiler, compiler_cxx, c_flags, link_flags, sdk)
        elif args.solver == "bitwuzla":
            binary = build_bitwuzla(args, output, source, metadata, run, environment,
                                    compiler, compiler_cxx, c_flags, link_flags, sdk)
        else:
            gmp_version, gmp_hash, gmp_asset, _url = pin("archive-pin", "gmp").split("\t")
            archive = ROOT / "vendor/formal-archives" / gmp_asset
            if not archive.exists():
                archive = ROOT / "build/cache" / gmp_asset
            if digest(archive) != gmp_hash:
                raise ValueError("GMP archive pin mismatch")
            metadata["gmp"] = {"version": gmp_version, "archive_sha256": gmp_hash}
            gmp_source = output / "gmp-source"
            gmp_source.mkdir()
            run("gmp-extract", ["tar", "-xJf", archive, "--strip-components=1", "-C", gmp_source])
            gmp_build = output / "gmp-objects"
            gmp_build.mkdir()
            prefix = output / "gmp-install"
            env = {**environment, "CC": compiler, "CFLAGS": c_flags, "LDFLAGS": link_flags}
            command = [gmp_source / "configure", f"--prefix={prefix}", "--disable-shared",
                       "--enable-static", "--disable-assembly"]
            if args.runtime == "wasi":
                env.update(AR=str(sdk / "bin/llvm-ar"), RANLIB=str(sdk / "bin/llvm-ranlib"))
                command += ["--host=wasm32-unknown-wasi"]
            run("gmp-configure", command, gmp_build, env)
            run("gmp-build", ["make", f"-j{args.jobs}"], gmp_build, env)
            run("gmp-install", ["make", "install"], gmp_build, env)
            metadata["gmp"]["library_sha256"] = digest(prefix / "lib/libgmp.a")
            env["CPPFLAGS"] = f"-I{prefix}/include"
            env["LDFLAGS"] = f"-L{prefix}/lib {link_flags}".strip()
            if args.runtime == "wasi":
                env["STRIP"] = str(sdk / "bin/llvm-strip")
                env["LIBS"] = "-lsetjmp"
            run("autoconf", ["autoconf"], source)
            command = [source / "configure", f"--with-static-gmp={prefix}/lib/libgmp.a",
                       f"--with-static-gmp-include-dir={prefix}/include", "--disable-mcsat",
                       "--disable-thread-safety"]
            if args.runtime == "wasi":
                command += ["--host=wasm32-unknown-wasi"]
            run("configure", command, source, env)
            command = ["make", f"-j{args.jobs}"]
            if args.runtime == "wasi":
                command += ["ARCH=wasm32-unknown-wasi"]
            run("build", [*command, "static-bin"], source, env)
            matches = list(source.glob("build/*/static_bin/yices_smt2"))
            if len(matches) != 1:
                raise ValueError("Expected exactly one Yices SMT2 diagnostic binary")
            binary = matches[0]
        metadata["artifact"] = {"path": str(binary.relative_to(output)), "bytes": binary.stat().st_size,
                                "sha256": digest(binary)}
        if args.runtime == "native":
            run("version", [binary, "--version"])
        metadata["status"] = "built"
    except Exception as error:
        metadata["error"] = str(error)
        raise
    finally:
        metadata["elapsed_seconds"] = time.time() - metadata["started_unix"]
        (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--solver", choices=("yices2", "z3", "boolector", "bitwuzla"), required=True)
    parser.add_argument("--runtime", choices=("native", "wasi"), required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cmake", default="cmake")
    parser.add_argument("--meson", default="meson")
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--patch", type=Path, action="append")
    parser.add_argument("--cxx-flags", default=os.environ.get("CXXFLAGS", ""))
    parser.add_argument("--cxx-link-flags", default="")
    parser.add_argument("--cxx-libraries", default="")
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("jobs must be positive")
    build(args)


if __name__ == "__main__":
    main()
