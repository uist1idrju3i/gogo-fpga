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

# Apicula's chipdb generator iterates hash-ordered sets; pin the seed so chipdb output is reproducible.
export PYTHONHASHSEED=0

for tool in cmake curl git node patch python3 sha256sum tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$tool" >&2
    exit 1
  fi
done

nextpnr_pin=$(python3 .github/scripts/check-pins.py nextpnr-pin)
old_ifs=$IFS
IFS=$(printf '\t')
read -r nextpnr_version nextpnr_commit _ <<EOF
$nextpnr_pin
EOF
IFS=$old_ifs
if [ -z "$nextpnr_version" ] || [ -z "$nextpnr_commit" ] || [ ! -f vendor/nextpnr/CMakeLists.txt ]; then
  printf 'nextpnr pin or source is missing.\n' >&2
  exit 1
fi
if git rev-parse --verify HEAD:vendor/nextpnr >/dev/null 2>&1; then
  checked_out_commit=$(git rev-parse HEAD:vendor/nextpnr)
elif [ -f vendor/nextpnr/.gitcommit ]; then
  checked_out_commit=$(tr -d '\r\n' < vendor/nextpnr/.gitcommit)
else
  printf 'nextpnr source has no gitlink or release marker.\n' >&2
  exit 1
fi
if [ "$checked_out_commit" != "$nextpnr_commit" ]; then
  printf 'nextpnr pin mismatch: expected %s, found %s\n' "$nextpnr_commit" "$checked_out_commit" >&2
  exit 1
fi

