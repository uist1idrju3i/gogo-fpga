#!/usr/bin/env bash
# Adapted from synth-explorer/tools/ghdl-wasm/build-in-container.sh.
# Copyright 2025 synth-explorer contributors.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
# https://www.apache.org/licenses/LICENSE-2.0
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

usage() {
  printf 'Usage: %s [--variant=B0|O1|O2|O3|Os|O3+LTO]\n' "${0##*/}" >&2
  exit 2
}

variant=Os
variant_seen=false
for arg in "$@"; do
  case "$arg" in
    --variant=*)
      [[ "$variant_seen" == false ]] || usage
      variant="${arg#*=}"
      variant_seen=true
      ;;
    *) usage ;;
  esac
done

ada_opt=O1
c_opt=O2
lto=false
ada_compile_flags=()
c_compile_flags=()
link_flags=()
case "$variant" in
  B0) ;;
  O1|O2|O3|Os)
    ada_opt="$variant"
    c_opt="$variant"
    ;;
  O3+LTO)
    ada_opt=O3
    c_opt=O3
    lto=true
    link_flags=(-O3 -flto)
    ;;
  Os+LTO)
    printf '%s\n' 'Os+LTO is excluded by the recorded S9 link failure.' >&2
    exit 2
    ;;
  *) usage ;;
esac
ada_compile_flags=("-$ada_opt")
c_compile_flags=("-$c_opt")
gpr_lto_switch=
ada_flag_summary="-$ada_opt"
c_flag_summary="-$c_opt"
if [[ "$lto" == true ]]; then
  ada_compile_flags+=(-flto)
  c_compile_flags+=(-flto)
  gpr_lto_switch=', "-flto"'
  ada_flag_summary+=' -flto'
  c_flag_summary+=' -flto'
fi

