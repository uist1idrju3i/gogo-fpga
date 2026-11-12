# S1b: WASM オプション行列

## 状態

- 状態: 完了
- 日付: 2026-10-25
- 基準 commit: `5338165528f6918f25ed03d4e6449d91df613ab2`
- 関連: PR #1

## 目的と事前に固定した判定基準

JSPI/pthread の基準 B に対し、指定された因子を一つずつ変えて測定する。候補は B, O2, O3, Oz, LTOL, LTOA, EHX, MG, M64, DL, MI, CL, EC, TD2, DE0, ST1M, P2P, SIMD。候補の追加・削除、閾値の変更はしない。ASYNCIFY はこの VM の対象外。

全候補で JSPI、pthread、全 compile/link の `-fwasm-exceptions`、縮小 Gowin/FTDI 構成、file-prefix-map、MODULARIZE/ESM、STRICT、指定 export、`-lembind` を固定する。openFPGALoader CMake の既定 `ENABLE_OPTIM=ON` は別途 `-O3` を注入するため `OFF` にし、選択した一つの最適化 level を使う。B は `-Os`、LTO なし、legacy Wasm EH、32 MiB initial memory、emmalloc、既定 stack、その他の matrix 設定なし。各 compile/link line に最適化指定が一つだけあることを `flags.make`、libusb の `Makefile`、最終 `link.txt` で確認する。

各 build は直列に実行する。build 成功候補は `node --test tests/sim/*.test.mjs` を5回連続で実行し、失敗、hang、非決定結果があればその候補を不採用とする。gate pass 候補のみ、8 positive programming case と instantiate を各7回測る。候補を repeat ごとに round-robin で交互に実行し、全生値を CSV に残す。

speed の比較値は8 programming caseそれぞれの median の合計。因子は B より3%を超えて速く、かつ8 case中5 case以上で因子と B の min/max 範囲が重ならない場合のみ wins とする。範囲が重ならない向きは問わない。それ以外は B を採る。LTO、最適化level、malloc、memoryのように候補が競合する場合は該当 group 内の total-of-medians 最小候補を採り、同値なら wasm gzip が小さい方を使う。C は B と採用因子の合成とし、C 自身の gate pass と B 以下の total-of-medians を採用条件にする。

## 条件

| 項目 | 値 |
|---|---|
| 基準 commit | `5338165528f6918f25ed03d4e6449d91df613ab2` |
| ホスト | Ubuntu 22.04.5 LTS, Linux 6.8.0-1061-aws, x86_64; 2 CPU; 7 GiB VM、16 GiB swap |
| 空き容量 | matrix driver 開始時 57,659,699,200 bytes |
| 使ったツール | Emscripten 6.0.13 (`e13ee988ce3d87a738dd8f3661d02223308c412a`), Node.js v24.21.0, Python 3.12.13, openFPGALoader v1.2.0, Homebrew Autotools: Autoconf 2.73, Automake 1.19, libtool 2.6.2 |
| 出力先と状態 | 候補ごとに `build/s1b/<ID>/`; 新規出力のみ。build は逐次、`JOBS=2` |
| 変える条件 | B + O2, O3, Oz, LTOL, LTOA, EHX, MG, M64, DL, MI, CL, EC, TD2, DE0, ST1M, P2P, SIMD |
| 変えない条件 | JSPI/pthread、Gowin/FTDI reduced config、`-fwasm-exceptions`、Release build、memory/export/runtime 設定、測定器、fixtures |
| 繰り返し | gate は5連続 pass。gate-pass 候補の各 programming case と instantiate は7回。中央値、最小、最大を記録 |

## 手順

候補 build は `scripts/build-wasm.sh --variant=<ID>` を `BUILD_ROOT=build/s1b`、`JOBS=2` で実行し、出力を `build/s1b/<ID>/` に置く。driver は `/usr/bin/time -v` で build wall/RSS を記録し、候補を逐次 build、gate、speed 測定する。最終 linker command は CSV の `link_line` 欄にも記録する。B の事前 build は同じ `BUILD_ROOT`/profile で行い、driver がその成果物を matrix に取り込む。

```sh
PATH="$(brew --prefix)/bin:$PATH" BUILD_ROOT=build/s1b JOBS=2 \
  /usr/bin/time -v -o build/s1b/timing/B-build-time.txt \
  ./scripts/build-wasm.sh --variant=B
python3 scripts/run-s1b-matrix.py
python3 scripts/run-s1b-matrix.py --phase=compare --c-profile=C
PATH="$(brew --prefix)/bin:$PATH" BUILD_ROOT=build/s1b/repro-C-a JOBS=2 \
  /usr/bin/time -v -o build/s1b/repro-C-a-build-time.txt ./scripts/build-wasm.sh
PATH="$(brew --prefix)/bin:$PATH" BUILD_ROOT=build/s1b/repro-C-b JOBS=2 \
  /usr/bin/time -v -o build/s1b/repro-C-b-build-time.txt ./scripts/build-wasm.sh
WASM_BUILD_ROOT=build/s1b/repro-C-b WASM_VARIANT=jspi-pthread \
  WASM_VARIANTS=jspi-pthread node --test tests/sim/*.test.mjs
```

