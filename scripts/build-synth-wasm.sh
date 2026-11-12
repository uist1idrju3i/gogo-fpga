#!/bin/sh
set -eu

usage() {
  printf 'Usage: %s [--native]\n' "${0##*/}" >&2
  exit 2
}

mode=wasi
if [ "$#" -gt 1 ]; then
  usage
fi
if [ "$#" -eq 1 ]; then
  [ "$1" = "--native" ] || usage
  mode=native
fi

root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
cd "$root"

for tool in cmake git python3 sha256sum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$tool" >&2
    exit 1
  fi
done

yosys_pin=$(python3 .github/scripts/check-pins.py yosys-pin)
old_ifs=$IFS
IFS=$(printf '\t')
read -r yosys_version yosys_commit yosys_url <<EOF
$yosys_pin
EOF
IFS=$old_ifs
if [ -z "$yosys_version" ] || [ -z "$yosys_url" ]; then
  printf 'Yosys pin is incomplete in RESEARCH.md.\n' >&2
  exit 1
fi
if [ -e vendor/yosys/.git ]; then
  checked_out_commit=$(git -C vendor/yosys rev-parse HEAD)
elif [ -f vendor/yosys/.gitcommit ]; then
  checked_out_commit=$(tr -d '\r\n' < vendor/yosys/.gitcommit)
else
  printf 'Yosys submodule is not initialized and has no release source marker.\n' >&2
  exit 1
fi
if [ "$checked_out_commit" != "$yosys_commit" ]; then
  printf 'Yosys pin mismatch: expected %s, found %s\n' "$yosys_commit" "$checked_out_commit" >&2
  exit 1
fi
if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
  SOURCE_DATE_EPOCH=$(git -C vendor/yosys log -1 --format=%ct)
fi
export SOURCE_DATE_EPOCH

for required_path in \
  vendor/yosys/abc/CMakeLists.txt \
  vendor/yosys/libs/cxxopts/CMakeLists.txt \
  vendor/yosys/libs/fmt/CMakeLists.txt \
  vendor/yosys/libs/tomlplusplus/CMakeLists.txt \
  vendor/yosys/libs/boost_regex/CMakeLists.txt \
  vendor/yosys/libs/symfpu/LICENSE; do
  if [ ! -e "$required_path" ]; then
    printf 'Required Yosys source is missing: %s\n' "$required_path" >&2
    exit 1
  fi
done

build_dir=
start_time=$(date +%s)
if [ "$mode" = wasi ]; then
  WASI_OPT_FLAGS=${WASI_OPT_FLAGS--Os}
  WASI_EXTRA_CFLAGS=${WASI_EXTRA_CFLAGS--flto}
  WASI_EXTRA_CXXFLAGS=${WASI_EXTRA_CXXFLAGS--flto}
  WASI_EXTRA_LDFLAGS=${WASI_EXTRA_LDFLAGS--flto}
  for tool in curl tar; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf 'Required command not found: %s\n' "$tool" >&2
      exit 1
    fi
  done

  wasi_pin=$(python3 .github/scripts/check-pins.py wasi-sdk-pin)
  old_ifs=$IFS
  IFS=$(printf '\t')
  read -r wasi_version wasi_sha wasi_asset wasi_url <<EOF
