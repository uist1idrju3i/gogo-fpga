#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_root="${BUILD_ROOT:-$root/build}"
if [[ "$build_root" != /* ]]; then
  build_root="$root/$build_root"
fi
decoder_opt_level="${DECODER_OPT_LEVEL:-2}"
decoder_lto="${DECODER_LTO:-0}"
decoder_out_dir="${DECODER_OUT_DIR:-}"

case "$decoder_opt_level" in
  0|1|2|3|s|z) ;;
  *)
    printf 'Unsupported DECODER_OPT_LEVEL: %s\n' "$decoder_opt_level" >&2
    exit 2
    ;;
esac

case "$decoder_lto" in
  ""|0) decoder_lto=0 ;;
  1) ;;
  *)
    printf 'Unsupported DECODER_LTO: %s\n' "$decoder_lto" >&2
    exit 2
    ;;
esac

if [[ -z "$decoder_out_dir" ]]; then
  decoder_dir="$build_root/wasi/decoders"
else
  case "$decoder_out_dir" in
    /*|.|..|./*|../*|*/./*|*/../*|*/.|*/..)
      printf 'DECODER_OUT_DIR must be a relative path without dot segments: %s\n' "$decoder_out_dir" >&2
      exit 2
      ;;
    *)
      decoder_dir="$build_root/$decoder_out_dir"
      ;;
  esac
fi

for tool in curl python3 sha256sum tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$tool" >&2
    exit 1
  fi
done
if [[ "$decoder_lto" == 1 ]] && ! command -v grep >/dev/null 2>&1; then
  printf 'Required command not found: grep\n' >&2
  exit 1
fi

pin="$(python3 "$root/.github/scripts/check-pins.py" wasi-sdk-pin)"
old_ifs=$IFS
IFS=$'\t'
read -r wasi_version wasi_sha wasi_asset wasi_url <<< "$pin"
IFS=$old_ifs
if [[ -z "$wasi_version" || -z "$wasi_sha" || -z "$wasi_asset" || -z "$wasi_url" ]]; then
  printf 'WASI SDK pin is incomplete in RESEARCH.md.\n' >&2
  exit 1
fi

cache_dir="$build_root/cache"
archive="$cache_dir/$wasi_asset"
sdk_dir="$build_root/${wasi_asset%.tar.gz}"
mkdir -p "$cache_dir"
if [[ ! -f "$archive" ]]; then
  temporary_archive="$archive.tmp.$$"
  trap 'rm -f "$temporary_archive"' EXIT HUP INT TERM
  curl --fail --location --retry 3 --output "$temporary_archive" "$wasi_url"
  mv "$temporary_archive" "$archive"
  trap - EXIT HUP INT TERM
fi
if ! printf '%s  %s\n' "$wasi_sha" "$archive" | sha256sum --check --status; then
  printf 'WASI SDK archive SHA-256 mismatch: %s\n' "$archive" >&2
  exit 1
fi
if [[ -d "$sdk_dir" ]] &&
  { [[ ! -x "$sdk_dir/bin/clang" ]] || [[ ! -f "$sdk_dir/share/cmake/wasi-sdk-p1.cmake" ]]; }; then
  rm -rf -- "$sdk_dir"
fi
if [[ ! -d "$sdk_dir" ]]; then
  tar -xzf "$archive" -C "$build_root"
fi
if [[ ! -x "$sdk_dir/bin/clang" || ! -f "$sdk_dir/share/cmake/wasi-sdk-p1.cmake" ]]; then
  printf 'WASI SDK installation is incomplete: %s\n' "$sdk_dir" >&2
  exit 1
fi

lto_lib_dir="$sdk_dir/share/wasi-sysroot/lib/wasm32-wasip1/llvm-lto"
if [[ "$decoder_lto" == 1 && ! -d "$lto_lib_dir" ]]; then
  printf 'WASI SDK LTO libraries are missing: %s\n' "$lto_lib_dir" >&2
  exit 1