instantiate 測定は `tests/sim/run-instantiate.mjs` の import + instantiate 時間、programming 測定は `tests/sim/run-program.mjs` の module import/instantiate + `callMain` 時間とする。候補ごとの build/gate log、最終 `.mjs`/`.wasm`、`link.txt` は `build/s1b/<ID>/` 以下に保持する。生値 CSV は `docs/experiments/S1b-option-matrix.csv`。

## 計測器の検証

`run-program.mjs` は S1a の fake USB 成功ケースを実行し、JSON marker に elapsed time と exit code を出す。B は8 programming caseすべてを7回成功させた。各 case の raw 値、中央値、最小・最大は CSV に記録した。instantiate も7回測定し、結果は CSV に残した。

## 結果

### 候補ごとの gate、速度、WASM gzip size

total は8 programming case の中央値の合計（ms）。改善率は `(B total - candidate total) / B total * 100`。範囲非重複数は、各 case で candidate と B の min/max 区間が交差しない数であり、速い向き・遅い向きを区別しない。gate に失敗した候補は速度測定を行わない。

| 候補 | build / gate | total (ms) | B からの改善 | 非重複 case | WASM gzip (bytes) |
|---|---|---:|---:|---:|---:|
| B | pass / pass | 6706.362 | 0.000% | 0/8 | 634803 |
| O2 | pass / pass | 6774.988 | -1.023% | 0/8 | 693219 |
| O3 | pass / pass | 6741.811 | -0.529% | 0/8 | 695566 |
| Oz | pass / pass | 7168.502 | -6.891% | 3/8 | 362895 |
| LTOL | pass / pass | 6672.443 | +0.506% | 0/8 | 578959 |
| LTOA | pass / pass | 6635.381 | +1.058% | 0/8 | 574484 |
| EHX | pass / pass | 6710.845 | -0.067% | 0/8 | 634227 |
| MG | pass / pass | 7137.132 | -6.423% | 2/8 | 634758 |
| M64 | pass / pass | 6742.947 | -0.546% | 0/8 | 634722 |
| DL | pass / pass | 6716.104 | -0.145% | 0/8 | 637397 |
| MI | pass / fail | — | — | — | 663501 |
| CL | pass / pass | 6646.034 | +0.900% | 0/8 | 634756 |
| EC | fail / — | — | — | — | — |
| TD2 | pass / pass | 6698.143 | +0.123% | 0/8 | 634722 |
| DE0 | pass / pass | 6728.998 | -0.338% | 0/8 | 634722 |
| ST1M | pass / pass | 6688.275 | +0.270% | 0/8 | 634895 |
| P2P | pass / fail | — | — | — | 634399 |
| SIMD | pass / pass | 6717.826 | -0.171% | 0/8 | 629848 |

build に成功した17候補中、MI と P2P は5回連続 gate の初回で失敗した。EC は link 時に失敗した。残る15候補は gate を5回連続で通過し、8 programming case と instantiate を各7回測定した。生値 945 件と B/C 比較の126件を `S1b-option-matrix.csv` に記録した。

全因子で、B に対する改善率が3%を超えなかった。最も速かった LTOA は +1.058% で、min/max 範囲が非重複だった case も0/8だった。よって勝ち因子はなく、競合 group の選択および gzip による tie-break は発生しない。C は B に因子を加えない構成、すなわち B と同じ `-Os`、LTO なし、legacy Wasm EH、32 MiB、emmalloc の profile とした。

### 最終 B/C 比較

B と C は gate をそれぞれ5回連続で通過した。8 programming case の total-of-medians は B が **6895.558 ms**、C が **6845.885 ms** で、C は **0.720%** 速かった。instantiate の中央値は B が79.303 ms、C が80.696 ms。instantiate は測定して記録したが、選択 metric は事前定義どおり8 programming caseの合計である。C を採用し、`scripts/build-wasm.sh` の既定 profile を C にした。C は因子を含まないため、最適化・runtime の設定は B から変わらない。

| Programming case | B median [min, max] ms | C median [min, max] ms |
|---|---:|---:|
| Tang Nano 1K flash | 1370.424 [1368.667, 1514.377] | 1381.717 [1358.538, 1592.221] |
| Tang Nano 1K SRAM | 133.631 [125.712, 195.680] | 129.282 [124.689, 160.362] |
| Tang Nano 20K flash | 765.802 [684.691, 1013.305] | 694.155 [684.994, 1156.152] |
| Tang Nano 20K SRAM | 438.987 [427.443, 867.345] | 438.412 [418.037, 865.497] |
| Tang Nano 4K flash | 1694.907 [1657.964, 1922.905] | 1687.304 [1648.577, 1965.015] |
| Tang Nano 4K SRAM | 194.507 [177.997, 396.139] | 189.196 [183.382, 323.927] |
| Tang Nano 9K flash | 2013.904 [1945.155, 2684.375] | 2027.708 [1971.565, 2806.939] |
| Tang Nano 9K SRAM | 283.396 [250.518, 390.769] | 298.111 [252.841, 716.103] |

