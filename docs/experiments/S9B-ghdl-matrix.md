# S9B GHDL WASM 最適化マトリクス

- 状態: 採用：Os（ユーザーの判断、基準からの逸脱）
- 日付: 2026-10-30
- 担当: Devin
- 関連: [S9B 凍結基準](S9B-ghdl-matrix-criteria.md)、S9 の [凍結基準](S9-ghdl-os-lto-criteria.md) と [記録](S9-ghdl-os-lto.md)

## 目的と仮説

S9 の Os + LTO 候補はリンクに失敗した。そこで、ユーザーの判断に基づき、LTO を使わない O1、O2、O3、Os と O3 + LTO を、PR #31 の既定値 B0 と比較する。まず再現性、6 例の合成、4 ボードの `.fs` parity、負の対照を調べ、すべてを通過した候補だけを速度評価に進める。

S9B の凍結基準では、速度の採否判定に S7 と同じ Chromium / Playwright の測定が必要である。既存の GHDL WASM 用ブラウザー測定 harness がなく、追加実装には大きな作業が必要と判明したため、Chromium の測定は行わなかった。測定後の2026-10-30、ユーザーは凍結した速度基準から逸脱し、成果物サイズを理由に Os を既定として採用する判断をした。Node の時間は判断に使っていない。

## 採否の基準（測定前に固定）

全文は[S9B 凍結基準](S9B-ghdl-matrix-criteria.md)を参照する。B0 は Ada `-O1`、`wasi.c` `-O2`、LTO なし。候補は O1、O2、O3、Os、O3 + LTO とする。Os + LTO は S9 のリンク失敗を引き継ぎ、再試行しない。

安定性条件 1-6 をすべて満たした候補だけを Chromium で比べる。6 例の合成時間合計が最小で、B0 より 3% 以上速く、かつ差が B0 の5回の範囲より大きい場合に採用する。該当候補がない場合は B0 を保つ。Node の値と成果物サイズは記録のみとする。

## 条件

| 項目 | 値 |
|---|---|
| 比較元 | `origin/main` `59eee0e`（PR #31 squash merge 後）。S9B 作業開始時の HEAD は `d52f4d9` |
| build selector | `c075e97`。既定の B0 は main の既定 build と一致することを SHA-256 で確認 |
| GHDL | 6.0.0、commit `e589c698c351369ac5bcfe7abe1f1152ac5d4727` |
| ホスト | Ubuntu 26.04.1 LTS、Linux x86_64、Intel Xeon CPU D-1531 @ 2.20 GHz、12 CPU、30 GiB memory |
| AdaWebPack | 24.0.0 |
| WASI SDK | 34.0、clang 23.1.0-wasi-sdk、LLD / `wasm-ld` 23.1.0 |
| GCC libgnat | pinned source `ed10445fe222d3973ae13eda9bf211f315c5e3f9` |
| Node.js | v24.22.1（`mise exec -- node --version`） |
| gzip / zstd | gzip 1.14 / zstd 1.5.7 |
| 固定値 | `SOURCE_DATE_EPOCH=1772905660`、`JOBS=2`。各 clean build は別の `build/S9B/<variant>-A|B` と `/tmp/ghdl-s9b/<variant>-A|B` を使用 |
| 変えた条件 | Ada と `wasi.c` の最適化段階、O3 + LTO の LTO link |
| 変えない条件 | GHDL source、WASI SDK、AdaWebPack、library、test fixture、build script の他の設定 |
| 繰り返し | 成功候補ごとに別の clean root で2 build。各 A build で Node test を連続5回実行 |

このビルドは Node の `ExperimentalWarning: WASI is an experimental feature` と、GNAT の `No_Exception_Propagation` 警告を出す。警告は全候補で見られ、成功した build / test の終了コードを変えなかった。

## 手順

各候補の clean build は次の形式で実行した。`VARIANT` と A/B の出力先を置き換え、build の間は並列実行しない。

