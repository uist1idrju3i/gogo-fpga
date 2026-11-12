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

for tool in git make patch python3 sha256sum tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$tool" >&2
    exit 1
  fi
done

pin=$(python3 .github/scripts/check-pins.py iverilog-pin)
old_ifs=$IFS
IFS=$(printf '\t')
read -r iverilog_version iverilog_commit iverilog_url <<EOF
$pin
EOF
IFS=$old_ifs
if [ -z "$iverilog_version" ] || [ -z "$iverilog_commit" ] || [ -z "$iverilog_url" ]; then
  printf 'Icarus Verilog pin is incomplete in RESEARCH.md.\n' >&2
  exit 1
fi

source_tree=vendor/iverilog
if [ -e "$source_tree/.git" ]; then
  checked_out_commit=$(git -C "$source_tree" rev-parse HEAD)
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    gitlink=$(git rev-parse "HEAD:$source_tree")
    if [ "$gitlink" != "$iverilog_commit" ]; then
      printf 'Icarus gitlink mismatch: expected %s, found %s\n' "$iverilog_commit" "$gitlink" >&2
      exit 1
    fi
  fi
elif [ -f "$source_tree/.gitcommit" ]; then
  checked_out_commit=$(tr -d '\r\n' < "$source_tree/.gitcommit")
else
  printf 'Icarus source is not initialized and has no source marker.\n' >&2
  exit 1
fi
if [ "$checked_out_commit" != "$iverilog_commit" ]; then
  printf 'Icarus pin mismatch: expected %s, found %s\n' "$iverilog_commit" "$checked_out_commit" >&2
  exit 1
fi

if [ -e "$source_tree/.git" ]; then
  SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$source_tree" show -s --format=%ct "$iverilog_commit")}
else
  SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-0}
fi
export SOURCE_DATE_EPOCH

if [ "$mode" = wasi ]; then
  build_root=${IVERILOG_BUILD_ROOT:-build/iverilog-wasm}
else
  build_root=${IVERILOG_BUILD_ROOT:-build/iverilog-native}
