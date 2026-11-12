# S10 Icarus Verilog v13_0 の WASI WASM 化

- 状態: 完了
- 日付: 2026-10-30
- 関連: [凍結基準](S10-iverilog-wasm-criteria.md)

## 目的と基準

Icarus Verilog v13_0 の `ivlpp`、`ivl`、`vvp` を WASI Preview 1 の WASM にし、ブラウザー・Node の WASI host から実行できるかを検証しました。基準は最初のブランチ commit `37b236d` に凍結した文書のとおりです。基準の変更や Emscripten への切り替えはありません。

## 条件と手順

| 項目 | 値 |
|---|---|
| Icarus | tag `v13_0`、peeled commit `dfeee909ed9f20b4870dd93423156c0170c0e1ff` |
| WASI SDK | 34.0、Linux x86_64 archive SHA-256 `b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4` |
| WASI 例外 | SDK 34.0 の `eh/libc++abi.a` と `eh/libunwind.a`。SDK の [C++ exception documentation](https://raw.githubusercontent.com/WebAssembly/wasi-sdk/wasi-sdk-34/CppExceptions.md) を参照 |
| ホスト | Ubuntu 26.04.1 LTS、Intel Xeon D-1531 @ 2.20 GHz、12 logical CPU、30 GiB RAM |
| Node / Chromium | Node v24.22.1、Playwright 1.64.1、Chromium 156.0.8078.4 |
| EH probe | Node と Chromium で exception を throw/catch し、双方で `WASM_EH_OK` を確認。log: `build/S10/exception-probe-node.log`, `build/S10/exception-probe-chromium.log` |
| WASI build | `build/S10/wasi-eh-build18` と `build/S10/wasi-eh-build19` |
| native build | `build/S10/native-final8` |
| 実行方式 | `scripts/build-iverilog-wasm.sh`、native reference は `--native` |

以下のコマンドで再実行できます。

```sh
IVERILOG_BUILD_ROOT=build/S10/wasi-eh-build18 JOBS=2 scripts/build-iverilog-wasm.sh
IVERILOG_BUILD_ROOT=build/S10/wasi-eh-build19 JOBS=2 scripts/build-iverilog-wasm.sh
IVERILOG_BUILD_ROOT=build/S10/native-final8 JOBS=2 scripts/build-iverilog-wasm.sh --native
IVERILOG_WASM_DIR=build/S10/wasi-eh-build18/output \
IVERILOG_NATIVE_DIR=build/S10/native-final8/output \
node --test tests/synth/iverilog-wasm.test.mjs
```

## 結果

| artifact | bytes | gzip -9 bytes | zstd -19 bytes | SHA-256 |
|---|---:|---:|---:|---|
| `ivlpp.wasm` | 428,432 | 142,149 | 125,975 | `7ab296df67635fc272b5dfa95c3e0e5f0e7176271b4035d26f847e266c6936af` |
| `ivl.wasm` | 6,630,370 | 1,652,779 | 1,334,178 | `936223cd9204283fe16a1b3232684a9766573088d2d0da3fa08a2c94fcfdb30f` |
| `vvp.wasm` | 4,824,816 | 1,268,575 | 1,031,036 | `909014061e6dbde49f2f86b47c4a2b536abaea0c79678a7b901e6b816de1bc83` |

### 凍結基準の結果

| 基準 | 結果 |
|---|---|
| WASI と native の build | どちらも成功 |
| 再現性 | 別 build root `wasi-eh-build18` / `wasi-eh-build19` の3つの WASM がすべて byte-identical |
| native/WASI parity | 7つの Verilog fixture と4ボードの Verilog blink template で stdout と VCD が byte-identical。VCD の wall-clock date は `SOURCE_DATE_EPOCH=0`、双方の timezone は `UTC` に固定 |
| negative controls | syntax error、undefined module、`$fatal` の status と診断行が native/WASI で一致。`.vhd` は指定診断で非0終了し、破損 WASM は WebAssembly validator が拒否 |
| 5回連続実行 | 各回5/5 test case 成功。Node suite 時間の中央値 972.691 ms、最小 910.082 ms、最大 1,022.195 ms、範囲 112.113 ms |

suite 時間は fixture ごとの実行時間比較や最適化選定には使っていません。

生のサイズ、hash、再現性、試験結果は [S10 results.csv](S10/results.csv) に記録しました。5回の Node test suite 所要時間は [tests.csv](S10/tests.csv) に記録しました。build-info は各 build root の `build-info.json` にあります。

## 適用した制限と理由

### VHDL 入力

`ivlpp` の `vhdlpp` 経路は `popen` / `pclose` を呼びます。WASI では process API がなく、この段階では VHDL 入力を対象にしないため、WASI 用 patch は `.vhd` / `.vhdl` を明示的に拒否し、残る `vhdlpp` subprocess 経路も同じ診断で非0終了します。native の VHDL 対応は変更しません。

### 任意の preprocessor subprocess

`ivl` の `ivlpp` subprocess 指定は WASI で拒否します。browser host が前段の `ivlpp` を別 module として実行し、前処理済み Verilog を `ivl` に渡すため、この subprocess は不要です。

### 動的 target / VPI loading

WASI target と VPI loading は `dlopen` / `dlsym` に依存するため、`vvp` target と `system.vpi` のみを静的に組み込みます。`system` 以外の VPI module は明示的に拒否し、driver `iverilog` や動的 VPI module は配布対象にしません。

### signal handling

`vvp` の POSIX signal handlers は WASI にないため無効にしました。通常の Verilog simulation は signal を使わず、`$finish` による終了を fixture で確認しています。signal による中断・終了は本 build では未対応です。

### zlib

native configure が zlib を検出したときだけ `-lz` を link します。WASI configure は zlib を検出しないため zlib API に依存しません。

### `poll_oneoff`

WASI shim は `NOSYS` を返します。test host の callback で呼び出しを計数し、7 fixture と4ボード template の positive simulation では呼び出しが0回であることを確認しました。将来この import が必要になる実行経路には実装が必要です。

### VCD date

再現可能な日時比較のため、`SOURCE_DATE_EPOCH` が設定されたときだけ固定時刻を使う patch を追加しました。未設定時の上流動作は現在時刻のままです。

パッチは `patches/iverilog/static-wasi.patch` に置き、`vendor/iverilog` は変更していません。例外は `-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false` と `-lunwind` を使いました。WASI SDK 34.0 の EH variant が利用でき、Node 24 と Chromium の probe が `WASM_EH_OK` を出力したため、Emscripten への切り替えは不要でした。`-fno-exceptions` は使用していません。

## 失敗した試行

初期 build の失敗は `build/S10/build-wasi.log`、`wasi-build-1.log`〜`wasi-build-7.log`、`wasi-eh-build1.log`〜`wasi-eh-build8.log` にあります。version header と dependency file の生成・移動、VHDL `popen` / `pclose`、signal / dynamic loading、core `__cxa_*` link failure、patch 構文・context の問題を含みます。VHDL は明示的に拒否し、target/VPI と signal は WASI 向けに guard / 静的化し、EH は SDK 34 libraries で有効化しました。

`build/S10/wasi-eh-build10.log`〜`wasi-eh-build13.log` と `native-final2.log`〜`native-final5.log` は static VPI の conditional/include context と schedule patch hunk が不完全な試行です。patch を直して解消しました。`native-final6.log` は native static system VPI の zlib symbol が未解決でした。configure 結果が `HAVE_LIBZ='yes'` のときだけ `-lz` を加え、native-final7/8 で成功しました。

`build/S10/wasi-eh-build17.log` は VCD date patch の hunk が不正だった試行です。hunk を修正し build18/19 が成功しました。`test-host3.log` は native/WASI の診断 path が異なった試行で、WASI host から相対 path を渡して一致させました。

過去の log は `build/S10/` に保持しています。最終 build と test の log は `build/S10/wasi-eh-build18.log`、`build/S10/wasi-eh-build19.log`、`build/S10/native-final8.log` です。

## 結論と未確認事項

凍結した5条件を満たしました。WASI 方式を維持し、Emscripten は使用していません。`.vhd` / `.vhdl`、動的 VPI module、signal による制御、任意 `ivlpp` subprocess はこの browser build では未対応です。対象 fixture と board template の範囲を越える Icarus 機能、実機 FPGA、ブラウザー UI 統合は本段階では試していません。
