# S9 GHDL WASM の Os + LTO 安定性確認

- 状態: 不合格（候補の build が LTO link で失敗）
- 日付: 2026-10-30
- 担当: Devin
- 関連: PR #31、[凍結基準](S9-ghdl-os-lto-criteria.md)

## 目的と仮説

2026-10-30、ユーザーの判断に基づき、GHDL WASM の既定 build を `-Os -flto` にする前に、候補が安定して build・synthesis できるかを確かめる。比較対象は PR #31 の head `a4d826b` の既定 build（Ada `-O1`、C の `wasi.c` `-O2`、LTO なし）。候補は Ada と `wasi.c` の compile を `-Os -flto` にし、pinned WASI SDK の `wasm-ld` で LTO link する。

最初の候補 build が失敗したため、凍結基準に従って評価を停止した。候補は既定にせず、速度やサイズの比較は行わない。

## 採否の基準（結果を見る前に固定）

すべての条件を満たした場合だけ Os + LTO を採用する。全文は[凍結基準](S9-ghdl-os-lto-criteria.md)を参照する。第1条件は、AdaWebPack `llvm-gcc` と WASI SDK `wasm-ld` で LTO を使った build が成功すること。ここで失敗した場合は後続試験を行わず、基準へ戻す判断もしない。

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | PR #31 head `a4d826b` |
| GHDL source | `e589c698c351369ac5bcfe7abe1f1152ac5d4727` |
| ホスト | Ubuntu 26.04.1 LTS、Linux x86_64、12 CPU、30 GiB memory |
| AdaWebPack | 24.0.0、archive SHA-256 `8edaae8b9987a20aec430d750f30033f12f953ce2b6437afb87fbf8cc1063796` |
| WASI SDK | 34.0、clang 23.1.0-wasi-sdk、LLD / `wasm-ld` 23.1.0 |
| GCC libgnat | pinned source `ed10445fe222d3973ae13eda9bf211f315c5e3f9` |
| host libgnat | 14.3.0-14ubuntu1 |
| Node.js | v24.22.1。候補 build の失敗後に `mise` 経由で版を確認。Node test は未実行 |
| build root | `build/S9/OsLTO-probe`。出力用の clean root。依存 cache は再利用 |
| 基準の flags | Ada `-O1`、`wasi.c` `-O2`、LTO なし。baseline build は未実行 |
| 候補の flags | Ada `-Os -flto`、`wasi.c` `-Os -flto`、link `-Os -flto` |
| 繰り返し | 候補の clean build を1回実行。第1条件の失敗で停止 |

## 手順

候補 build は一時的に追加した variant 対応で実行し、失敗後に build script の変更を取り除いた。記録した command と build log は次のとおり。

```sh
GHDL_WASM_BUILD_ROOT=build/S9/OsLTO-probe JOBS=2 scripts/build-ghdl-wasm.sh
```

log の SHA-256 は `94b242c5446537d626b361d0c76b04103c350ae5c8348a251c4a81be2d1bcbbd`。候補の flags は log 冒頭に記録され、生成した GPR project の Ada switches にも `-Os -flto` がある。WASI SDK clang `-v` の出力は、同じ SDK にある `wasm-ld` を呼び出したことを示す。

## 計測器の検証

候補 build が第1条件を満たさなかったため、A/A 試行、synthesis test、negative control は実行していない。後続の結果判定には使用していない。

## 結果

| 凍結基準 | 結果 | 証拠 |
|---|---|---|
| 1. LTO を使った候補 build が成功 | 不合格 | `wasm-ld` が `sqrtf` と `sqrt` の重複シンボルを報告して link に失敗。log 3077–3084行 |
| 2. clean build 2回の WASM と libraries archive が一致 | 未実施 | 第1条件の失敗で停止 |
| 3. GHDL WASM test が8/8を5回連続で通過 | 未実施 | 第1条件の失敗で停止 |
| 4. 6 fixture の native / WASM Verilog が一致 | 未実施 | 第1条件の失敗で停止 |
| 5. 4 board の `.fs` parity が5回一致 | 未実施 | 第1条件の失敗で停止 |
| 6. 既存 negative control が失敗を検出 | 未実施 | 第1条件の失敗で停止 |

候補 build の結果から、`wasi.c` の object は LLVM IR bitcode（SHA-256 `2dec4a210c3576abc165e7169cdc622b62e29d268bdaa0ee96d91f24c9e93461`）でした。一方、Ada runtime の `a-calend.o` は WebAssembly object（SHA-256 `db0b4ebd2e1275e6472de03770c17023372533073e2cc7375846ab348e950d1b`）でした。これらは候補 build で観測した形式です。失敗原因を切り分ける追加試験は行っていません。

link の error は次のとおりです。

```text
wasm-ld: error: duplicate symbol: sqrtf
>>> defined in libgnat_wasm.a(s-lisisq.o)
>>> defined in wasi-sysroot/libc.a(math-builtins.c.obj)
wasm-ld: error: duplicate symbol: sqrt
>>> defined in libgnat_wasm.a(s-lidosq.o)
>>> defined in wasi-sysroot/libc.a(math-builtins.c.obj)
clang: error: linker command failed with exit code 1
```

生の build log は `build/S9/OsLTO-probe/ghdl-wasm/build.log` にあります。最終 WASM と `libraries.tar.gz` は生成されていません。結果 CSV は [S9/results.csv](S9/results.csv) です。

## 記録するだけの指標

WASM の raw / gzip / zstd size と、Node で6 fixture を5回ずつ合成した median は未計測です。候補 build が失敗したため、baseline との比較も行っていません。

## 捨てた試行と経緯

| run | 結果 | 理由 |
|---|---|---|
| `S9-OsLTO-probe` | LTO link 失敗 | `wasm-ld` が `sqrtf` と `sqrt` の duplicate symbol で停止。凍結基準に従い、flag 変更や再試行をせず評価を終了 |

## 結論

凍結基準の第1条件を満たさなかったため、Os + LTO は不採用です。既定 build は PR #31 の状態（Ada `-O1`、`wasi.c` `-O2`、LTO なし）のままです。原因を探るための追加試験や fallback は行っていません。異なる build option を比較する場合は、別の凍結基準を先に定めます。

## 未確認の点

第1条件の失敗により、再現性、synthesis の結果、4 board parity、negative control、size、median synthesis time はすべて未確認です。本記録では Os + LTO の採否だけを判定しました。

## Build log

候補 build log は `build/S9/OsLTO-probe/ghdl-wasm/build.log` にあり、SHA-256 は `94b242c5446537d626b361d0c76b04103c350ae5c8348a251c4a81be2d1bcbbd` です。再生成 command は「手順」に記載しています。