fi
case "$build_root" in
  /*|../*|*/../*)
    printf 'IVERILOG_BUILD_ROOT must be a repository-relative path: %s\n' "$build_root" >&2
    exit 1
    ;;
esac

if [ "$mode" = wasi ]; then
  if ! command -v curl >/dev/null 2>&1; then
    printf 'Required command not found: curl\n' >&2
    exit 1
  fi
  wasi_pin=$(python3 .github/scripts/check-pins.py wasi-sdk-pin)
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
  archive="build/cache/$wasi_asset"
  mkdir -p build/cache
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
    { [ ! -x "$sdk_dir/bin/clang" ] || [ ! -x "$sdk_dir/bin/clang++" ] \
      || [ ! -x "$sdk_dir/bin/llvm-ar" ] || [ ! -x "$sdk_dir/bin/llvm-ranlib" ]; }; then
    rm -rf "$sdk_dir"
  fi
  if [ ! -d "$sdk_dir" ]; then
    tar -xzf "$archive" -C build
  fi
  if [ ! -x "$sdk_dir/bin/clang" ] || [ ! -x "$sdk_dir/bin/clang++" ] \
    || [ ! -x "$sdk_dir/bin/llvm-ar" ] || [ ! -x "$sdk_dir/bin/llvm-ranlib" ]; then
    printf 'Pinned WASI SDK is missing or incomplete: %s\n' "$sdk_dir" >&2
    exit 1
  fi
  cc="$root/$sdk_dir/bin/clang"
  cxx="$root/$sdk_dir/bin/clang++"
  ar="$root/$sdk_dir/bin/llvm-ar"
  ranlib="$root/$sdk_dir/bin/llvm-ranlib"
  cflags="-O2 -g0 -ffile-prefix-map=$root=/src -ffile-prefix-map=$root/$build_root=/build -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false"
  cxxflags=$cflags
  ldflags="-fwasm-exceptions -lunwind -Wl,-z,stack-size=8388608"
  sdk_version=$wasi_version
else
  for tool in cc c++ ar ranlib flex bison gperf; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf 'Required command not found: %s\n' "$tool" >&2
      exit 1
    fi
  done
  cc=$(command -v cc)
  cxx=$(command -v c++)
  ar=$(command -v ar)
  ranlib=$(command -v ranlib)
  cflags="-O2 -g0 -ffile-prefix-map=$root=/src -ffile-prefix-map=$root/$build_root=/build"
  cxxflags=$cflags
  ldflags=
  sdk_version=
fi
if [ -e "$build_root" ] && [ ! -f "$build_root/.iverilog-build-root" ]; then
  printf 'Refusing to replace an unrecognized build directory: %s\n' "$build_root" >&2
  exit 1
fi
mkdir -p "$build_root"
: > "$build_root/.iverilog-build-root"
rm -rf "$build_root/source" "$build_root/output" "$build_root/build-info.json"
source_dir="$build_root/source"
output_dir="$build_root/output"
mkdir -p "$source_dir" "$output_dir"

if [ -e "$source_tree/.git" ]; then
  git -C "$source_tree" archive --format=tar "$iverilog_commit" | tar -xf - -C "$source_dir"
else
  tar --exclude=.git -cf - -C "$source_tree" . | tar -xf - -C "$source_dir"
fi
patch -p1 -d "$source_dir" < patches/iverilog/static-wasi.patch

jobs=${JOBS:-2}
if [ "$mode" = wasi ]; then
  host=wasm32-wasi
  configure_build=x86_64-pc-linux-gnu
else
  host=
  configure_build=
fi
(
  cd "$source_dir"
  set -- --prefix=/usr
  if [ -n "$host" ]; then
    set -- "$@" "--build=$configure_build" "--host=$host"
  fi
  CC="$cc" CXX="$cxx" AR="$ar" RANLIB="$ranlib" \
    CPPFLAGS='-DIVL_STATIC_TARGET -DIVL_STATIC_SYSTEM_VPI' \
    CFLAGS="$cflags" CXXFLAGS="$cxxflags" LDFLAGS="$ldflags" \
    SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
    ./configure "$@"
)

ivl_extra_libs=
if [ "$mode" = native ]; then
  if ! grep -q '^LIBS = ' "$source_dir/vpi/Makefile"; then
    printf 'Configured native VPI libraries are missing from vpi/Makefile.\n' >&2
    exit 1
  fi
  ivl_extra_libs=$(sed -n 's/^LIBS = //p' "$source_dir/vpi/Makefile")
fi

make -C "$source_dir" version_tag.h
make -C "$source_dir/ivlpp" -j"$jobs" ivlpp
make -C "$source_dir" dep
make -C "$source_dir" -j"$jobs" IVL_EXTRA_LIBS="$ivl_extra_libs" ivl
make -C "$source_dir/vvp" dep
make -C "$source_dir/vvp" -j"$jobs" IVL_EXTRA_LIBS="$ivl_extra_libs" vvp

suffix=
if [ "$mode" = wasi ]; then
  suffix=.wasm
fi
cp "$source_dir/ivlpp/ivlpp" "$output_dir/ivlpp$suffix"
cp "$source_dir/ivl" "$output_dir/ivl$suffix"
cp "$source_dir/vvp/vvp" "$output_dir/vvp$suffix"

compiler_version=$("$cc" --version | head -n 1)
patch_sha=$(sha256sum patches/iverilog/static-wasi.patch | cut -d ' ' -f 1)
python3 scripts/build-iverilog-info.py \
  --mode "$mode" \
  --output-dir "$output_dir" \
  --build-info "$build_root/build-info.json" \
  --version "$iverilog_version" \
  --commit "$iverilog_commit" \
  --wasi-sdk-version "$sdk_version" \
  --compiler-version "$compiler_version" \
  --flags "$cflags $cxxflags $ldflags $ivl_extra_libs" \
  --patch-sha256 "$patch_sha"
printf '%s Icarus Verilog build complete: %s\n' "$mode" "$build_root/build-info.json"
