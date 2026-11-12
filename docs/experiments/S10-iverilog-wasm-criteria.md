# S10 Icarus Verilog の WASM 化の基準（測る前に固定）

- 決定日：2026-10-30
- 対象：Icarus Verilog v13_0（`vendor/iverilog`、shallow submodule）
- 目的：`ivlpp`・`ivl`（tgt-vvp を静的にリンク）・`vvp`（system.vpi を静的にリンク）を WASM にし、ブラウザーと Node で動かす。

## ビルドの方式

1. まず WASI SDK（既存の Yosys と同じ版）で試す。dlopen は、静的な表を引く patch（`patches/iverilog/`）に置き換える。`iverilog` のドライバーは使わず、3 つの段の呼び出しはホスト側（JS）で行う。
2. WASI SDK で通らない理由（例外、プロセス、シグナルなど）が、ログで示せた場合だけ Emscripten に切り替える。理由と失敗のログを記録する。

## 合格の条件（すべて満たすこと）

1. ビルドが成功する。
2. ゼロからのビルドを 2 回行い、3 つの WASM がバイト単位で一致する。
3. 例（下記）すべてで、ネイティブ版（同じ commit のネイティブビルド）と、`vvp` の標準出力と VCD がバイト単位で一致する。
4. 負の対照：構文の誤り、未定義のモジュール、`$fatal` で、ネイティブ版と同じ失敗（終了コードと診断の行）になる。WASM を 1 バイト壊すと失敗する。
5. テストを 5 回続けて通す。

## 例

- 4 ボードの Verilog テンプレートの counter に、`$dumpvars` と `$display` を付けた testbench（`#` の遅延で数周期だけ回す）
- 組み合わせ回路、FSM、`` `include `` と `` `define ``、`$readmemh`、`generate`、`$finish` で止める例

## 記録

- `docs/experiments/S10-iverilog-wasm.md`、生の値は `docs/experiments/S10/`。WASM の大きさ（生、gzip、zstd）と、Node での時間は記録だけ（最適化の比較は別の段で行う）。