readonly ghdl_pin=e589c698c351369ac5bcfe7abe1f1152ac5d4727
readonly gcc_pin=ed10445fe222d3973ae13eda9bf211f315c5e3f9
readonly adawebpack_version=24.0.0
readonly adawebpack_sha256=8edaae8b9987a20aec430d750f30033f12f953ce2b6437afb87fbf8cc1063796
readonly libxml2_sha256=c5a065f85c1e6f605741e365e40cad71c3ceb0e85e2791400bd35b8896e12ad1
readonly libicu74_sha256=c9a70989678660eed9a1e904c74fa043da8bec8e2036856fc16e31ced79b04f8

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
build_root=${GHDL_WASM_BUILD_ROOT:-"$root/build"}
case "$build_root" in
  /*) ;;
  *) build_root="$root/$build_root" ;;
esac
mkdir -p "$build_root"
build_root=$(CDPATH='' cd -- "$build_root" && pwd)
case "$build_root" in
  "$root"/build|"$root"/build/*) ;;
  *)
    printf 'GHDL_WASM_BUILD_ROOT must be inside %s/build\n' "$root" >&2
    exit 2
    ;;
esac

scratch_root=${GHDL_WASM_SCRATCH_ROOT:-"$build_root"}
case "$scratch_root" in
  /*) ;;
  *) scratch_root="$root/$scratch_root" ;;
esac
mkdir -p "$scratch_root"
scratch_root=$(CDPATH='' cd -- "$scratch_root" && pwd)
tmp_root=${TMPDIR:-/tmp}
case "$tmp_root" in
  /*) ;;
  *) tmp_root="$root/$tmp_root" ;;
esac
tmp_root=$(CDPATH='' cd -- "$tmp_root" && pwd)
case "$scratch_root" in
  "$root"/build|"$root"/build/*|"$tmp_root"/*) ;;
  *)
    printf 'GHDL_WASM_SCRATCH_ROOT must be inside %s/build or %s\n' "$root" "$tmp_root" >&2
    exit 2
    ;;
esac
if [[ "$scratch_root" == "$tmp_root" ]]; then
  printf 'GHDL_WASM_SCRATCH_ROOT must not be the temporary directory itself.\n' >&2
  exit 2
fi

readonly cache_root="$root/build/cache/ghdl-wasm"
readonly host_package_cache="$root/build/cache/ghdl-host-packages"
readonly host_tools="$root/build/host-tools"
readonly host_lib_dir="$host_tools/usr/lib/x86_64-linux-gnu"
readonly ada_lib_dir="$host_tools/adawebpack-libs/usr/lib/x86_64-linux-gnu"
readonly work_dir="$scratch_root/ghdl-wasm-work"
readonly native_build="$scratch_root/ghdl-native-build"
readonly native_prefix="$build_root/ghdl-native"
readonly output_dir="$build_root/ghdl-wasm"
readonly sdk_dir="${WASI_SDK_DIR:-$root/build/wasi-sdk-34.0-x86_64-linux}"
readonly adawebpack_archive="$host_package_cache/adawebpack-$adawebpack_version.tar.gz"
readonly gcc_source="$cache_root/gcc-libgnat"
readonly jobs=${JOBS:-${GHDL_WASM_JOBS:-2}}

for tool in apt-get curl dpkg-deb file gcc gnatmake git gzip make patch python3 sha256sum tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$tool" >&2
    exit 1
  fi
done
for tool in clang wasm-ld llvm-ar llvm-strip; do
  if [[ ! -x "$sdk_dir/bin/$tool" ]]; then
    printf 'Required WASI SDK tool is missing: %s/bin/%s\n' "$sdk_dir" "$tool" >&2
    exit 1
  fi
done
if [[ ! -f vendor/ghdl/configure || ! -f vendor/ghdl/src/synth/synthesis.adb ]]; then
  printf 'Initialize the pinned vendor/ghdl submodule before building.\n' >&2
  exit 1
fi
if [[ $(git -C vendor/ghdl rev-parse HEAD) != "$ghdl_pin" ]]; then
  printf 'GHDL pin mismatch: expected %s\n' "$ghdl_pin" >&2
  exit 1
fi

mkdir -p "$cache_root" "$host_package_cache"
rm -rf "$work_dir" "$native_build" "$native_prefix" "$output_dir"
mkdir -p "$work_dir" "$native_build" "$output_dir" "$host_tools"
exec > >(tee "$output_dir/build.log") 2>&1
start_time=$(date +%s)

source_date_epoch=$(git -C vendor/ghdl show -s --format=%ct "$ghdl_pin")
export SOURCE_DATE_EPOCH="$source_date_epoch"
printf 'SOURCE_DATE_EPOCH=%s (GHDL %s)\n' "$SOURCE_DATE_EPOCH" "$ghdl_pin"
printf 'GHDL WASM variant: %s (Ada -%s, wasi.c -%s, LTO=%s)\n' \
  "$variant" "$ada_opt" "$c_opt" "$lto"
printf 'GHDL WASM scratch root: %s\n' "$scratch_root"

expected_package_version() {
  case "$1" in
    gprbuild|libgnatprj12) printf '%s' '2025.0.0-4build2' ;;
    gprconfig-kb) printf '%s' '25.0.0-2' ;;
    libxmlada-dom9|libxmlada-input8|libxmlada-sax8|libxmlada-schema8|libxmlada-unicode8)
      printf '%s' '25.0.0-4build2'
      ;;
    libgnat-14) printf '%s' '14.3.0-14ubuntu1' ;;
    *) return 1 ;;
  esac
}

expected_package_sha256() {
  case "$1" in
    gprbuild:amd64) printf '%s' ebf68e78caf320692fbae9c1cb58e8b365d989b66033f703e3224040691db9bb ;;
    gprbuild:amd64v3) printf '%s' 327805b431911427fec34f3e22815e3212c138bb49d6e07f538d139a704404ac ;;
    gprconfig-kb:all) printf '%s' 4f3e254e1cae5c0edbc87f999144202d717ec828f4d07bd5cc0ddb31d01ccac0 ;;
    libgnat-14:amd64) printf '%s' d58050517bc1e289a879f4433eac71e8718c87143e9c860a5479e8aa92968012 ;;
    libgnat-14:amd64v3) printf '%s' 8c4183d87c63ac3875fd3d5b732ef8fb87c412ad3cac427d1d5336aaa8a05e79 ;;
    libgnatprj12:amd64) printf '%s' b57ab4d2bd90360966eb245ff464afd2145685802b6e8e56f7ecb806f59bb194 ;;
    libgnatprj12:amd64v3) printf '%s' 575af2e2d2885d2a71f0a27d3bd4c9b355219e7cc57bb29c8f8398674d9e36a9 ;;
    libxmlada-dom9:amd64) printf '%s' 7b8773467a50b27bb9071f21e4a10b5c61a8bd0614d2bade32f45e57a91ed075 ;;
    libxmlada-dom9:amd64v3) printf '%s' 2b6fa4c516ed90975895663fafc6ef0ba5f263b26acc9a63b639f0bbaaaef6b2 ;;
    libxmlada-input8:amd64) printf '%s' 30161cb121ee176ea0c5d37a9db2744dd91056f47f1ce75c2f4d54773d31f69b ;;
    libxmlada-input8:amd64v3) printf '%s' 042c9e7ee29dc9431df41f9b9cd42a1f3ec995f95c754eeb675ac446b34ea833 ;;
    libxmlada-sax8:amd64) printf '%s' aae83ba17f060d82a5c1e32432462470cc0a8bab1dfa45df58a816512d4c3a57 ;;
    libxmlada-sax8:amd64v3) printf '%s' fe643fbe119a24c89ec0732125a6e58958d07c9d60ed05e3157eb5ce76ae6b38 ;;
    libxmlada-schema8:amd64) printf '%s' b01d6d3ed8189a9902da2ba037599fbcb23cba3d553fa5b74d7741f64e299969 ;;
    libxmlada-schema8:amd64v3) printf '%s' e674bc886ee4ae1dd2db213d8f0676e5bf2af443ed48e8c49f70773e37e88328 ;;
    libxmlada-unicode8:amd64) printf '%s' badb5d896cc19507c01996c71e54ff0beb83a8f30472a2c2bf15071f816e56f5 ;;
    libxmlada-unicode8:amd64v3) printf '%s' 4b23b9407f95600bfcaf2346b55f5d4ed1b7544f87b037e13245656e1e006556 ;;
    *) return 1 ;;
  esac
}

installed_version() {
  local package=$1 status version
  status=$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)
  if [[ "$status" != 'install ok installed' ]]; then
    return 1
  fi
  version=$(dpkg-query -W -f='${Version}' "$package")
  printf '%s' "$version"
}

download_package() {
  local package=$1 version expected_version expected_sha package_variant deb candidate_dir candidate sha
  expected_version=$(expected_package_version "$package" || true)
  deb=
  for candidate in "$host_package_cache/${package}_"*.deb; do
    [[ -f "$candidate" ]] || continue
    if [[ $(dpkg-deb -f "$candidate" Package) == "$package" ]] &&
      { [[ -z "$expected_version" ]] || [[ $(dpkg-deb -f "$candidate" Version) == "$expected_version" ]]; }; then
      deb=$candidate
      break
    fi
  done
  if [[ -z "$deb" ]]; then
    candidate_dir=$(mktemp -d "$host_package_cache/download-${package}.XXXXXX")
    (cd "$candidate_dir" && apt-get download "$package")
    deb=$(find "$candidate_dir" -maxdepth 1 -type f -name '*.deb' -print -quit)
    if [[ -z "$deb" ]]; then
      printf 'apt-get download did not produce a .deb for %s\n' "$package" >&2
      return 1
    fi
    version=$(dpkg-deb -f "$deb" Version)
    if [[ -n "$expected_version" && "$version" != "$expected_version" ]]; then
      printf 'Unexpected %s version: expected %s, got %s\n' "$package" "$expected_version" "$version" >&2
      return 1
    fi
    cp "$deb" "$host_package_cache/"
    deb="$host_package_cache/$(basename "$deb")"
    rm -rf "$candidate_dir"
  fi
  version=$(dpkg-deb -f "$deb" Version)
  package_variant=${deb##*_}
  package_variant=${package_variant%.deb}
  expected_sha=$(expected_package_sha256 "$package:$package_variant" || true)
  if [[ -z "$expected_sha" ]]; then
    printf 'No SHA-256 pin is configured for host package %s (%s)\n' "$package" "$package_variant" >&2
    return 1
  fi
  sha=$(sha256sum "$deb" | cut -d' ' -f1)
  if [[ -n "$expected_sha" && "$sha" != "$expected_sha" ]]; then
    printf 'SHA-256 mismatch for downloaded package: %s\n' "$deb" >&2
    return 1
  fi
  dpkg-deb -x "$deb" "$host_tools"
  printf 'downloaded\t%s\t%s\t%s\n' "$package" "$version" "$sha" >> "$work_dir/packages.tsv"
  printf 'apt package: %s %s (%s) sha256=%s\n' "$package" "$version" "$package_variant" "$sha"
}

: > "$work_dir/packages.tsv"
for package in \
  gprbuild gprconfig-kb libgnat-14 libgnatprj12 libxmlada-dom9 libxmlada-input8 \
  libxmlada-sax8 libxmlada-schema8 libxmlada-unicode8; do
  if version=$(installed_version "$package"); then
    printf 'installed\t%s\t%s\t-\n' "$package" "$version" >> "$work_dir/packages.tsv"
    printf 'host package already installed: %s %s\n' "$package" "$version"
  else
    download_package "$package"
  fi
done

download_and_extract_pinned() {
  local url=$1 sha=$2 archive=$3 version=$4 expected_version=$5 destination=$6
  if [[ ! -f "$archive" ]]; then
    curl --fail --location --retry 3 --output "$archive.tmp" "$url"
    mv "$archive.tmp" "$archive"
  fi
  if ! printf '%s  %s\n' "$sha" "$archive" | sha256sum --check --status; then
    printf 'SHA-256 mismatch: %s\n' "$archive" >&2
    return 1
  fi
  if [[ $(dpkg-deb -f "$archive" Package) != "$version" ||
    $(dpkg-deb -f "$archive" Version) != "$expected_version" ]]; then
    printf 'Unexpected package metadata in %s\n' "$archive" >&2
    return 1
  fi
  dpkg-deb -x "$archive" "$destination"
  printf 'pinned package: %s %s sha256=%s\n' "$version" "$expected_version" "$sha"
}

readonly libxml2_archive="$host_package_cache/libxml2-noble.deb"
readonly libicu74_archive="$host_package_cache/libicu74-noble.deb"
download_and_extract_pinned \
  'https://archive.ubuntu.com/ubuntu/pool/main/libx/libxml2/libxml2_2.9.14+dfsg-1.3ubuntu3.10_amd64.deb' \
  "$libxml2_sha256" "$libxml2_archive" libxml2 '2.9.14+dfsg-1.3ubuntu3.10' \
  "$host_tools/adawebpack-libs"
download_and_extract_pinned \
  'https://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu74_74.2-1ubuntu3.1_amd64.deb' \
  "$libicu74_sha256" "$libicu74_archive" libicu74 '74.2-1ubuntu3.1' \
  "$host_tools/adawebpack-libs"

if ! command -v gnatmake >/dev/null 2>&1; then
  printf 'GNAT is required for the native GHDL build.\n' >&2
  exit 1
fi

if [[ ! -f "$adawebpack_archive" ]]; then
  curl --fail --location --retry 3 --output "$adawebpack_archive.tmp" \
    "https://github.com/godunko/adawebpack/releases/download/$adawebpack_version/adawebpack-$adawebpack_version.tar.gz"
  mv "$adawebpack_archive.tmp" "$adawebpack_archive"
fi
if ! printf '%s  %s\n' "$adawebpack_sha256" "$adawebpack_archive" | sha256sum --check --status; then
  printf 'AdaWebPack archive SHA-256 mismatch: %s\n' "$adawebpack_archive" >&2
  exit 1
fi

readonly adawebpack_root="$work_dir/adawebpack"
readonly adawebpack="$adawebpack_root/adawebpack"
mkdir -p "$adawebpack_root"
tar -xzf "$adawebpack_archive" -C "$adawebpack_root"
if [[ ! -x "$adawebpack/bin/llvm-gcc" || ! -f "$adawebpack/lib/gnat/adawebpack_config.gpr" ]]; then
  printf 'AdaWebPack extraction is incomplete.\n' >&2
  exit 1
fi

source_date_year=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y)
readonly source_date_year
library_timestamp="$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M%S).000"
readonly library_timestamp
if (( source_date_year < 2000 || source_date_year > 2099 )); then
  printf 'SOURCE_DATE_EPOCH year is outside GHDL Filesystem range: %s\n' \
    "$source_date_year" >&2
  exit 1
fi
if [[ ! -d "$gcc_source/.git" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/gcc-mirror/gcc.git "$gcc_source"
  git -C "$gcc_source" sparse-checkout init --cone
  git -C "$gcc_source" sparse-checkout set gcc/ada/libgnat
fi
git -C "$gcc_source" fetch --quiet --depth=1 origin "$gcc_pin"
git -C "$gcc_source" checkout --quiet --detach "$gcc_pin"
gcc_commit=$(git -C "$gcc_source" rev-parse "$gcc_pin^{commit}")
if [[ $(git -C "$gcc_source" rev-parse HEAD) != "$gcc_commit" ]]; then
  printf 'GCC libgnat source pin mismatch: expected peeled commit %s.\n' "$gcc_commit" >&2
  exit 1
fi

readonly ghdl_source="$work_dir/ghdl-native-source"
mkdir -p "$ghdl_source"
tar -C "$root/vendor/ghdl" --exclude=.git -cf - . | tar -C "$ghdl_source" -xf -
patch --directory "$ghdl_source/src/synth" --strip=0 < "$root/patches/ghdl/formal-verilog.patch"
patch --directory "$ghdl_source/src/ghdldrv" --strip=0 < "$root/patches/ghdl/formal-verilog-driver.patch"
readonly frontend="$work_dir/ghdl-wasm-full"
mkdir -p "$frontend"

prefix_flags="-ffile-prefix-map=$root=/src -ffile-prefix-map=$build_root=/build"
prefix_args=("-ffile-prefix-map=$root=/src" "-ffile-prefix-map=$build_root=/build")
(
  cd "$native_build"
  CC=gcc \
    CFLAGS="-g -O $prefix_flags" \
    ADA_FLAGS="-O $prefix_flags" \
    SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
    "$ghdl_source/configure" --prefix="$native_prefix"
  SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" make -j"$jobs"
  SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" make install
)
if [[ ! -x "$native_prefix/bin/ghdl" || ! -d "$native_prefix/lib/ghdl" ]]; then
  printf 'Native GHDL build did not install the binary and libraries.\n' >&2
  exit 1
fi
printf 'native GHDL: %s\n' "$("$native_prefix/bin/ghdl" --version | head -n 1)"

for tool in gcc gnat gnatbind gnatlink gnatls gnatmake gnatchop gnatname gnatprep gnatclean gnatkr; do
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\nLD_LIBRARY_PATH="${GHDL_WASM_ADAWP_LD_LIBRARY_PATH}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$(dirname "$0")/llvm-%s" "$@"\n' \
    "$tool" > "$adawebpack/bin/llvm-$tool-14"
  chmod +x "$adawebpack/bin/llvm-$tool-14"
done

export PATH="$adawebpack/bin:$host_tools/usr/bin:$sdk_dir/bin:$PATH"
export GPR_PROJECT_PATH="$adawebpack/lib/gnat"
export GHDL_WASM_ADAWP_LD_LIBRARY_PATH="$ada_lib_dir:$host_lib_dir"
gprbuild_bin=$(command -v gprbuild || true)
if [[ -n "$gprbuild_bin" ]]; then
  gprbuild_lib_path="$ada_lib_dir:$host_lib_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
  gprbuild_bin="$host_tools/usr/bin/gprbuild"
  gprbuild_lib_path="$ada_lib_dir:$host_lib_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
if [[ ! -x "$gprbuild_bin" ]]; then
  printf 'gprbuild is unavailable after package extraction.\n' >&2
  exit 1
fi

readonly stub_ada="$adawebpack/lib/rts-native/adainclude"
readonly ghdl_libgnat="$gcc_source/gcc/ada/libgnat"

while IFS= read -r unit; do
  [[ -z "$unit" || "$unit" == \#* ]] && continue
  mapfile -d '' source_units < <(
    find "$root/vendor/ghdl/src" -type f \
      \( -name "$unit.ads" -o -name "$unit.adb" \) -print0 | sort -z
  )
  if [[ ${#source_units[@]} -eq 0 ]]; then
    printf 'GHDL frontend unit is missing from the pinned source tree: %s\n' "$unit" >&2
    exit 1
  fi
  for source in "${source_units[@]}"; do
    if [[ -e "$frontend/${source##*/}" ]]; then
      printf 'Duplicate GHDL frontend source basename: %s\n' "${source##*/}" >&2
      exit 1
    fi
    cp "$source" "$frontend/"
  done
