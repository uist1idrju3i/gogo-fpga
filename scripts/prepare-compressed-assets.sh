#!/bin/sh
# Compress the large web assets with each candidate format for scripts/bench-decompress.mjs.
set -eu
dist=${1:?usage: prepare-compressed-assets.sh <dist-dir>}
out="$dist/bench"
if [ -e "$out" ]; then
  echo "$out already exists; remove it first" >&2
  exit 1
fi
mkdir -p "$out"
assets="synth/yosys.wasm synth/nextpnr-himbaechel-gowin.wasm synth/yosys-share.tar pack/pyodide/pyodide.asm.wasm synth/chipdb/chipdb-GW1NZ-1.bin synth/chipdb/chipdb-GW1NS-4.bin synth/chipdb/chipdb-GW1N-9C.bin synth/chipdb/chipdb-GW2A-18C.bin"
index="$out/index.tsv"
printf 'path\tsize\tsha256\tformat\tcompressed_size\tcompressed_sha256\n' > "$index"
for asset in $assets; do
  src="$dist/$asset"
  size=$(wc -c < "$src" | tr -d ' ')
  sha=$(sha256sum "$src" | cut -d' ' -f1)
  name=$(echo "$asset" | tr '/' '_')
  gzip -9 -n -c "$src" > "$out/$name.gz"
  zstd -19 -q -c "$src" > "$out/$name.zst"
  xz -9e -T1 -c "$src" > "$out/$name.xz"
  for format in gzip zstd xz; do
    case $format in gzip) file="$out/$name.gz" ;; zstd) file="$out/$name.zst" ;; xz) file="$out/$name.xz" ;; esac
    csize=$(wc -c < "$file" | tr -d ' ')
    csha=$(sha256sum "$file" | cut -d' ' -f1)
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$asset" "$size" "$sha" "$format" "$csize" "$csha" >> "$index"
  done
done
echo "wrote $index"