families=$(node --input-type=module -e '
  import { BOARDS } from "./web/lib/boards.mjs";
  console.log([...new Set(BOARDS.map((board) => board.nextpnrFamily))].join(" "));
')
expected_families='GW1NZ-1 GW1NS-4 GW1N-9C GW2A-18C'
if [ "$families" != "$expected_families" ]; then
  printf 'Unexpected Gowin families in web/lib/boards.mjs: %s\n' "$families" >&2
  exit 1
fi
gowin_devices=$(printf '%s' "$families" | tr ' ' ';')

cache_dir=build/cache
deps_dir=build/deps
wasi_boost_stage="$deps_dir/boost-stage-wasi-wasm-exceptions"
mkdir -p "$cache_dir" "$deps_dir"

download_verified() {
  archive=$1
  url=$2
  checksum=$3
  if [ ! -f "$archive" ]; then
    temporary_archive="$archive.tmp.$$"
    trap 'rm -f "$temporary_archive"' 0 HUP INT TERM
    curl --fail --location --retry 3 --output "$temporary_archive" "$url"
    if ! printf '%s  %s\n' "$checksum" "$temporary_archive" | sha256sum --check --status; then
      printf 'Downloaded archive SHA-256 mismatch: %s\n' "$archive" >&2
      exit 1
    fi
    mv "$temporary_archive" "$archive"
    trap - 0 HUP INT TERM
  fi
  if ! printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status; then
    printf 'Cached archive SHA-256 mismatch: %s\n' "$archive" >&2
    exit 1
  fi
}

read_archive_pin() {
  pin=$(python3 .github/scripts/check-pins.py archive-pin "$1")
  old_ifs=$IFS
  IFS=$(printf '\t')
  read -r pin_version pin_sha pin_asset pin_url <<EOF
$pin
EOF
  IFS=$old_ifs
  if [ -z "$pin_version" ] || [ -z "$pin_sha" ] || [ -z "$pin_asset" ] || [ -z "$pin_url" ]; then
    printf 'Incomplete archive pin for %s.\n' "$1" >&2
    exit 1
  fi
}

read_archive_pin boost
boost_version=$pin_version
boost_sha=$pin_sha
boost_asset=$pin_asset
boost_url=$pin_url
boost_archive="$cache_dir/$boost_asset"
boost_source="$deps_dir/boost-$boost_version"
download_verified "$boost_archive" "$boost_url" "$boost_sha"
if [ ! -f "$boost_source/boost/version.hpp" ]; then
  if [ -e "$boost_source" ]; then
    printf 'Incomplete Boost source tree: %s\n' "$boost_source" >&2
    exit 1
  fi
  mkdir "$boost_source"
  tar -xJf "$boost_archive" --strip-components=1 -C "$boost_source"
fi

read_archive_pin eigen
eigen_version=$pin_version
eigen_sha=$pin_sha
eigen_asset=$pin_asset
eigen_url=$pin_url
eigen_archive="$cache_dir/$eigen_asset"
eigen_source="$deps_dir/eigen-$eigen_version"
download_verified "$eigen_archive" "$eigen_url" "$eigen_sha"
if [ ! -f "$eigen_source/Eigen/Core" ] || [ ! -f "$eigen_source/cmake/Eigen3Config.cmake.in" ]; then
  if [ -e "$eigen_source" ]; then
    printf 'Incomplete Eigen source tree: %s\n' "$eigen_source" >&2
    exit 1
  fi
  mkdir "$eigen_source"
  tar -xzf "$eigen_archive" --strip-components=1 -C "$eigen_source"
fi

eigen_build="$deps_dir/eigen-build"
if [ ! -f "$eigen_build/Eigen3Config.cmake" ]; then
  cmake -S "$eigen_source" -B "$eigen_build" \
    -DBUILD_TESTING=OFF \
    -DEIGEN_BUILD_TESTING=OFF \
    -DEIGEN_BUILD_BLAS=OFF \
    -DEIGEN_BUILD_LAPACK=OFF \
    -DEIGEN_BUILD_BTL=OFF \
    -DEIGEN_BUILD_DOC=OFF \
    -DEIGEN_BUILD_DEMOS=OFF \
    -DEIGEN_BUILD_CMAKE_PACKAGE=ON
fi

boost_b2="$root/$boost_source/tools/build/src/engine/b2"
if [ ! -x "$boost_b2" ]; then
  (
    cd "$boost_source"
    ./bootstrap.sh --with-toolset=gcc
  )
fi

build_boost() {
  boost_mode=$1
  stage_dir="$deps_dir/boost-stage-$boost_mode"
  source_dir=$boost_source
  b2=$boost_b2
  if [ "$boost_mode" = wasi ]; then
    stage_dir=$wasi_boost_stage
    source_dir="$deps_dir/boost-wasi-$boost_version"
    if [ ! -f "$source_dir/boost/version.hpp" ]; then
      if [ -e "$source_dir" ]; then
        printf 'Incomplete Boost WASI source tree: %s\n' "$source_dir" >&2
        exit 1
      fi
      mkdir "$source_dir"
      tar -xJf "$boost_archive" --strip-components=1 -C "$source_dir"
    fi
    b2="$root/$source_dir/tools/build/src/engine/b2"
    if [ ! -x "$b2" ]; then
      (
        cd "$source_dir"
        ./bootstrap.sh --with-toolset=gcc
      )
    fi
  fi
  if [ -f "$stage_dir/lib/libboost_program_options.a" ] &&
    [ -f "$stage_dir/lib/libboost_iostreams.a" ]; then
    return
  fi
  mkdir -p "$stage_dir"
  if [ "$boost_mode" = wasi ]; then
    wasi_pin=$(python3 .github/scripts/check-pins.py wasi-sdk-pin)
    old_ifs=$IFS
    IFS=$(printf '\t')
    read -r _ wasi_sha wasi_asset wasi_url <<EOF
$wasi_pin
EOF
    IFS=$old_ifs
    sdk_dir="build/${wasi_asset%.tar.gz}"
    sdk_archive="$cache_dir/$wasi_asset"
    download_verified "$sdk_archive" "$wasi_url" "$wasi_sha"
    if [ ! -x "$sdk_dir/bin/clang++" ]; then
      if [ -e "$sdk_dir" ]; then
        printf 'Incomplete WASI SDK installation: %s\n' "$sdk_dir" >&2
        exit 1
      fi
      tar -xzf "$sdk_archive" -C build
    fi
    wasi_sdk="$root/$sdk_dir"
    wasi_jam="$root/$deps_dir/boost-wasi-config.jam"
    {
      printf 'using clang : : %s/bin/clang++ --target=wasm32-wasip1 --sysroot=%s/share/wasi-sysroot -D_WASI_EMULATED_MMAN -fwasm-exceptions -ffile-prefix-map=%s=/src -ffile-prefix-map=%s=/boost :\n' "$wasi_sdk" "$wasi_sdk" "$root" "$root/$source_dir"
      printf '  <archiver>%s/bin/llvm-ar\n' "$wasi_sdk"
      printf '  <ranlib>%s/bin/llvm-ranlib\n' "$wasi_sdk"
      printf '  <linkflags>--target=wasm32-wasip1\n'
      printf '  <linkflags>--sysroot=%s/share/wasi-sysroot\n' "$wasi_sdk"
      printf '  <linkflags>-lwasi-emulated-mman\n'
      printf '  ;\n'
    } > "$wasi_jam"
    (
      cd "$source_dir"
      "$b2" --user-config="$wasi_jam" toolset=clang \
        variant=release link=static threading=single runtime-link=static \
        -sNO_COMPRESSION=1 -sNO_ZLIB=1 -sNO_BZIP2=1 \
        --with-program_options --with-iostreams \
        --stagedir="$root/$stage_dir" -j "${JOBS:-2}" stage
    )
  else
    (
      cd "$source_dir"
      "$b2" toolset=gcc variant=release link=static threading=single \
        -sNO_COMPRESSION=1 -sNO_ZLIB=1 -sNO_BZIP2=1 \
        --with-program_options --with-iostreams \
        --stagedir="$root/$stage_dir" -j "${JOBS:-2}" stage
    )
  fi
  if [ ! -f "$stage_dir/lib/libboost_program_options.a" ] ||
    [ ! -f "$stage_dir/lib/libboost_iostreams.a" ]; then
    printf 'Boost did not produce the required static libraries (%s).\n' "$boost_mode" >&2
    exit 1
  fi
}

build_boost native
if [ "$mode" = wasi ]; then
  build_boost wasi
fi

apycula_venv="$deps_dir/apycula-venv"
if [ ! -x "$apycula_venv/bin/python" ]; then
  python3 -m venv "$apycula_venv"
fi
"$apycula_venv/bin/python" -m pip install --disable-pip-version-check --require-hashes \
  -r requirements-nextpnr.txt
"$apycula_venv/bin/python" -m pip check
apycula_version=$("$apycula_venv/bin/python" -c 'from importlib.metadata import version; print(version("apycula"))')
locked_apycula_version=$(python3 -c '
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("check_pins", ".github/scripts/check-pins.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
print(module.parse_apycula_requirements(open("requirements-nextpnr.txt", encoding="utf-8").read())[0])
')
if [ "$apycula_version" != "$locked_apycula_version" ]; then
  printf 'Apycula version mismatch: lock %s, installed %s\n' "$locked_apycula_version" "$apycula_version" >&2
  exit 1
fi

jobs=${JOBS:-2}
native_build=build/native/nextpnr
mkdir -p "$(dirname "$native_build")"
native_chipdb_root=$(CDPATH='' cd "$(dirname "$native_build")" && pwd)/nextpnr/share
native_prefix_flags="-I$root/$boost_source -ffile-prefix-map=$root=/src -ffile-prefix-map=$root/$native_build=/build -ffile-prefix-map=$root/$boost_source=/boost -ffile-prefix-map=$root/$eigen_source=/eigen -DNPNR_DISABLE_THREADS"
cmake -S vendor/nextpnr -B "$native_build" \
  -DCMAKE_PROJECT_INCLUDE="$root/scripts/nextpnr-patches.cmake" \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="$native_prefix_flags" \
  -DCMAKE_DISABLE_FIND_PACKAGE_Threads=ON \
  -DBUILD_GUI=OFF \
  -DBUILD_PYTHON=OFF \
  -DBUILD_RUST=OFF \
  -DBUILD_TESTS=OFF \
  -DUSE_OPENMP=OFF \
  -DSTATIC_BUILD=ON \
  -DEXTERNAL_CHIPDB=ON \
  -DEXTERNAL_CHIPDB_ROOT="$native_chipdb_root" \
  -DARCH=himbaechel \
  -DHIMBAECHEL_UARCH=gowin \
  -DHIMBAECHEL_SPLIT=ON \
  -DHIMBAECHEL_GOWIN_DEVICES="$gowin_devices" \
  -DBoost_NO_BOOST_CMAKE=ON \
  -DBoost_USE_STATIC_LIBS=ON \
  -DBOOST_ROOT="$root/$boost_source" \
  -DBOOST_LIBRARYDIR="$root/$deps_dir/boost-stage-native/lib" \
  -DEigen3_DIR="$root/$eigen_build" \
  -DAPYCULA_INSTALL_PREFIX="$root/$apycula_venv"
cmake --build "$native_build" --target bbasm --parallel "$jobs"
cmake --build "$native_build" --target nextpnr-himbaechel-gowin-bba --parallel "$jobs"

if [ "$mode" = native ]; then
  cmake --build "$native_build" --target nextpnr-himbaechel-gowin --parallel "$jobs"
  binary="$native_build/nextpnr-himbaechel-gowin"
  if [ ! -f "$binary" ]; then
    printf 'Native nextpnr output is missing: %s\n' "$binary" >&2
    exit 1
  fi
  python3 scripts/build-pnr-info.py --mode native --binary "$binary" \
    --build-dir "$native_build" --output "$native_build/build-info.json"
  printf 'native nextpnr build completed: %s bytes\n' "$(wc -c < "$binary" | tr -d '[:space:]')"
  exit 0
fi

wasi_pin=$(python3 .github/scripts/check-pins.py wasi-sdk-pin)
old_ifs=$IFS
IFS=$(printf '\t')
read -r _ wasi_sha wasi_asset wasi_url <<EOF
$wasi_pin
EOF
IFS=$old_ifs
sdk_dir="build/${wasi_asset%.tar.gz}"
sdk_archive="$cache_dir/$wasi_asset"
download_verified "$sdk_archive" "$wasi_url" "$wasi_sha"
if [ ! -x "$sdk_dir/bin/clang++" ] || [ ! -f "$sdk_dir/share/cmake/wasi-sdk-p1.cmake" ]; then
  printf 'WASI SDK installation is incomplete: %s\n' "$sdk_dir" >&2
  exit 1
fi

wasi_build=${WASI_BUILD_DIR:-build/wasi/nextpnr}
case "$wasi_build" in
  /*)
    printf 'WASI_BUILD_DIR must be relative to the repository root: %s\n' "$wasi_build" >&2
    exit 1
    ;;
esac
WASI_OPT_FLAGS=${WASI_OPT_FLAGS--Os}
WASI_EXTRA_CFLAGS=${WASI_EXTRA_CFLAGS--flto}
WASI_EXTRA_CXXFLAGS=${WASI_EXTRA_CXXFLAGS--flto}
WASI_EXTRA_LDFLAGS=${WASI_EXTRA_LDFLAGS--flto}
WASI_USE_IPO=${WASI_USE_IPO-OFF}
c_flags="-I$root/$boost_source -ffile-prefix-map=$root=/src -ffile-prefix-map=$root/$wasi_build=/build -ffile-prefix-map=$root/$sdk_dir=/wasi-sdk -ffile-prefix-map=$boost_source=/boost -ffile-prefix-map=$eigen_source=/eigen -DNPNR_DISABLE_THREADS"
cxx_flags="$c_flags -fwasm-exceptions"
linker_flags="-fwasm-exceptions -Wl,-z,stack-size=8388608 -lwasi-emulated-mman -Wl,--whole-archive -lunwind -Wl,--no-whole-archive"
set --
if [ -n "${WASI_USE_IPO:-}" ]; then
  case "$WASI_USE_IPO" in
    ON|OFF) ;;
    *)
      printf 'WASI_USE_IPO must be ON or OFF: %s\n' "$WASI_USE_IPO" >&2
      exit 1
      ;;
  esac
  set -- "-DUSE_IPO=$WASI_USE_IPO"
fi
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
  cmake "$@" \
    -DCMAKE_PROJECT_INCLUDE="$root/scripts/nextpnr-patches.cmake" \
    -DWASI_OPT_FLAGS="$WASI_OPT_FLAGS"
}
run_cmake -S vendor/nextpnr -B "$wasi_build" \
  -DCMAKE_TOOLCHAIN_FILE="$root/$sdk_dir/share/cmake/wasi-sdk-p1.cmake" \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$c_flags" \
  -DCMAKE_CXX_FLAGS="$cxx_flags" \
  -DCMAKE_EXE_LINKER_FLAGS="$linker_flags" \
  "$@" \
  -DCMAKE_DISABLE_FIND_PACKAGE_Threads=ON \
  -DBUILD_GUI=OFF \
  -DBUILD_PYTHON=OFF \
  -DBUILD_RUST=OFF \
  -DBUILD_TESTS=OFF \
  -DUSE_OPENMP=OFF \
  -DSTATIC_BUILD=ON \
  -DEXTERNAL_CHIPDB=ON \
  -DEXTERNAL_CHIPDB_ROOT=/share \
  -DBBA_IMPORT="$root/$native_build/bba-export.cmake" \
  -DIMPORT_BBA_FILES="$root/$native_build" \
  -DARCH=himbaechel \
  -DHIMBAECHEL_UARCH=gowin \
  -DHIMBAECHEL_SPLIT=ON \
  -DHIMBAECHEL_GOWIN_DEVICES="$gowin_devices" \
  -DBoost_NO_BOOST_CMAKE=ON \
  -DBoost_USE_STATIC_LIBS=ON \
  -DBOOST_ROOT="$root/$boost_source" \
  -DBOOST_LIBRARYDIR="$root/$wasi_boost_stage/lib" \
  -DEigen3_DIR="$root/$eigen_build" \
  -DAPYCULA_INSTALL_PREFIX="$root/$apycula_venv"
cmake --build "$wasi_build" --target nextpnr-himbaechel-gowin --parallel "$jobs"
binary="$wasi_build/nextpnr-himbaechel-gowin.wasm"
if [ ! -f "$binary" ]; then
  printf 'WASI nextpnr output is missing: %s\n' "$binary" >&2
  exit 1
fi
for family in $families; do
  chipdb="$wasi_build/share/himbaechel/gowin/chipdb-$family.bin"
  if [ ! -s "$chipdb" ]; then
    printf 'Generated Gowin chipdb is missing or empty: %s\n' "$chipdb" >&2
    exit 1
  fi
done
python3 scripts/build-pnr-info.py --mode wasi --binary "$binary" \
  --build-dir "$wasi_build" --output "$wasi_build/build-info.json"
printf 'WASI nextpnr build completed: %s bytes\n' "$(wc -c < "$binary" | tr -d '[:space:]')"