$wasi_pin
EOF
  IFS=$old_ifs
  if [ -z "$wasi_version" ] || [ -z "$wasi_sha" ] || [ -z "$wasi_asset" ] || [ -z "$wasi_url" ]; then
    printf 'WASI SDK pin is incomplete in RESEARCH.md.\n' >&2
    exit 1
  fi
  sdk_dir="build/${wasi_asset%.tar.gz}"
  cache_dir=build/cache
  archive="$cache_dir/$wasi_asset"
  mkdir -p "$cache_dir"
  if [ ! -f "$archive" ]; then
    temporary_archive="$archive.tmp.$$"
    trap 'rm -f "$temporary_archive"' 0 HUP INT TERM
    curl --fail --location --retry 3 --output "$temporary_archive" "$wasi_url"
    mv "$temporary_archive" "$archive"
    trap - 0 HUP INT TERM
  fi
  if ! printf '%s  %s\n' "$wasi_sha" "$archive" | sha256sum --check --status; then
    printf 'WASI SDK archive SHA-256 mismatch: %s\n' "$archive" >&2
    exit 1
  fi
  if [ -d "$sdk_dir" ] &&
    { [ ! -x "$sdk_dir/bin/clang" ] || [ ! -x "$sdk_dir/bin/clang++" ] || [ ! -f "$sdk_dir/share/cmake/wasi-sdk-p1.cmake" ]; }; then
    rm -rf "$sdk_dir"
  fi
  if [ ! -d "$sdk_dir" ]; then
    tar -xzf "$archive" -C build
  fi
  toolchain_file="$root/$sdk_dir/share/cmake/wasi-sdk-p1.cmake"
  if [ ! -x "$sdk_dir/bin/clang" ] || [ ! -x "$sdk_dir/bin/clang++" ] || [ ! -f "$toolchain_file" ]; then
    printf 'WASI SDK installation is incomplete: %s\n' "$sdk_dir" >&2
    exit 1
  fi
  build_dir=${WASI_BUILD_DIR:-build/wasi/yosys}
  case "$build_dir" in
    /*)
      printf 'WASI_BUILD_DIR must be relative to the repository root: %s\n' "$build_dir" >&2
      exit 1
      ;;
  esac
  cmake_binary="$build_dir/yosys"
  prefix_flags="-ffile-prefix-map=$root=/src -ffile-prefix-map=$root/$build_dir=/build -ffile-prefix-map=$root/$sdk_dir=/wasi-sdk"
  c_flags=$prefix_flags
  cxx_flags=$prefix_flags
  linker_flags="-Wl,-z,stack-size=8388608"
  if [ -n "${WASI_EXTRA_CFLAGS:-}" ]; then
    c_flags="$c_flags $WASI_EXTRA_CFLAGS"
  fi
  if [ -n "${WASI_EXTRA_CXXFLAGS:-}" ]; then
    cxx_flags="$cxx_flags $WASI_EXTRA_CXXFLAGS"
  fi
  if [ -n "${WASI_EXTRA_LDFLAGS:-}" ]; then
    linker_flags="$linker_flags $WASI_EXTRA_LDFLAGS"
  fi
  run_cmake() {
    if [ -n "${WASI_OPT_FLAGS:-}" ]; then
      cmake "$@" \
        -DCMAKE_PROJECT_INCLUDE="$root/scripts/s5-wasi-opt-flags.cmake" \
        -DWASI_OPT_FLAGS="$WASI_OPT_FLAGS"
    else
      cmake "$@"
    fi
  }
  run_cmake -S vendor/yosys -B "$build_dir" \
    -DCMAKE_TOOLCHAIN_FILE="$toolchain_file" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$c_flags" \
    -DCMAKE_CXX_FLAGS="$cxx_flags" \
    -DCMAKE_EXE_LINKER_FLAGS="$linker_flags" \
    -DYOSYS_WITHOUT_SLANG=ON \
    -DYOSYS_WITHOUT_TCL=ON \
    -DYOSYS_WITHOUT_READLINE=ON \
    -DYOSYS_WITHOUT_EDITLINE=ON \
    -DYOSYS_WITHOUT_LIBFFI=ON \
    -DYOSYS_WITHOUT_ZLIB=ON \
    -DYOSYS_DISABLE_THREADS=ON \
    -DBUILD_SHARED_LIBS=OFF \
    -DYOSYS_ENABLE_UNIT_TESTS=OFF
else
  build_dir=build/native
  prefix_flags="-ffile-prefix-map=$root=/src -ffile-prefix-map=$root/$build_dir=/build"
  cmake -S vendor/yosys -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$prefix_flags" \
    -DCMAKE_CXX_FLAGS="$prefix_flags" \
    -DYOSYS_WITHOUT_SLANG=ON \
    -DYOSYS_WITHOUT_TCL=ON \
    -DYOSYS_WITHOUT_READLINE=ON \
    -DYOSYS_WITHOUT_EDITLINE=ON \
    -DYOSYS_WITHOUT_LIBFFI=ON \
    -DYOSYS_WITHOUT_ZLIB=ON \
    -DYOSYS_DISABLE_THREADS=ON \
    -DBUILD_SHARED_LIBS=OFF \
    -DYOSYS_ENABLE_UNIT_TESTS=OFF
fi

cmake --build "$build_dir" --parallel "${JOBS:-2}"
if [ "$mode" = wasi ]; then
  if [ ! -f "$cmake_binary" ]; then
    printf 'WASI CMake output is missing: %s\n' "$cmake_binary" >&2
    exit 1
  fi
  mv "$cmake_binary" "$build_dir/yosys.wasm"
  binary="$build_dir/yosys.wasm"
else
  binary="$build_dir/yosys"
fi
if [ ! -f "$binary" ]; then
  printf 'Build output is missing: %s\n' "$binary" >&2
  exit 1
fi
if [ ! -d "$build_dir/share/gowin" ]; then
  printf 'Gowin runtime data is missing: %s/share/gowin\n' "$build_dir" >&2
  exit 1
fi
python3 scripts/build-synth-info.py \
  --mode "$mode" \
  --binary "$binary" \
  --output "$build_dir/build-info.json"
end_time=$(date +%s)
printf '%s build completed in %s seconds: %s bytes\n' \
  "$mode" "$((end_time - start_time))" "$(wc -c < "$binary" | tr -d '[:space:]')"
