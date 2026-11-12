#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s [--async=jspi|asyncify] [--variant=ID[+FACTOR...]]\n' "${0##*/}" >&2
  printf 'Base profiles: B = -Os without LTO (S1b baseline); C = -Os + LTOA for JSPI (S7 adopted default)\n' >&2
  printf 'S1b factors: O2, O3, Oz, LTOL, LTOA, EHX, MG, M64, DL, MI, CL, EC, TD2, DE0, ST1M, P2P, SIMD\n' >&2
  exit 2
}

async_mode=jspi
async_seen=false
variant_id=
variant_seen=false
for arg in "$@"; do
  case "$arg" in
    --async=jspi|--async=asyncify)
      [[ "$async_seen" == false ]] || usage
      async_mode="${arg#*=}"
      async_seen=true
      ;;
    --variant=*)
      [[ "$variant_seen" == false ]] || usage
      variant_id="${arg#*=}"
      [[ "$variant_id" =~ ^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$ ]] || usage
      variant_seen=true
      ;;
    *) usage ;;
  esac
done

for tool in autoreconf aclocal autoconf automake libtoolize; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required Autotools command not found: %s\n' "$tool" >&2
    exit 1
  fi
  if ! "$tool" --version >/dev/null 2>&1; then
    printf 'Autotools command is unusable: %s (%s --version failed); use a consistent Autotools installation.\n' \
      "$(command -v "$tool")" "$tool" >&2
    exit 1
  fi
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_root="${BUILD_ROOT:-$root/build}"
if [[ "$build_root" != /* ]]; then
  build_root="$root/$build_root"
fi
default_variant_id=C
if [[ "$variant_seen" == false ]]; then
  variant_id="$default_variant_id"
  if [[ "$async_mode" == jspi ]]; then
    out="$build_root/jspi-pthread"
  else
    out="$build_root/asyncify-pthread"
  fi
elif [[ "$async_mode" == jspi ]]; then
  out="$build_root/$variant_id"
else
  printf 'Candidate profiles are only defined for --async=jspi.\n' >&2
  exit 2
fi

if [[ "$async_mode" == jspi ]]; then
  :
else
  if [[ "$variant_seen" == true ]]; then
    printf 'Candidate profiles are only defined for --async=jspi.\n' >&2
    exit 2
  fi
  variant_id=B
fi
[[ ! -e "$out" ]] || {
  printf 'Build output already exists: %s\n' "$out" >&2
  exit 1
}

opt=Os
lto=none
legacy_exceptions=1
allow_memory_growth=0
initial_memory=33554432
maximum_memory=
malloc=emmalloc
closure=0
eval_ctors=0
textdecoder=1
dynamic_execution=1
stack_size=
proxy_to_pthread=0
simd=0
opt_factors=0
lto_factors=0
malloc_factors=0
memory_factors=0
base_seen=
IFS=+ read -r -a profile_parts <<< "$variant_id"
for factor in "${profile_parts[@]}"; do
  case "$factor" in
    # C is S7's adopted -Os + LTOA profile for JSPI; asyncify keeps the S1b baseline.
    B|C)
      [[ -z "$base_seen" ]] || {
        printf 'A profile may name only one base (B or C): %s\n' "$variant_id" >&2
        exit 2
      }
      base_seen="$factor"
      if [[ "$factor" == C && "$async_mode" == jspi ]]; then
        lto=all
      fi
      ;;
    O2|O3|Oz)
      ((opt_factors += 1))
      opt="$factor"
      ;;
    LTOL) ((lto_factors += 1)); lto=loader ;;
    LTOA) ((lto_factors += 1)); lto=all ;;
    EHX) legacy_exceptions=0 ;;
    MG)
      ((memory_factors += 1))
      allow_memory_growth=1
      initial_memory=16777216
      maximum_memory=268435456
      ;;
    M64) ((memory_factors += 1)); initial_memory=67108864 ;;
    DL) ((malloc_factors += 1)); malloc=dlmalloc ;;
    MI) ((malloc_factors += 1)); malloc=mimalloc ;;
    CL) closure=1 ;;
    EC) eval_ctors=1 ;;
    TD2) textdecoder=2 ;;
    DE0) dynamic_execution=0 ;;
    ST1M) stack_size=1048576 ;;
    P2P) proxy_to_pthread=1 ;;
    SIMD) simd=1 ;;
    *) printf 'Unknown candidate factor: %s\n' "$factor" >&2; exit 2 ;;
  esac
done
if (( opt_factors > 1 || lto_factors > 1 || malloc_factors > 1 || memory_factors > 1 )); then
  printf 'Conflicting candidate factors in profile: %s\n' "$variant_id" >&2
  exit 2
fi

mkdir -p "$out"
exec > >(tee "$out/build.log") 2>&1
release_source_mode=false
if [[ ! -e "$root/.git" && -f "$root/RELEASE-SOURCE.json" ]]; then
  release_source_mode=true
  printf 'Release-source mode is on.\n'
fi
set -x

jobs="${JOBS:-$(getconf _NPROCESSORS_ONLN)}"
prefix="$out/prefix"
if [[ "$release_source_mode" == true ]]; then
  release_source_values="$(python3 - "$root/RELEASE-SOURCE.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
epoch = manifest.get("source_date_epoch")
version = manifest.get("emsdk_version")
if not isinstance(epoch, int) or epoch < 0:
    raise SystemExit("release-source source_date_epoch must be a non-negative integer")
if not isinstance(version, str) or not version:
    raise SystemExit("release-source emsdk_version must be a non-empty string")
print(f"{epoch}\t{version}")
PY
)"
  IFS=$'\t' read -r source_date_epoch emsdk_version <<< "$release_source_values"
else
  source_date_epoch="$(git -C "$root" log -1 --format=%ct)"
  emsdk_version="$(git -C "$root/vendor/emsdk" describe --tags --exact-match)"
fi
export SOURCE_DATE_EPOCH="$source_date_epoch"

emsdk_root="$root/build/emsdk-$emsdk_version"
if [[ ! -x "$emsdk_root/emsdk" ]]; then
  mkdir -p "$emsdk_root"
  if [[ "$release_source_mode" == true ]]; then
    cp -R "$root/vendor/emsdk/." "$emsdk_root/"
  else
    git -C "$root/vendor/emsdk" archive HEAD | tar -x -C "$emsdk_root"
  fi
fi
"$emsdk_root/emsdk" install "$emsdk_version"
"$emsdk_root/emsdk" activate "$emsdk_version"
# shellcheck source=/dev/null
source "$emsdk_root/emsdk_env.sh"

prefix_map_flags=(
  "-ffile-prefix-map=$root=/src"
  "-ffile-prefix-map=$build_root=/build"
  "-ffile-prefix-map=$emsdk_root=/emsdk"
)
prefix_map_string="${prefix_map_flags[*]}"
deps_c_flags="-$opt $prefix_map_string -pthread"
deps_link_flags="$prefix_map_string"
if [[ "$async_mode" == jspi ]]; then
  deps_c_flags="$deps_c_flags -fwasm-exceptions"
else
  deps_c_flags="$deps_c_flags -fexceptions"
fi
loader_c_flags="$deps_c_flags"
link_flags=()
if [[ "$lto" == all ]]; then
  deps_c_flags="$deps_c_flags -flto"
  loader_c_flags="$loader_c_flags -flto"
  link_flags+=(-flto)
elif [[ "$lto" == loader ]]; then
  loader_c_flags="$loader_c_flags -flto"
  link_flags+=(-flto)
fi
if [[ "$simd" == 1 ]]; then
  deps_c_flags="$deps_c_flags -msimd128"
  loader_c_flags="$loader_c_flags -msimd128"
  link_flags+=(-msimd128)
fi
link_flags=(
  "${link_flags[@]}"
  "${prefix_map_flags[@]}"
  -pthread
  -lembind
  -s STRICT=1
  -s INVOKE_RUN=0
  -s EXIT_RUNTIME=1
  "-s MALLOC=$malloc"
  "-s INITIAL_MEMORY=$initial_memory"
  "-s EXPORTED_RUNTIME_METHODS=FS,stackAlloc,stringToUTF8OnStack,ccall,callMain"
  "-s EXPORTED_FUNCTIONS=_main,_fflush"
  -s MODULARIZE=1
  -s EXPORT_NAME=instantiate
  -s EXPORT_ES6=1
  "-s ENVIRONMENT=worker,node"
  "-s TEXTDECODER=$textdecoder"
  "-s WASM_LEGACY_EXCEPTIONS=$legacy_exceptions"
)
if [[ "$allow_memory_growth" == 1 ]]; then
  link_flags+=(-s ALLOW_MEMORY_GROWTH=1 "-s MAXIMUM_MEMORY=$maximum_memory")
fi
if [[ "$closure" == 1 ]]; then link_flags+=(--closure 1); fi
if [[ "$eval_ctors" == 1 ]]; then link_flags+=(-s EVAL_CTORS=1); fi
if [[ "$dynamic_execution" == 0 ]]; then link_flags+=(-s DYNAMIC_EXECUTION=0); fi
if [[ -n "$stack_size" ]]; then link_flags+=("-s STACK_SIZE=$stack_size"); fi
if [[ "$proxy_to_pthread" == 1 ]]; then link_flags+=(-s PROXY_TO_PTHREAD=1); fi
if [[ "$async_mode" == jspi ]]; then
  link_flags+=(-fwasm-exceptions -s JSPI=1)
else
  link_flags+=(-s ASYNCIFY=1 -s DISABLE_EXCEPTION_CATCHING=0)
fi
link_string="${link_flags[*]}"

mkdir -p "$prefix"
emcmake cmake \
  -S "$root/vendor/zlib" \
  -B "$out/zlib-build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS_RELEASE= \
  -DCMAKE_CXX_FLAGS_RELEASE= \
  -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_C_FLAGS="$deps_c_flags" \
  -DCMAKE_CXX_FLAGS="$deps_c_flags" \
  -DCMAKE_EXE_LINKER_FLAGS="$deps_link_flags" \
  -DCMAKE_MODULE_LINKER_FLAGS="$deps_link_flags" \
  -DCMAKE_SHARED_LINKER_FLAGS="$deps_link_flags" \
  -DZLIB_BUILD_EXAMPLES=OFF \
  -DZLIB_BUILD_TESTING=OFF \
  -DZLIB_BUILD_SHARED=OFF \
  -DZLIB_BUILD_STATIC=ON
emmake make -C "$out/zlib-build" -j"$jobs"
emmake make -C "$out/zlib-build" install

libusb_source="$out/libusb-source"
libusb_build="$out/libusb-build"
mkdir -p "$libusb_source" "$libusb_build"
if [[ "$release_source_mode" == true ]]; then
  cp -R "$root/vendor/libusb/." "$libusb_source/"
else
  git -C "$root/vendor/libusb" archive HEAD | tar -x -C "$libusb_source"
fi
(
  cd "$libusb_source"
  ./bootstrap.sh
)
(
  cd "$libusb_build"
  CFLAGS="$deps_c_flags" \
  CXXFLAGS="$deps_c_flags" \
  LDFLAGS="-pthread $deps_link_flags" \
  ac_cv_host=wasm32-unknown-emscripten \
  ac_cv_func_clock_gettime=yes \
    emconfigure "$libusb_source/configure" \
      --host=wasm32-emscripten \
      --prefix="$prefix" \
      --disable-shared \
      --enable-static
)
emmake make -C "$libusb_build" -j"$jobs" THREAD_CFLAGS=-pthread
emmake make -C "$libusb_build" install THREAD_CFLAGS=-pthread

emcmake cmake \
  -S "$root/vendor/libftdi" \
  -B "$out/libftdi-build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS_RELEASE= \
  -DCMAKE_CXX_FLAGS_RELEASE= \
  -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_C_FLAGS="$deps_c_flags" \
  -DCMAKE_CXX_FLAGS="$deps_c_flags" \
  -DCMAKE_EXE_LINKER_FLAGS="$deps_link_flags" \
  -DCMAKE_MODULE_LINKER_FLAGS="$deps_link_flags" \
  -DCMAKE_SHARED_LINKER_FLAGS="$deps_link_flags" \
  -DLIBUSB_INCLUDE_DIR="$prefix/include/libusb-1.0" \
  -DLIBUSB_LIBRARIES="$prefix/lib/libusb-1.0.a" \
  -DSTATICLIBS=ON \
  -DSHAREDLIBS=OFF \
  -DFTDI_EEPROM=OFF \
  -DEXAMPLES=OFF \
  -DPYTHON_BINDINGS=OFF \
  -DDOCUMENTATION=OFF \
  -DBUILD_TESTS=OFF \
  -DFTDIPP=OFF
emmake make -C "$out/libftdi-build" -j"$jobs"
emmake make -C "$out/libftdi-build" install

export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"

build_openfpgaloader() {
  local build_dir="$1"
  emcmake cmake \
    -S "$root/vendor/openFPGALoader" \
    -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS_RELEASE= \
    -DCMAKE_CXX_FLAGS_RELEASE= \
    -DCMAKE_INSTALL_PREFIX="$prefix" \
    -DCMAKE_C_FLAGS="$loader_c_flags" \
    -DCMAKE_CXX_FLAGS="$loader_c_flags" \
    -DCMAKE_EXE_LINKER_FLAGS="$link_string" \
    "-DCMAKE_CXX_LINKER_LAUNCHER=/usr/bin/time;-v;-o;$build_dir/link-time.txt" \
    -DCMAKE_EXECUTABLE_SUFFIX_CXX=.mjs \
    -DCMAKE_PREFIX_PATH="$prefix" \
    -DENABLE_VENDORS_ALL=OFF \
    -DENABLE_GOWIN_SUPPORT=ON \
    -DENABLE_OPTIM=OFF \
    -DENABLE_CABLE_ALL=OFF \
    -DENABLE_FTDI_BASED_CABLE=ON
  emmake cmake --build "$build_dir" --parallel "$jobs"
}

openfpgaloader_build="$out/openFPGALoader-build"
build_openfpgaloader "$openfpgaloader_build"

link_file="$openfpgaloader_build/CMakeFiles/openFPGALoader.dir/link.txt"
if [[ "$async_mode" == jspi ]] && grep -Eq -- '(^|[[:space:]])-s[[:space:]]+ASYNCIFY(=|[[:space:]]|$)' "$link_file"; then
  printf 'Unexpected ASYNCIFY setting in JSPI linker command: %s\n' "$link_file" >&2
  exit 1
fi

cp "$openfpgaloader_build/openFPGALoader.mjs" "$out/openFPGALoader.mjs"
cp "$openfpgaloader_build/openFPGALoader.wasm" "$out/openFPGALoader.wasm"
python3 "$root/scripts/build-info.py" write \
  --root "$root" \
  --artifacts "$out" \
  --variant "$variant_id" \
  --async-mode "$async_mode"
printf 'elapsed_seconds=%s\n' "$SECONDS"
