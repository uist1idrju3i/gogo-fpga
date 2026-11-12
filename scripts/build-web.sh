#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_root="${BUILD_ROOT:-$root/build}"
if [[ ! -x "$root/node_modules/.bin/esbuild" ]]; then
  printf 'Missing esbuild. Run npm ci before scripts/build-web.sh.\n' >&2
  exit 1
fi
if [[ "$build_root" != /* ]]; then
  build_root="$root/$build_root"
fi
artifacts="$build_root/jspi-pthread"
public_html="$root/public_html"
cd "$root"

case "${BUILD_INFO_CHECK:-full}" in
  full)
    build_info_action=check
    ;;
  artifacts)
    build_info_action=check-artifacts
    ;;
  *)
    printf 'Unsupported BUILD_INFO_CHECK value: %s\n' "$BUILD_INFO_CHECK" >&2
    exit 1
    ;;
esac

python3 "$root/scripts/build-info.py" "$build_info_action" \
  --root "$root" \
  --artifacts "$artifacts"

for artifact in openFPGALoader.mjs openFPGALoader.wasm; do
  if [[ ! -s "$artifacts/$artifact" ]]; then
    printf 'Missing required C-profile artifact: %s\n' "$artifacts/$artifact" >&2
    exit 1
  fi
done
for decoder in zstd-decoder.wasm xz-decoder.wasm; do
  if [[ ! -s "$build_root/wasi/decoders/$decoder" ]]; then
    printf 'Missing required WASI decoder: %s\n' "$build_root/wasi/decoders/$decoder" >&2
    exit 1
  fi
done
for artifact in ghdl-synth.wasm libraries.tar.gz; do
  if [[ ! -s "$build_root/ghdl-wasm/$artifact" ]]; then
    printf 'Missing required GHDL WASM asset: %s\n' "$build_root/ghdl-wasm/$artifact" >&2
    exit 1
  fi
done
if [[ ! -s "$build_root/surfer/dist/index.html" ||
  ! -s "$build_root/surfer/dist/surfer_bg.wasm" ]]; then
  printf 'Missing required Surfer WASM distribution under %s\n' "$build_root/surfer/dist" >&2
  exit 1
fi
for artifact in ivlpp.wasm ivl.wasm vvp.wasm; do
  if [[ ! -s "$build_root/iverilog-wasm/output/$artifact" ]]; then
    printf 'Missing required Icarus WASM asset: %s\n' \
      "$build_root/iverilog-wasm/output/$artifact" >&2
    exit 1
  fi
done

if [[ ! -f "$root/web/index.html" || ! -f "$root/web/serve.py" ]]; then
  printf 'Missing web application sources under %s/web\n' "$root" >&2
  exit 1
fi

rm -rf -- "$public_html"
mkdir -p "$public_html"
cp -R "$root/web/." "$public_html/"
python3 "$root/scripts/build-library-assets.py" --output "$public_html/libraries"
node_modules/.bin/esbuild web/editor/editor.mjs --bundle --minify --format=esm --outfile="$public_html/editor/editor.bundle.mjs"
node_modules/.bin/esbuild web/lib/project-zip.mjs --bundle --minify --format=esm --outfile="$public_html/lib/project-zip.bundle.mjs"
node_modules/.bin/esbuild web/lib/project-store.mjs --bundle --minify --format=esm --outfile="$public_html/lib/project-store.mjs"
cp "$artifacts/openFPGALoader.mjs" "$public_html/openFPGALoader.mjs"
cp "$artifacts/openFPGALoader.wasm" "$public_html/openFPGALoader.wasm"
cp "$artifacts/build-info.json" "$public_html/build-info.json"
mkdir -p "$public_html/lib/decoders"
cp "$build_root/wasi/decoders/zstd-decoder.wasm" "$public_html/lib/decoders/"
cp "$build_root/wasi/decoders/xz-decoder.wasm" "$public_html/lib/decoders/"
scripts/build-pack-assets.sh --dist-output "$public_html/pack"
S5_ASSET_DIR="$build_root/wasi" \
GHDL_ASSET_DIR="$build_root/ghdl-wasm" \
python3 "$root/scripts/build-synth-assets.py" \
  --output "$build_root/synth" \
  --dist-output "$public_html/synth"
mkdir -p "$public_html/surfer"
cp -R "$build_root/surfer/dist/." "$public_html/surfer/"
mkdir -p "$public_html/iverilog"
cp "$build_root/iverilog-wasm/output/"*.wasm "$public_html/iverilog/"
cp "$root/THIRD_PARTY_NOTICES.md" "$public_html/THIRD_PARTY_NOTICES.md"
mkdir -p "$public_html/licenses"
cp -R "$root/licenses/." "$public_html/licenses/"
if ! grep -Eq '^/\*' "$public_html/_headers" ||
  ! grep -Eq 'Cross-Origin-Opener-Policy: same-origin' "$public_html/_headers" ||
  ! grep -Eq 'Cross-Origin-Embedder-Policy: require-corp' "$public_html/_headers"; then
  printf 'COOP/COEP headers must cover the /surfer/* route.\n' >&2
  exit 1
fi
if ! grep -Fxq "  Content-Security-Policy: connect-src 'self' https://openrouter.ai; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'self'" "$public_html/_headers"; then
  printf 'The distribution must restrict connections to self and OpenRouter.\n' >&2
  exit 1
fi
python3 "$root/scripts/check-dist-size.py" "$public_html"

printf 'Assembled web app in %s from %s\n' "$public_html" "$artifacts"