```sh
GHDL_WASM_BUILD_ROOT=build/S9B/VARIANT-A \
GHDL_WASM_SCRATCH_ROOT=/tmp/ghdl-s9b/VARIANT-A \
JOBS=2 scripts/build-ghdl-wasm.sh --variant=VARIANT

GHDL_WASM_BUILD_ROOT=build/S9B/VARIANT-A \
GHDL_WASM_EXPORT_DIR=build/S9B/VARIANT-A/verilog \
GHDL_WASM_TIMING_RUN=VARIANT-1 mise exec -- node --test --test-concurrency=1 \
  tests/synth/ghdl-wasm.test.mjs
```

A の Node test を `VARIANT-1` から `VARIANT-5` まで5回連続で実行し、B を別の clean root に build した。実際のコマンドと各回の実行時間は `build/S9B/` の各 log にある。サイズは raw WASM、`gzip -n -9`、`zstd -19`、`libraries.tar.gz` を測定した。

## 計測器の検証

5回の Node test は毎回6つの正例を実行し、各例で native GHDL と WASM の Verilog が byte-identical であることを検査した。syntax error と semantic error の負の対照も test 内で検査する。B0 と O1 の4ボード parity を実行し、O1、O2、O3、Os の `top.v` が B0 と同一 hash であることを確認した。4ボード parity は各候補と同じ input を使うため、この parity 結果を各候補に適用した。

## 結果

| Variant | Ada / C flags | clean build | WASM SHA-256 | libraries SHA-256 | raw / gzip / zstd / libraries (bytes) | 5回の8/8 test | 出力・負の対照 |
|---|---|---|---|---|---|---|---|
| B0 | `-O1` / `-O2` | pass | `aa851b370a40ce4bf8bce6143a0293840c31ee13c5161e6597fedc8d4538400d` | `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` | 2,066,717 / 638,186 / 533,797 / 455,929 | pass | 6 fixture native/WASM parity、4-board parity、negative controls pass |
| O1 | `-O1` / `-O1` | 2回一致 | `ca884b3a98819afd907ae112206ecd20bbbe7417b58ecdef9f97f7db9c99f892` | `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` | 2,066,768 / 638,217 / 534,029 / 455,929 | pass | 6 fixture native/WASM parity、4-board parity、negative controls pass |
| O2 | `-O2` / `-O2` | 2回一致 | `c74fb667cc939089d8ea2d5e165948932c5dab099b9ca66d953ee5f84752748d` | `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` | 2,001,285 / 611,812 / 510,680 / 455,929 | pass | 6 fixture native/WASM parity、4-board parity、negative controls pass |
| O3 | `-O3` / `-O3` | 2回一致 | `90d807be0674ba7d59cdcdb7fc37b2c776cc2240f8a273c610675309de9cf77d` | `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` | 2,046,317 / 620,301 / 517,192 / 455,929 | pass | 6 fixture native/WASM parity、4-board parity、negative controls pass |
| Os | `-Os` / `-Os` | 2回一致 | `c74fb667cc939089d8ea2d5e165948932c5dab099b9ca66d953ee5f84752748d` | `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` | 2,001,285 / 611,812 / 510,680 / 455,929 | pass | 6 fixture native/WASM parity、4-board parity、negative controls pass |
| O3 + LTO | `-O3 -flto` / `-O3 -flto` | fail | link failure | link failure | 未生成 | 未実施 | `wasm-ld` duplicate symbol |
| Os + LTO | S9 の候補 | 再試行なし | - | - | - | 未実施 | S9 の失敗を引き継ぐ |

B0 の default build は、PR #31 の main default と WASM / libraries の SHA-256 が一致する。O1 の各 build は401秒、O2 は406秒 / 405秒、O3 は403秒 / 403秒、Os は403秒 / 401秒であった。A と B の artefact は各候補で一致した。

### Node の記録値

Node の測定は記録のみとし、Chromium の採用判断には使わない。各 fixture の表記は「5回の中央値 / 最大 - 最小（ms）」である。