done < "$root/scripts/ghdl-wasm/frontend-sources.txt"
patch --directory "$frontend" --strip=0 < "$root/patches/ghdl/vhdl-only-synthesis.patch"
cp "$root/scripts/ghdl-wasm/synth-vhdl_foreign.adb" "$frontend/"
cp "$native_build/grt-readline.ads" "$frontend/"
patch --directory "$frontend" --strip=0 < "$root/patches/ghdl/grt-stdio.patch"
patch --directory "$frontend" --strip=0 < "$root/patches/ghdl/blackbox-verilog.patch"
patch --directory "$frontend" --strip=0 < "$root/patches/ghdl/formal-verilog.patch"
cp "$root/scripts/ghdl-wasm/grt-stdio.adb" "$frontend/"
cp "$root/scripts/ghdl-wasm/bug.adb" "$frontend/"
cp "$root/scripts/ghdl-wasm/version.ads" "$frontend/"
cp "$root/scripts/ghdl-wasm/synth_api.ads" \
  "$root/scripts/ghdl-wasm/synth_api.adb" "$frontend/"
cp "$root/scripts/ghdl-wasm/rts/simple_io.adb" "$frontend/"

runtime_source_units=(
  a-strfix.ads a-strfix.adb a-strsea.ads a-strsea.adb
  a-strunb.ads a-strunb.adb
  a-chahan.ads a-chahan.adb a-chlat1.ads a-strmap.ads a-strmap.adb a-stmaco.ads
  s-bitops.ads s-bitops.adb s-bytswa.ads s-imglli.ads s-imglli.adb s-vs_lli.ads
  s-expont.ads s-expont.adb s-explli.ads s-explli.adb
  s-vallli.ads s-vallli.adb s-valllli.ads s-vallllu.ads s-valllf.ads
  g-sechas.ads g-sechas.adb g-sehash.ads g-sehash.adb
  g-sha1.ads g-sha1.adb g-bytswa.ads g-bytswa.adb g-hesora.ads g-hesora.adb
)
for unit in "${runtime_source_units[@]}"; do
  cp "$ghdl_libgnat/$unit" "$stub_ada/"