raw measurements, per-case medians/ranges for every matrix candidate, artifact sizes and hashes, build/link resource measurements, exact final link lines, and C/B comparison samples are in `docs/experiments/S1b-option-matrix.csv`. The candidate build/gate logs and `optimization-lines.txt` are under `build/s1b/<ID>/`.

### 既定 C の再現性と全 simulation suite

winning factor がないため C=B とし、`default_variant_id=C` を既定に設定した。異なる `BUILD_ROOT` で既定 profile を build した結果、`.mjs` と `.wasm` の両方で SHA-256 が一致した。

| Artifact | Raw bytes | Gzip bytes | SHA-256 |
|---|---:|---:|---|
| `openFPGALoader.mjs` | 99,393 | 27,380 | `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` |
| `openFPGALoader.wasm` | 2,280,999 | 634,535 | `7c17316b513940c4380f823bee1960eb34982ae590fa443f4bde3cccf2f556dd` |

比較した成果物は `build/s1b/repro-C-a/jspi-pthread/` と `build/s1b/repro-C-b/jspi-pthread/`。両 build の `flags.make`、libusb Makefile の実効 flags、最終 link line は、各行に `-O` が1個だけであることも確認した。2回目の成果物を使い、次の suite は **24/24 pass**（75.83秒）だった。

```sh
WASM_BUILD_ROOT=build/s1b/repro-C-b WASM_VARIANT=jspi-pthread \
  WASM_VARIANTS=jspi-pthread node --test tests/sim/*.test.mjs
```

## 捨てた試行と経緯

最初の B preflight build は成功したが、openFPGALoader の `flags.make` と最終 link line に `-O3 -Os` の2個があり、matrix の条件を満たさないため採用しなかった。vendor/openFPGALoader の CMakeLists は `ENABLE_OPTIM=ON` で `-O3` を追加する。これを `OFF` にして選択した `-O` だけを渡し、B を再 build した。最初の出力と計測は `build/s1b/preflight-B-duplicate-O3/`、`build/s1b/timing/preflight-B-build-time.txt` に保持した。matrix の全候補では `flags.make`、libusb Makefile の実効 `CFLAGS`/`CXXFLAGS` と補助 `AM_CFLAGS`/`AM_CXXFLAGS`、最終 `link.txt` を検査した。補助 AM flags は `-O` を含まないことを確認し、実効 flags とリンク行に各1個の `-O` があることを確認した。

- EC: build は `em++: error: EVAL_CTORS is not compatible with ASYNCIFY` で失敗。ログは `build/s1b/EC/build.log`。
- MI: gate 1回目の NOR programming/fault tests で `Aborted(OOM)`、`RuntimeError: unreachable`、`abortOnCannotGrowMemory` が発生。ログは `build/s1b/MI/matrix-gate-1.log`。
- P2P: gate 1回目の no-device 検出 test が、実際の exit code 0 を期待外れとして失敗。出力は `unable to open ftdi device: -3 (device not found)`、`JTAG init failed with: unable to open ftdi device`。ログは `build/s1b/P2P/matrix-gate-1.log`。

Markdown 初稿では範囲非重複の条件を「候補の最大値が B の最小値未満」と誤って狭く転記していた。著者の原案どおり「min/max 範囲が重ならない（方向は問わない）」へ訂正した。判定に使った範囲非重複数は方向を問わず計算しており、いずれの因子も3%条件に達していないため、選択結果は変わらない。

## 結論

winning factor はない。C=B とし、B/C の最終 gate は両方 pass、C の programming total-of-medians は B 以下だったため C を採用した。C を既定にして異なる `BUILD_ROOT` で2回 build した成果物は同一 SHA-256 となり、全 simulation suite も pass した。

## 未確認の点

実機 Tang Nano での書き込み性能は測定していない。ここでの結果は Node.js fake WebUSB 上の WASM の測定であり、実機速度を示さない。

## ログ

build/gate logs は `build/s1b/` 以下にあり、repo に commit しない。再生成コマンドは上記の通り。matrix と B/C の `.mjs`/`.wasm` SHA-256 は CSV に記録した。default C の再現性 build は `build/s1b/repro-C-a/` と `build/s1b/repro-C-b/` にあり、hash と full suite の結果は本書に記録した。

## 2026-10-25 追記: BUILD_ROOT 間の再現性

この節の hash と測定値は当時の記録として残す。既定の `BUILD_ROOT=build` で生じた hash 差、その原因と修正、修正後に `build/` と `build/repro-check2/` で一致した hash は [S0 の追記](S0-wasm-build.md) に記録した。