| Fixture | B0 | O1 | O2 | O3 | Os |
|---|---:|---:|---:|---:|---:|
| combinational logic | 68.587 / 5.536 | 70.158 / 3.826 | 69.776 / 1.872 | 72.675 / 4.046 | 70.063 / 5.594 |
| numeric_std counter | 62.562 / 14.811 | 61.973 / 1.302 | 60.002 / 4.768 | 61.092 / 1.590 | 60.360 / 10.360 |
| generic entity | 31.224 / 10.293 | 35.277 / 12.520 | 37.263 / 5.151 | 34.530 / 9.309 | 34.340 / 5.036 |
| FSM | 51.014 / 8.508 | 54.135 / 4.548 | 54.917 / 13.279 | 51.448 / 3.557 | 50.993 / 11.026 |
| package dependency and entity instantiation | 35.195 / 13.255 | 34.867 / 13.471 | 41.140 / 6.434 | 33.794 / 4.339 | 32.524 / 9.428 |
| Tang Nano 20K LED blink | 52.008 / 12.784 | 50.377 / 10.856 | 54.150 / 8.997 | 52.606 / 9.508 | 46.062 / 11.831 |

| Variant | 6 fixture 合計の median (min-max; spread) |
|---|---:|
| B0 | 298.664 (282.433-312.913; 30.480) ms |
| O1 | 311.267 (297.516-327.207; 29.691) ms |
| O2 | 319.443 (311.983-330.015; 18.032) ms |
| O3 | 309.304 (296.179-316.683; 20.504) ms |
| Os | 296.015 (284.525-310.812; 26.287) ms |

O2 と Os の `ghdl-synth.wasm` は別々の build root（`build/S9B/O2-*` と `build/S9B/Os-*`）で byte-identical となり、SHA-256 は両方 `c74fb667cc939089d8ea2d5e165948932c5dab099b9ca66d953ee5f84752748d` だった。一方、Node の6例合計 median は O2 が319.443 ms、Os が296.015 msで7.9%離れた。Node の変種間の時間差はノイズの範囲とみなし、採用には使わなかった。

Os は B0 に比べ raw が2,001,285 bytes（-3.2%、B0 は2,066,717）、gzip が611,812 bytes（-4.1%、B0 は638,186）、zstd が510,680 bytes（-4.3%、B0 は533,797）だった。`libraries.tar.gz` は両方455,929 bytes。成果物だけが一致した事実から、AdaWebPack llvm-gcc が Ada の `-Os` を `-O2` と同じ生成コードにした可能性があるが、object file と最適化 pass は調べていないため推測である。Chromium の速度基準は未評価であり、T3-2 の UI 統合後にブラウザー内測定を再検討する。6 fixture ごとの5回分の生データ、実行順、build size は [CSV](S9B/results.csv) に記録した。各回の実行 log は `build/S9B/<variant>/tests-5x.log` にある。

### Chromium 測定と採否

S7 と同じ方法で GHDL WASM を load して測る既存の Chromium / Playwright harness は見つからず、作成には大きな作業が必要である。凍結基準に従い、Chromium 計測は行わず、Node を代用しない。候補の Chromium median と B0 の5回幅を比較できなかったため、凍結基準による速度採用資格は判定していない。測定後、ユーザーが成果物サイズを理由に Os を選ぶ判断をした。

## 既定変更後の確認

2026-10-30、引数なしで `scripts/build-ghdl-wasm.sh` を実行した clean build は、`build/S9B/Os-A` の成果物と byte-identical だった。`ghdl-synth.wasm` は2,001,285 bytes、SHA-256 `c74fb667cc939089d8ea2d5e165948932c5dab099b9ca66d953ee5f84752748d`、`libraries.tar.gz` は455,929 bytes、SHA-256 `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` である。build-info は variant `Os`、Ada / `wasi.c` とも `-Os`、LTO なしを記録した。log は `build/S9B/default-Os-build.log`。

`--variant=B0` でも clean build し、`ghdl-synth.wasm` は2,066,717 bytes、SHA-256 `aa851b370a40ce4bf8bce6143a0293840c31ee13c5161e6597fedc8d4538400d`、`libraries.tar.gz` は同じ SHA-256 と455,929 bytesとなった。build-info は Ada `-O1`、`wasi.c` `-O2`、LTO なしを記録した。log は `build/S9B/B0-explicit-build.log`。