fi

for source in \
  "$root/vendor/zstd/build/single_file_libs/combine.py" \
  "$root/vendor/zstd/build/single_file_libs/zstddeclib-in.c" \
  "$root/vendor/xz-embedded/linux/lib/xz/xz_crc32.c" \
  "$root/vendor/xz-embedded/linux/lib/xz/xz_crc64.c" \
  "$root/vendor/xz-embedded/linux/lib/xz/xz_dec_stream.c" \
  "$root/vendor/xz-embedded/linux/lib/xz/xz_dec_lzma2.c"; do
  if [[ ! -f "$source" ]]; then
    printf 'Required decoder source is missing: %s\n' "$source" >&2
    exit 1
  fi
done

mkdir -p "$decoder_dir"
(
  cd "$root/vendor/zstd/build/single_file_libs"
  python3 combine.py -r ../../lib -x legacy/zstd_legacy.h \
    -o "$decoder_dir/zstddeclib.c" zstddeclib-in.c
)

clang="$sdk_dir/bin/clang"
common_flags=(
  --target=wasm32-wasip1
  "--sysroot=$sdk_dir/share/wasi-sysroot"
  -mexec-model=reactor
  "-O$decoder_opt_level"
  "-ffile-prefix-map=$root=/src"
  "-ffile-prefix-map=$build_root=/build"
  "-ffile-prefix-map=$sdk_dir=/wasi-sdk"
  "-Wl,--export-memory"
  "-Wl,--export=dec_alloc"
  "-Wl,--export=dec_free"
  "-Wl,--export=dec_decode"
  "-Wl,--strip-all"
)
if [[ "$decoder_lto" == 1 ]]; then
  common_flags+=(-flto)
fi

build_decoder() {
  local name="$1"
  local output="$2"
  shift 2

  if [[ "$decoder_lto" == 1 ]]; then
    local linker_log="$decoder_dir/$name-linker.log"
    if ! "$clang" "${common_flags[@]}" -Wl,--verbose "$@" -o "$output" >"$linker_log" 2>&1; then
      printf 'Failed to build %s decoder; linker log: %s\n' "$name" "$linker_log" >&2
      return 1
    fi
    if ! grep -Fq "$lto_lib_dir" "$linker_log"; then
      printf 'LTO evidence missing for %s decoder; expected linker trace to name %s; log: %s\n' \
        "$name" "$lto_lib_dir" "$linker_log" >&2
      return 1
    fi
    printf 'LTO evidence recorded for %s decoder: %s\n' "$name" "$linker_log"
  else
    "$clang" "${common_flags[@]}" "$@" -o "$output"
  fi
}

build_decoder zstd "$decoder_dir/zstd-decoder.wasm" \
  -I"$root/vendor/zstd/lib" \
  "$root/scripts/zstd-decoder.c" "$decoder_dir/zstddeclib.c"

build_decoder xz "$decoder_dir/xz-decoder.wasm" \
  -DXZ_USE_CRC64 \
  -I"$root/vendor/xz-embedded/linux/include" \
  -I"$root/vendor/xz-embedded/linux/include/linux" \
  -I"$root/vendor/xz-embedded/userspace" \
  "$root/scripts/xz-decoder.c" \
  "$root/vendor/xz-embedded/linux/lib/xz/xz_crc32.c" \
  "$root/vendor/xz-embedded/linux/lib/xz/xz_crc64.c" \
  "$root/vendor/xz-embedded/linux/lib/xz/xz_dec_stream.c" \
  "$root/vendor/xz-embedded/linux/lib/xz/xz_dec_lzma2.c"

if [[ "$decoder_lto" == 1 ]]; then
  printf 'Built WASI decoders in %s with -O%s -flto\n' "$decoder_dir" "$decoder_opt_level"
else
  printf 'Built WASI decoders in %s with -O%s\n' "$decoder_dir" "$decoder_opt_level"
fi