done
runtime_ada_units=(
  a-calend.ads a-calend.adb a-catizo.ads a-catizo.adb
  g-dirope.ads g-dirope.adb g-os_lib.ads g-os_lib.adb
  a-chlat1.adb a-stmaco.adb s-bytswa.adb
  ghdl_wasm_epoch.adb gnat.ads gnat.adb i-c.ads i-c.adb
  i-cstrea.ads i-cstrea.adb
)
for unit in "${runtime_ada_units[@]}"; do
  cp "$root/scripts/ghdl-wasm/rts/$unit" "$stub_ada/"
done
sed "s/@SOURCE_DATE_EPOCH@/$SOURCE_DATE_EPOCH/" \
  "$root/scripts/ghdl-wasm/rts/ghdl_wasm_epoch.ads.in" \
  > "$stub_ada/ghdl_wasm_epoch.ads"
sed -i '/function Swap128/,/end Swap128;/d' "$stub_ada/g-bytswa.adb"
sed -i '/function Swap128/d' "$stub_ada/g-bytswa.ads"
sed -i '/subtype U128/d;/function Bswap_128/d;/__builtin_bswap128/d' "$stub_ada/s-bytswa.ads"
sed -i '/^package Ada.Characters.Latin_1 is/a\   pragma Elaborate_Body;' \
  "$stub_ada/a-chlat1.ads"
