#!/usr/bin/env bash
set -euo pipefail

script_start_seconds="$(date +%s)"
script_started_at="$(date -u +%FT%TZ)"
printf 'Surfer build started: %s\n' "$script_started_at"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_root="${SURFER_BUILD_ROOT:-build/surfer}"
if [[ "$build_root" == /* || "$build_root" == *..* ]]; then
  printf 'SURFER_BUILD_ROOT must be a relative path under build/.\n' >&2
  exit 1
fi
build_root="$root/$build_root"
case "$build_root/" in
  "$root/build/"*) ;;
  *)
    printf 'SURFER_BUILD_ROOT must be under build/.\n' >&2
    exit 1
    ;;
esac
source_dir="$root/build/surfer-src"
tools_root="$root/build/tools/surfer"
cache_root="$root/build/cache/surfer-tools"
target_dir="$build_root/target"

pin="$(python3 "$root/.github/scripts/check-pins.py" surfer-tool-pins)"
IFS=$'\t' read -r rust_version trunk_version trunk_sha trunk_url bindgen_version bindgen_sha bindgen_url binaryen_version binaryen_sha binaryen_url <<< "$pin"
for value in "$rust_version" "$trunk_version" "$trunk_sha" "$trunk_url" \
  "$bindgen_version" "$bindgen_sha" "$bindgen_url" "$binaryen_version" \
  "$binaryen_sha" "$binaryen_url"; do
  if [[ -z "$value" ]]; then
    printf 'Incomplete Surfer tool pin.\n' >&2
    exit 1
  fi
done

for tool in curl git patch python3 rustup sha256sum tar tee; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required Surfer build tool not found: %s\n' "$tool" >&2
    exit 1
  fi
done

mkdir -p "$cache_root" "$tools_root" "$build_root" "$target_dir"
download_archive() {
  local url="$1"
  local digest="$2"
  local archive="$3"
  if [[ ! -s "$archive" ]]; then
    curl --fail --location --retry 3 --output "$archive.tmp" "$url"
    mv "$archive.tmp" "$archive"
  fi
  printf '%s  %s\n' "$digest" "$archive" | sha256sum --check
}

trunk_archive="$cache_root/trunk-${trunk_version}-x86_64-unknown-linux-gnu.tar.gz"
bindgen_archive="$cache_root/wasm-bindgen-${bindgen_version}-x86_64-unknown-linux-musl.tar.gz"
binaryen_archive="$cache_root/binaryen-${binaryen_version}-x86_64-linux.tar.gz"
download_archive "$trunk_url" "$trunk_sha" "$trunk_archive"
download_archive "$bindgen_url" "$bindgen_sha" "$bindgen_archive"
download_archive "$binaryen_url" "$binaryen_sha" "$binaryen_archive"

trunk_dir="$tools_root/trunk-$trunk_version"
bindgen_dir="$tools_root/wasm-bindgen-$bindgen_version"
binaryen_dir="$tools_root/binaryen-$binaryen_version"
if [[ ! -d "$trunk_dir" ]]; then
  mkdir -p "$trunk_dir"
  tar -xzf "$trunk_archive" -C "$trunk_dir"
fi
if [[ ! -d "$bindgen_dir" ]]; then
  mkdir -p "$bindgen_dir"
  tar -xzf "$bindgen_archive" -C "$bindgen_dir"
fi
if [[ ! -d "$binaryen_dir" ]]; then
  mkdir -p "$binaryen_dir"
  tar -xzf "$binaryen_archive" -C "$binaryen_dir"
fi

find_executable() {
  local name="$1"
  local directory="$2"
  local -a matches=()
  mapfile -t matches < <(find "$directory" -type f -name "$name" -perm -u+x -print)
  if [[ ${#matches[@]} -ne 1 ]]; then
    printf 'Expected one %s executable under %s, found %s.\n' \
      "$name" "$directory" "${#matches[@]}" >&2
    exit 1
  fi
  printf '%s\n' "${matches[0]}"
}

tool_bin="$tools_root/bin"
mkdir -p "$tool_bin"
ln -sfn "$(find_executable trunk "$trunk_dir")" "$tool_bin/trunk"
ln -sfn "$(find_executable wasm-bindgen "$bindgen_dir")" "$tool_bin/wasm-bindgen"
ln -sfn "$(find_executable wasm-opt "$binaryen_dir")" "$tool_bin/wasm-opt"
export PATH="$tool_bin:$HOME/.cargo/bin:$PATH"

if [[ "$(trunk --version)" != "trunk $trunk_version" ]]; then
  printf 'Unexpected Trunk version: %s\n' "$(trunk --version)" >&2
  exit 1
fi
if [[ "$(wasm-bindgen --version)" != "wasm-bindgen $bindgen_version" ]]; then
  printf 'Unexpected wasm-bindgen version: %s\n' "$(wasm-bindgen --version)" >&2
  exit 1
fi
binaryen_number="${binaryen_version#version_}"
if ! wasm-opt --version | grep -Eq "version $binaryen_number([[:space:]]|$)"; then
  printf 'Unexpected wasm-opt version: %s\n' "$(wasm-opt --version)" >&2
  exit 1
fi

rustup toolchain install "$rust_version" --profile minimal --target wasm32-unknown-unknown
export RUSTUP_TOOLCHAIN="$rust_version"
rust_sysroot="$(rustup run "$rust_version" rustc --print sysroot)"
rust_version_output="$(rustup run "$rust_version" rustc --version)"
if [[ "$rust_version_output" != "rustc $rust_version "* ]]; then
  printf 'Unexpected Rust compiler version: %s\n' "$rust_version_output" >&2
  exit 1
fi
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
if [[ "$CARGO_HOME" != /* ]]; then
  CARGO_HOME="$root/$CARGO_HOME"
  export CARGO_HOME
fi
export CARGO_TARGET_DIR="$target_dir"
export CARGO_INCREMENTAL=0
if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
  if git -C "$root" rev-parse --verify HEAD >/dev/null 2>&1; then
    SOURCE_DATE_EPOCH="$(git -C "$root" log -1 --format=%ct)"
  elif [[ -s "$root/RELEASE-SOURCE.json" ]]; then
    SOURCE_DATE_EPOCH="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["source_date_epoch"])' "$root/RELEASE-SOURCE.json")"
  else
    printf 'SOURCE_DATE_EPOCH is required outside a git checkout.\n' >&2
    exit 1
  fi
fi
export SOURCE_DATE_EPOCH
export RUSTFLAGS="--cfg=web_sys_unstable_apis --remap-path-prefix=$source_dir=/surfer --remap-path-prefix=$CARGO_HOME=/cargo --remap-path-prefix=$rust_sysroot=/rust"

surfer_commit="bd749b1f786c1c62cd67893ca71346cbe6983915"
nested_pins=(
  "f128:e60de395f0d6454c1dc546b87f06a6358425b6b6"
  "instruction-decoder:02bdcbfd5663a72e4a0b1b9d54519412d417fab1"
)
if [[ -e "$root/vendor/surfer/.git" ]]; then
  git -C "$root/vendor/surfer" submodule update --init --depth 1 -- f128 instruction-decoder
  checked_out_commit="$(git -C "$root/vendor/surfer" rev-parse HEAD)"
  for nested_pin in "${nested_pins[@]}"; do
    module="${nested_pin%%:*}"
    expected="${nested_pin#*:}"
    actual="$(git -C "$root/vendor/surfer/$module" rev-parse HEAD)"
    if [[ "$actual" != "$expected" ]]; then
      printf 'Surfer nested submodule %s is not at the pinned commit.\n' "$module" >&2
      exit 1
    fi
  done
else
  checked_out_commit="$(cat "$root/vendor/surfer/.gitcommit" 2>/dev/null || true)"
  for nested_pin in "${nested_pins[@]}"; do
    module="${nested_pin%%:*}"
    expected="${nested_pin#*:}"
    marker="$root/vendor/surfer/$module/.gitcommit"
    if [[ ! -s "$marker" || "$(cat "$marker")" != "$expected" ]]; then
      printf 'Surfer source archive is missing the pinned %s submodule.\n' "$module" >&2
      exit 1
    fi
  done
fi
if [[ "$checked_out_commit" != "$surfer_commit" ]]; then
  printf 'vendor/surfer is not at the pinned commit.\n' >&2
  exit 1
fi
rm -rf -- "$source_dir"
mkdir -p "$source_dir"
cp -a "$root/vendor/surfer/." "$source_dir/"
rm -f "$source_dir/.git" "$source_dir/f128/.git" "$source_dir/instruction-decoder/.git"

patches=("$root"/patches/surfer/*.patch)
if [[ ${#patches[@]} -ne 1 || ! -s "${patches[0]}" ]]; then
  printf 'Expected exactly one Surfer patch under patches/surfer/.\n' >&2
  exit 1
fi
for patch in "${patches[@]}"; do
  patch --batch --forward --fuzz=0 --dry-run -d "$source_dir" -p1 < "$patch"
  patch --batch --forward --fuzz=0 -d "$source_dir" -p1 < "$patch"
done

rustup run "$rust_version" cargo fetch --locked --target wasm32-unknown-unknown \
  --manifest-path "$source_dir/surfer/Cargo.toml"
python3 "$root/scripts/collect-surfer-licenses.py" \
  --source "$source_dir" \
  --output "$build_root/licenses"

dist_dir="$build_root/dist"
rm -rf -- "$dist_dir"
mkdir -p "$dist_dir"
start_seconds="$(date +%s)"
trunk_log="$build_root/trunk-build.log"
(
  cd "$source_dir/surfer"
  trunk build --locked --release --features accesskit --public-url ./ \
    --dist "$dist_dir" --offline=true --verbose 2>&1
) | tee "$trunk_log"
rm -f -- "$dist_dir/sw.js" "$dist_dir/manifest.json"
mkdir -p "$dist_dir/licenses"
cp "$root/licenses/surfer-LICENSE-EUPL-1.2.txt" "$dist_dir/licenses/"
cp -a "$build_root/licenses/." "$dist_dir/licenses/"

for required in index.html surfer.js surfer_bg.wasm integration.js; do
  if [[ ! -s "$dist_dir/$required" ]]; then
    printf 'Required Surfer output is missing or empty: %s\n' "$dist_dir/$required" >&2
    exit 1
  fi
done
if [[ -e "$dist_dir/sw.js" || -e "$dist_dir/manifest.json" ]]; then
  printf 'Surfer PWA assets must not be present in the distribution.\n' >&2
  exit 1
fi

end_seconds="$(date +%s)"
script_end_seconds="$end_seconds"
script_finished_at="$(date -u +%FT%TZ)"
printf 'SURFER_BUILD_SECONDS %s\n' "$((end_seconds - start_seconds))"
printf 'Surfer build finished: %s\n' "$script_finished_at"
printf 'SURFER_BUILD_TOTAL_SECONDS %s\n' "$((script_end_seconds - script_start_seconds))"
printf 'SURFER_TOOL rust=%s trunk=%s wasm-bindgen=%s binaryen=%s\n' \
  "$rust_version_output" "$(trunk --version)" "$(wasm-bindgen --version)" "$(wasm-opt --version)"
while IFS= read -r -d '' file; do
  relative="${file#"$dist_dir"/}"
  size="$(wc -c < "$file" | tr -d '[:space:]')"
  digest="$(sha256sum -- "$file" | awk '{print $1}')"
  printf 'S12-SHA256 %s %s %s\n' "$relative" "$size" "$digest"
done < <(find "$dist_dir" -type f -print0 | LC_ALL=C sort -z)