新しい既定 build を使った `tests/synth/ghdl-wasm.test.mjs` は1回で8/8成功した。6つの正例すべてで native / WASM の Verilog が byte-identical となり、syntax error と semantic error の負の対照も成功した。log は `build/S9B/default-Os/tests-default.log`。4 board の `.fs` parity は S9B の Os で既に確認済みであり、新しい既定 WASM がその Os artifact と byte-identical であることを再確認した。raw CSV の値は変更していない。

## 捨てた試行と経緯

| 試行 | 結果 | 理由 |
|---|---|---|
| O1-A | discarded | 他 build と GCC libgnat checkout を同時に使い、setup 中に `fatal: shallow file has changed since we read it` が発生。build race として破棄し、逐次の O1-A2 と O1-B を成功させた。候補の失敗には数えない |
| O3 + LTO | 第1条件で fail | `wasm-ld` が `sqrtf` と `sqrt` の duplicate symbol で link に失敗。回避変更や再試行はしない |
| Os + LTO | 未実施 | 凍結基準が S9 の同じリンク失敗を引き継ぎ、再試行を禁止 |
| Chromium | 未実施 | 既存の GHDL WASM harness がなく、大きな実装を避ける基準に従った |

## 結論

採用：Os（ユーザーの判断、基準からの逸脱）。O1、O2、O3、Os は安定性条件を通過し、O3 + LTO は link に失敗した。Chromium の測定は行っておらず、凍結した速度基準を満たした候補としての採用ではない。ユーザーは、B0 より raw / gzip / zstd の各サイズが小さいことを理由に Os を選んだ。Node 時間は判断に使っていない。既定 build を Os（Ada と `wasi.c` が `-Os`、LTO なし）にし、`--variant=B0` で旧既定を再現できるようにする。T3-2 UI 統合後の Chromium 測定を follow-up とする。

## 未確認の点

- O1、O2、O3、Os の Chromium 合成時間、候補と B0 の相対差、B0 の Chromium 5回幅。T3-2 UI 統合後に再測定を検討する。
- O3 + LTO の再現性、test、native parity、size。第1条件の失敗後は試していない。
- Os + LTO は S9 の失敗を引き継いだため、本 matrix で再実行していない。

## ログ

clean build、test、4-board parity、失敗試行のログは `build/S9B/` に保存し、commit には含めない。

| 内容 | Log |
|---|---|
| B0 build / 5回 test | `build/S9B/B0-main-clean-B/ghdl-wasm/build.log` / `build/S9B/B0-main-clean-B/tests-5x.log` |
| O1 build / test / board parity | `build/S9B/O1-A2/ghdl-wasm/build.log` / `build/S9B/O1-A2/tests-5x.log` / `build/S9B/O1-A2/four-board.log` |
| O1 clean build B、discarded race | `build/S9B/O1-B/ghdl-wasm/build.log` / `build/S9B/O1-A/ghdl-wasm/build.log` |
| O2 build A/B / 5回 test | `build/S9B/O2-A/ghdl-wasm/build.log` / `build/S9B/O2-B/ghdl-wasm/build.log` / `build/S9B/O2-A/tests-5x.log` |
| O3 build A/B / 5回 test | `build/S9B/O3-A/ghdl-wasm/build.log` / `build/S9B/O3-B/ghdl-wasm/build.log` / `build/S9B/O3-A/tests-5x.log` |
| Os build A/B / 5回 test | `build/S9B/Os-A/ghdl-wasm/build.log` / `build/S9B/Os-B/ghdl-wasm/build.log` / `build/S9B/Os-A/tests-5x.log` |
| O3 + LTO failure | `build/S9B/O3-LTO/ghdl-wasm/build.log`（SHA-256 `49027a7f475e777cbe29abc2055ffea8b80b15a7203b11948b2d770b71f1615b`） |
