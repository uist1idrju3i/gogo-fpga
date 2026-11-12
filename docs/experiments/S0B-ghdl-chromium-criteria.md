# S0B GHDL WASM の Chromium での測定（測る前に固定）

- 決定日：2026-10-30
- 目的：T3 S0 の本番の測定。GHDL の WASM の時間を Node と Chromium で記録する。あわせて、S9B で測れなかった Chromium での Os と B0 の時間を、記録として取る。
- 採否はしない：既定は S9B のユーザーの判断で Os に決まっている。この測定の結果で既定を変えない。

## 対象

- 版：PR #33 の head の既定ビルド（Os）。比較の記録用に `scripts/build-ghdl-wasm.sh --variant=B0` のビルド。
- 例：`tests/synth/ghdl-wasm.test.mjs` の正例 7 つ（S9B の 6 つと、T3 その 2 で加えた VHDL-2019 の `VHDL-2019 named return identifier`。この例だけ `standard: "2019"` で実行し、ネイティブ版は `--std=19` と比べる）と、4 ボードの VHDL テンプレート（`createBlinkTemplate(board, "vhdl")`）。S9B と比べるときは、6 つの例だけの合計も別に書く。

## 測り方

- Chromium：Playwright の headless Chromium（`@playwright/test` の固定版）。`web/lib/ghdl-host.mjs` の `runGhdlSynth` を、配信した `dist/` の module Worker の中で呼ぶ。
- 1 回の値：例ごとに、`WebAssembly.instantiate` の開始から `runGhdlSynth` が Verilog を返すまで（インスタンス化を含む）。`WebAssembly.compile` は案ごとに 1 回で、別の列に記録する。
- 回数：各案・各例 5 回以上。回ごとに案の順番を入れ替える（1 回目は Os→B0、2 回目は B0→Os…）。最初に 1 回の空回し（記録しない）を行う。
- Node：同じ例を `node --test` ではなく専用の測定スクリプトで、同じ回数・同じ順番の規則で測る。
- 4 ボードの例では、GHDL のあとの Yosys・nextpnr・gowin_pack の時間も、既存の `timings` から記録する。

## 正しさの確認（各回）

- 各回の Verilog の SHA-256 が、ネイティブ版 GHDL の出力と一致すること。一致しない回は値を捨てずに記録し、結果を「不合格」とする。
- 4 ボードの例は、各回の `.fs` の SHA-256 がネイティブの経路と一致すること。
- 負の対照：わざと壊した WASM（1 バイト書き換え）で測定スクリプトが失敗すること。Verilog の期待値を書き換えると不一致を検出すること。

## 記録

- `docs/experiments/S0B-ghdl-chromium.md` と `docs/experiments/S0B/results.csv`（案、環境、例、回、順番、compile ms、run ms、Verilog SHA-256、一致、メモリー）。
- 中央値、最小、最大、幅を案・例ごとに書く。Os と B0 の差は記録として書き、採否の言葉は使わない。
- 環境：Chromium と Node の版、CPU、コア数、メモリー、base commit。
- この節の例の数は、測定を始める前（2026-10-30）に 6 から 7 に直した。理由：T3 その 2 で正例が 1 つ増えたため。