sed -i '/^package Ada.Strings.Maps.Constants is/a\   pragma Elaborate_Body;' \
  "$stub_ada/a-stmaco.ads"
sed -i '/^package System.Byte_Swapping is/a\   pragma Elaborate_Body;' \
  "$stub_ada/s-bytswa.ads"

readonly stub_objects="$frontend/.objs/stubali"
mkdir -p "$stub_objects"
(
  cd "$stub_objects"
  for unit in \
    gnat i-c ghdl_wasm_epoch i-cstrea a-chlat1 a-stmaco s-bytswa \
    a-calend a-catizo g-dirope g-os_lib \
    a-strsea a-strfix a-strunb \
    a-chahan a-chlat1 a-strmap a-stmaco s-bitops s-bytswa s-imglli s-vs_lli \
    s-expont s-explli s-vallli g-sechas g-sehash g-sha1 g-bytswa g-hesora; do
    source="$stub_ada/$unit.ads"
    if [[ "$unit" == ghdl_wasm_epoch ]]; then
      source="$stub_ada/ghdl_wasm_epoch.ads"
    fi
    compile_mode=()
    if [[ -f "$stub_ada/$unit.adb" ]]; then
      source="$stub_ada/$unit.adb"
    else
      compile_mode=(-gnatc)
    fi
    env LD_LIBRARY_PATH="$GHDL_WASM_ADAWP_LD_LIBRARY_PATH" \
      "$adawebpack/bin/llvm-gcc" -c "${compile_mode[@]}" --target=wasm32 \
      "${ada_compile_flags[@]}" \
      "${prefix_args[@]}" \
      -gnatg -gnatyN -gnatws -I"$stub_ada" "$source"
  done
)

cat > "$frontend/ghdl_wasm.gpr" <<EOF
with "adawebpack_config.gpr";

project Ghdl_Wasm is
   for Target use "llvm";
   for Source_Dirs use (".");
   for Object_Dir use ".objs";
   for Library_Name use "ghdl_wasm";
   for Library_Dir use "lib";
   for Library_Kind use "static";

   package Compiler is
      for Switches ("Ada") use
        ("--target=wasm32", "-$ada_opt"$gpr_lto_switch, "-ffile-prefix-map=$root=/src",
         "-ffile-prefix-map=$build_root=/build", "-I$stub_objects");
   end Compiler;
end Ghdl_Wasm;
EOF

(
  cd "$frontend"
  env PATH="$PATH" LD_LIBRARY_PATH="$gprbuild_lib_path" \
    GHDL_WASM_ADAWP_LD_LIBRARY_PATH="$GHDL_WASM_ADAWP_LD_LIBRARY_PATH" \
    GPR_PROJECT_PATH="$GPR_PROJECT_PATH" \
    "$gprbuild_bin" -p -P ghdl_wasm.gpr -j"$jobs"
)

mapfile -t ali_files < <(find "$frontend/.objs" -maxdepth 1 -name '*.ali' -print | sort)
if [[ ${#ali_files[@]} -eq 0 ]]; then
  printf 'GPR build produced no Ada library information files.\n' >&2
  exit 1
fi
(
  cd "$frontend/.objs"
  env LD_LIBRARY_PATH="$GHDL_WASM_ADAWP_LD_LIBRARY_PATH" \
    "$adawebpack/bin/llvm-gnatbind" -n -Lghdlwasm_ -o b_ghdlwasm.adb \
    -aO"$stub_objects" "${ali_files[@]}"
  env LD_LIBRARY_PATH="$GHDL_WASM_ADAWP_LD_LIBRARY_PATH" \
    "$adawebpack/bin/llvm-gcc" -c --target=wasm32 "${ada_compile_flags[@]}" "${prefix_args[@]}" \
    -gnatg -gnatyN -gnatws -I"$stub_ada" -I"$stub_objects" \
    -I"$adawebpack/lib/rts-native/adalib" b_ghdlwasm.adb
)

readonly gnat_objects="$work_dir/libgnat-wasm-objs"
mkdir -p "$gnat_objects"
(
  cd "$gnat_objects"
  "$sdk_dir/bin/llvm-ar" x "$adawebpack/lib/rts-native/adalib/libgnat.a"
  for object in *.o; do
    if [[ "$object" == s-memory.o ]]; then
      rm -f "$object"
      continue
    fi
    file "$object" | grep -q WebAssembly || rm -f "$object"
  done
  "$sdk_dir/bin/llvm-ar" rcs libgnat_wasm.a ./*.o
)

extra_objects=()
while IFS= read -r object; do
  if file "$object" | grep -q WebAssembly; then
    extra_objects+=("$object")
  fi
done < <(find "$stub_objects" -name '*.o' -print | sort)
"$sdk_dir/bin/clang" --target=wasm32-wasip1 -nostartfiles "${c_compile_flags[@]}" \
  "${prefix_args[@]}" -c "$root/scripts/ghdl-wasm/rts/wasi.c" \
  -o "$work_dir/ghdl-wasm-wasi.o"
extra_objects+=("$work_dir/ghdl-wasm-wasi.o")
"$sdk_dir/bin/clang" --target=wasm32-wasip1 -nostartfiles \
  "${link_flags[@]}" \
  -Wl,--no-entry -Wl,--allow-undefined -Wl,--export-memory \
  -Wl,--export=malloc -Wl,--export=free -Wl,--export=__wasm_call_ctors \
  -Wl,--export=ghdlwasm_init \
  -Wl,--export=synth_api__synth_set_std \
  -Wl,--export=synth_api__synth_init \
  -Wl,--export=synth_api__synth_set_formal \
  -Wl,--export=synth_api__synth_set_library \
  -Wl,--export=synth_api__analyze_file \
  -Wl,--export=synth_api__synth_top \
  -Wl,--whole-archive \
    "$frontend/lib/libghdl_wasm.a" \
    "$gnat_objects/libgnat_wasm.a" \
  -Wl,--no-whole-archive \
  "${extra_objects[@]}" \
  "$frontend/.objs/b_ghdlwasm.o" \
  -o "$work_dir/ghdl-synth.unstripped.wasm"
"$sdk_dir/bin/llvm-strip" --strip-all \
  -o "$output_dir/ghdl-synth.wasm" "$work_dir/ghdl-synth.unstripped.wasm"

library_stage="$work_dir/libraries"
mkdir -p "$library_stage"
cp -a "$native_prefix/lib/ghdl/." "$library_stage/"
normalized_catalogs=$(python3 - "$library_stage" "$library_timestamp" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
timestamp = sys.argv[2]
total = 0
for catalog in root.rglob("*.cf"):
    content = catalog.read_text(encoding="utf-8")
    normalized, count = re.subn(r'"[0-9]{14}\.[0-9]+"', f'"{timestamp}"', content)
    if count:
        catalog.write_text(normalized, encoding="utf-8")
        total += count
if total == 0:
    raise SystemExit("No GHDL library catalog timestamps were normalized")
print(total)
PY
)
printf 'Normalized %s GHDL library catalog timestamps to %s\n' \
  "$normalized_catalogs" "$library_timestamp"
tar --create --file "$work_dir/libraries.tar" \
  --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner \
  --directory "$library_stage" .
gzip --no-name --best --stdout "$work_dir/libraries.tar" > "$output_dir/libraries.tar.gz"
{
printf 'ghdl_commit\t%s\n' "$ghdl_pin"
  for input in patches/ghdl/formal-verilog.patch patches/ghdl/formal-verilog-driver.patch \
    scripts/ghdl-wasm/synth_api.ads scripts/ghdl-wasm/synth_api.adb; do
    printf 'source_sha256:%s\t%s\n' "$input" "$(sha256sum "$root/$input" | cut -d' ' -f1)"
  done
  printf 'native_sha256\t%s\n' "$(sha256sum "$native_prefix/bin/ghdl" | cut -d' ' -f1)"
  printf 'variant\t%s\n' "$variant"
  printf 'ada_compile_flags\t%s\n' "$ada_flag_summary"
  printf 'wasi_c_compile_flags\t%s\n' "$c_flag_summary"
  if [[ "$lto" == true ]]; then
    printf 'wasm_link_flags\t-%s -flto\n' "$ada_opt"
  else
    printf 'wasm_link_flags\tnone\n'
  fi
  printf 'wasm_linker\t%s\n' "$sdk_dir/bin/wasm-ld"
  printf 'gcc_libgnat_tag_object\t%s\n' "$gcc_pin"
  printf 'gcc_libgnat_commit\t%s\n' "$gcc_commit"
  printf 'source_date_epoch\t%s\n' "$SOURCE_DATE_EPOCH"
  printf 'ada_calendar_year\t%s\n' "$source_date_year"
  printf 'library_catalog_timestamp\t%s\n' "$library_timestamp"
  printf 'adawebpack_version\t%s\n' "$adawebpack_version"
  printf 'adawebpack_sha256\t%s\n' "$adawebpack_sha256"
  printf 'wasi_sdk_clang\t%s\n' "$("$sdk_dir/bin/clang" --version | head -n 1)"
  printf 'libxml2_version\t2.9.14+dfsg-1.3ubuntu3.10\n'
  printf 'libxml2_sha256\t%s\n' "$libxml2_sha256"
  printf 'libicu74_version\t74.2-1ubuntu3.1\n'
  printf 'libicu74_sha256\t%s\n' "$libicu74_sha256"
  cat "$work_dir/packages.tsv"
} > "$output_dir/build-manifest.tsv"
(
  cd "$output_dir"
  sha256sum ghdl-synth.wasm libraries.tar.gz > SHA256SUMS
)

end_time=$(date +%s)
printf 'Build wall time: %s seconds\n' "$((end_time - start_time))"
printf 'Ada Calendar fixed year: %s\n' "$source_date_year"
printf 'GHDL %s / AdaWebPack %s / GCC libgnat %s\n' \
  "$ghdl_pin" "$adawebpack_version" "$gcc_pin"
du -h "$output_dir/ghdl-synth.wasm" "$output_dir/libraries.tar.gz"
