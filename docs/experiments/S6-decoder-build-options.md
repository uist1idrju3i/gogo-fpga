# S6 zstd・xz 展開器のビルドオプション比較

- 状態: 計画
- 日付: 2026-10-29
- 担当: Devin
- 基準の commit: `a757cd6ddf3f2d2e72f180e4300bec863ba6e051`（`origin/main`）

## 目的

zstd と xz の WASM 展開器について、現在の `-O2`、`-O3`、`-Os`、LTO の有無を比較します。既定のビルド動作は変えず、まず未設定の `DECODER_OPT_LEVEL` と `DECODER_LTO` で作る展開器が、基準 commit の `-O2` ビルドとバイト単位で一致することを確認します。

## 仮説

`-O3`、`-Os`、LTO の組み合わせによって、zstd の展開時間または WASM の大きさが変わると予想します。安定性の基準をすべて満たした候補のうち、採否の基準を超えて zstd 展開を速くする変種だけを採用候補とします。xz は結果を記録しますが、選定には使いません。

## 基準

安定性を速度より優先し、次のすべてを満たさない変種は選定から除外します。

1. すべての反復ですべての展開出力の SHA-256 が元データと一致し、trap、例外、停止がないこと。展開 1 回あたり 120 秒でタイムアウトした場合は失敗とします。
2. 各変種を 2 回ビルドし、展開器ごとに SHA-256 が一致すること。
3. 各変種の WASM を配置した状態で `node --test tests/web/decompress.test.mjs` が 5 回連続で成功すること。`DECODER_OUT_DIR` を使うか標準パスへコピーし、B に戻した後で復元後の SHA-256 を確認します。
4. 安定版 Chromium、Firefox、Safari がサポートする WASM feature のみを使うこと。利用できる場合は `wasm-objdump` または `wasm-tools` で調べ、どちらも使えない場合は feature section または flags を確認し、その方法を記録します。
5. 次の負の対照が両方とも検出されること。B と選定候補で確認します。
   - 圧縮入力の 1 byte を壊すと、展開器がエラーを返すか、出力 SHA-256 の不一致を検出する。
   - 展開器 WASM の code section の 1 byte を壊すと、コンパイル失敗または不一致を検出する。

一次指標は、Tang Nano 20K の 5 資材に対する zstd 展開時間の合計とする。各変種の反復間中央値が B よりノイズ幅 `N` を超えて速く、かつ 5% 以上速い場合を候補とする。`N` は B と B2 の一次指標の中央値の差の絶対値とする。基準を満たす候補では最速のものを選ぶ。候補同士の差が `N` 以内なら、フラグが少ないもの（LTO なしを LTO より優先）を選び、次に zstd 展開器 WASM が小さいものを優先する。候補がなければ B（`-O2`）を維持する。xz は本番で使わず、数値だけ記録し、選定対象外とする。

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | `a757cd6ddf3f2d2e72f180e4300bec863ba6e051`（`origin/main`） |
| 対象 | zstd と xz の WASM 展開器 |
| 変種 | B、B2、O3、O3LTO、Os、OsLTO |
| ビルド変数 | `DECODER_OPT_LEVEL` は `2`、`3`、`s`。`DECODER_LTO` は空、`0`、`1` |
| B | 現行の `-O2`。`DECODER_OPT_LEVEL=2`、`DECODER_LTO=0` |
| B2 | B を新しい出力先へ再ビルドした A/A とノイズ幅の基準 |
| O3 | `DECODER_OPT_LEVEL=3`、`DECODER_LTO=0` |
| O3LTO | `DECODER_OPT_LEVEL=3`、`DECODER_LTO=1` |
| Os | `DECODER_OPT_LEVEL=s`、`DECODER_LTO=0` |
| OsLTO | `DECODER_OPT_LEVEL=s`、`DECODER_LTO=1` |
| LTO | `DECODER_LTO=1` はコンパイルとリンクに `-flto` を加える。WASI SDK の sysroot にある `lib/wasm32-wasip1/llvm-lto` により libc も LTO 対象となるため、リンクで `llvm-lto` が使われた証拠を記録する |
| 出力先 | `DECODER_OUT_DIR` は変種ごとに異なる相対パスを使い、出力を並べて保持する。未指定時の出力先は現行のままとする。この比較では既定ビルドの動作を変えない |
| 入力 | `scripts/prepare-compressed-assets.sh` が作る S4B の `dist/bench`。Tang Nano 20K の 5 資材（`synth/yosys.wasm`、`synth/nextpnr-himbaechel-gowin.wasm`、`synth/yosys-share.tar`、`pack/pyodide/pyodide.asm.wasm`、`synth/chipdb/chipdb-GW2A-18C.bin`）を zstd と xz で展開する |
| ブラウザー | 同じホスト上の headless Chromium。計測中はほかの重い処理を実行しない |
| 反復と順序 | 5 回以上。各反復で変種の順番を 1 つずつずらす round-robin とし、各反復で新しいページを使う |
| 指標 | 各展開器の `WebAssembly.compile` 時間、資材ごとの展開時間、展開後 SHA-256、raw WASM bytes |
| 集計 | 一次指標は反復ごとの zstd 5 資材の展開時間合計の中央値。二次指標は xz の同じ合計、compile 時間、raw WASM bytes |
| ログと出力 | 生 CSV とログは `build/s6/` に保存する。文書と CSV には VM の絶対パスを記載せず、`$REPO_ROOT` を使う |

## 手順

1. `origin/main` の基準 commit から作業ブランチを作ります。
2. `DECODER_OPT_LEVEL` と `DECODER_LTO` を未設定にしたビルドを行い、基準 commit の現行 `-O2` ビルドと zstd、xz それぞれの SHA-256 を比較します。既定動作を変えていないことを確認します。
3. B、B2、O3、O3LTO、Os、OsLTO をそれぞれ別の `DECODER_OUT_DIR` にビルドします。各変種の zstd と xz の WASM SHA-256 を記録し、LTO 変種はリンクに `llvm-lto` sysroot library が使われた証拠を確認します。証拠がなければ、その変種を失敗として扱います。
4. 各変種を 2 回ビルドして、展開器ごとの A/A SHA-256 を比較します。Node test は `node --import ./scripts/s6-wasi-random-get-preload.mjs --test tests/web/decompress.test.mjs` で各変種5回連続実行します。preload は WASM が `wasi_snapshot_preview1.random_get` を import し、呼び出し側に実装がない場合だけ `crypto.getRandomValues` を使う実装を補います。
5. S4B 資材を用意し、headless Chromium で各展開器の compile 時間と資材ごとの展開時間を測ります。反復ごとに変種の順番を回し、新しいページを使います。展開後の SHA-256 を元の資材と照合します。
6. 全変種について安定性の基準を確認し、B と B2 から `N` を求めて、上記の選定基準を適用します。
7. B と選定候補で圧縮入力および WASM code section の負の対照を確認します。失敗した試行も含む全反復の生 CSV、絶対値、基準、WASI SDK、clang、Chromium、ホスト、CPU、submodule、コマンド、ログを記録します。ログは一時ディレクトリーではなく `build/s6/` に置きます。

Chromium の正式計測は同じホストで 5 回以上行う。各反復で変種の順番を回し、新しいページを使う。WASM の compile 時間と各資材の展開時間を個別に測定する。SHA-256 は計測区間の外で照合する。

## 結果

### 実施条件と入力

- 実施日: 2026-10-29
- 基準 commit: `a757cd6ddf3f2d2e72f180e4300bec863ba6e051`
- 事前登録 commit: `7306a7a2f9e820532cd0877f8528e4b9c349f925`
- 測定に使った bench の chipdb パス修正 commit: `514319e39c777b5af55cd4ed7d7cf4751ba2f2ee`
- OS／CPU／メモリー: Ubuntu 26.04.1 LTS、x86_64、Intel Xeon D-1531 2.20 GHz、12 logical CPU、30 GiB RAM
- Node.js: v24.22.1。Playwright 1.64.1、headless Chromium 156.0.8078.4
- WASI SDK: 34.0、clang 23.1.0-wasi-sdk。zstd CLI 1.5.7、XZ Utils 5.8.3
- submodule: zstd `f8745da6ff1ad1e7bab384bd1f9d742439278e99`、xz-embedded `62d5603b5114c5aa8bb5f6bb461efbe0e3b51891`
- 出力先: build は `build/s6/formal/`、生ログと CSV は `build/s6/`
- 測定前の load average は 0.65、0.59、0.39。Chromium 計測中は他の重い処理を実行しなかった。
- 変種ごとに A/B の二度ビルドし、各 Node test を連続5回実行した。Chromium は各反復で変種順をずらし、新しいページを使用した。

入力は S4B の Tang Nano 20K 用5資材である。各 zstd・xz サイズは準備済み index と一致した。

| 資材 | raw bytes | raw SHA-256 | zstd bytes | xz bytes |
|---|---:|---|---:|---:|
| `synth/yosys.wasm` | 52,926,660 | `aa18e2c167d614e4194796041bf4cb533a659b0028668418ee109a6cd9cc58aa` | 9,448,361 | 8,513,924 |
| `synth/nextpnr-himbaechel-gowin.wasm` | 34,172,028 | `b011f1d2798dead2698d58037d40523885330b7c0c7df2cf9577f07dbcfc7e7f` | 5,804,193 | 5,278,224 |
| `synth/yosys-share.tar` | 10,567,680 | `531b97d2d9d99eb375177def6adaace730539ab33f529d09294840cb00bead5f` | 482,672 | 435,592 |
| `pack/pyodide/pyodide.asm.wasm` | 9,598,218 | `cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6` | 2,890,689 | 2,641,808 |
| `synth/chipdb/chipdb-GW2A-18C.bin` | 17,493,847 | `8c1b6dcf30c212a06367217a7e67cbd0cd00078c11a12b22efcaeaa6ef26797d` | 521,657 | 395,576 |
| 合計 | 124,758,433 | | 19,147,572 | 17,265,124 |

未設定の `DECODER_OPT_LEVEL` と `DECODER_LTO` で行った基準ビルドは、origin/main の現行ビルドと一致した。zstd は 70,356 bytes、SHA-256 `c80c619579e0cbc5a3981fca7741b436b8f1de714ed91ac7e07259d18ea00f37`、xz は 20,994 bytes、SHA-256 `0486d7ae22a9601748588a953a0dbaae3ca6189a41bb1694b9d0b8217088a48e` だった。

### ビルド、同一性、機能

6変種すべてで A/B の zstd・xz SHA-256 が一致した。B と B2 は基準ビルドのハッシュを維持した。

| 変種 | zstd A/A SHA-256 | xz A/A SHA-256 |
|---|---|---|
| B | `c80c619579e0cbc5a3981fca7741b436b8f1de714ed91ac7e07259d18ea00f37` | `0486d7ae22a9601748588a953a0dbaae3ca6189a41bb1694b9d0b8217088a48e` |
| B2 | `c80c619579e0cbc5a3981fca7741b436b8f1de714ed91ac7e07259d18ea00f37` | `0486d7ae22a9601748588a953a0dbaae3ca6189a41bb1694b9d0b8217088a48e` |
| O3 | `8df13348b175a1107e86abb87d573ea54b45dd191edef1e0f30aa53265fb3bad` | `7d003aaebd3ee0f6e6d2f858cb9c0358093f8c22bdda8017b5a05c6e8d440b42` |
| O3LTO | `e8824aa17908585884f7a388b18f0da17786e01ebd4dc99f5d12769aff0324ec` | `3fc7387471f888f371bdb030f478f6c66c7cc8b70fc0c105e0aff01a77539d71` |
| Os | `e60f580fb0ed7cc245d3c8cc1806e1c8eb46b58bc1c184af179a20e780b3a514` | `c10057f92b0c0355223490ec661e43e256800d5f5a39cd59b707442db30c0176` |
| OsLTO | `d42c6a2cdd3cc130179f7766f8316a0fdf08dffb235f394f6bde01282e8bfecd` | `f835d6a8c3dfdb46c4b2c79c4b0a73d17e9335d0bd99904381655719b18099ad` |

正式な Node test は各変種で5回連続、各回14/14 pass（合計30回、420 assertions）だった。5回実行では commit `ac4c3b892715becfe0eb36251640a6712452dffa` のテスト内 adapter を使用した。今回、同じ `random_get` 処理を実験用 preload `scripts/s6-wasi-random-get-preload.mjs` に移し、動作が同じであることを追試した。B と OsLTO の preload 付き実行コマンドは `node --import ./scripts/s6-wasi-random-get-preload.mjs --test tests/web/decompress.test.mjs` で、各14/14 passだった。OsLTO の preload なし実行 `node --test tests/web/decompress.test.mjs` は10 pass・4 failとなった。OsLTO の両 WASM が `wasi_snapshot_preview1.random_get` を import し、失敗時は `WebAssembly.instantiate` が imports object の不在を報告することを確認した。これは意図した負の対照であり、測定値と選定は変更しない。最後に B を復元し、zstd SHA-256 `c80c619579e0cbc5a3981fca7741b436b8f1de714ed91ac7e07259d18ea00f37` と xz SHA-256 `0486d7ae22a9601748588a953a0dbaae3ca6189a41bb1694b9d0b8217088a48e` を確認した。LTO の4つの build log は WASI SDK の `llvm-lto/23.1.0-wasi-sdk/libc.a` を使った記録を含む。

WASI SDK の `llvm-objdump` で12個の WASM を調べた。`target_features` custom section は strip により存在せず、clang の target は `wasm32-unknown-wasip1`、CPU は generic で、明示的な target feature 指定はない。命令走査では全変種に bulk-memory の `memory.copy`／`memory.fill` と sign-extension の `i32.extend8_s`／`i32.extend16_s` があった。SIMD、atomic、reference、non-trapping float-to-int の命令は見つからなかった。

O3LTO と OsLTO の zstd・xz は `wasi_snapshot_preview1.random_get` を import する。B、B2、O3、Os に WASM import はなかった。計測・テスト harness は `crypto.getRandomValues` で `random_get` を提供するが、本番の `web/lib/decompress.mjs` は import object なしで instantiate する。したがって LTO 変種を将来既定にする場合は、本番にも同じ import の対応が必要である。今回の測定では既定 build を変更しない。

### Chromium の正式計測と選定

初回の5反復は全60ページ試行が decode 開始前に失敗した。CLI に指定した chipdb のパスが index にない `synth/chipdb-GW2A-18C.bin` だったためで、測定値には使わず失敗行を残した。ベンチの既定パスも同じ誤りだったため commit `514319e` で `synth/chipdb/chipdb-GW2A-18C.bin` に修正し、6変種を5回ずつ再計測した。2回目の300 decode 行はすべて有効で、元資材の SHA-256 と一致した。初回にシンボリックリンクから作った資材も zstd が無視して準備に失敗したため、通常ファイルをコピーして作り直した。この準備失敗は測定試行には含めない。

表の zstd・xz 値は各反復の5資材合計時間の中央値 [最小, 最大]。compile は `WebAssembly.compile` の中央値を zstd／xz の順で示す。raw bytes は decoder WASM の zstd／xz サイズ、改善率は B の zstd 中央値に対する値である。

| 変種 | zstd ms [min, max] | B との差 / 改善率 | xz ms [min, max] | compile ms zstd/xz | raw bytes zstd/xz | A/A | Node 5回 | features | imports |
|---|---:|---:|---:|---:|---:|---|---|---|---|
| B | 359.795 [358.270, 364.115] | 0.000 ms / 0.000% | 2,215.695 [2,212.005, 2,222.215] | 14.935 / 5.130 | 70,356 / 20,994 | pass | 5/5 pass | bulk-memory, sign-ext | なし |
| B2 | 359.870 [357.695, 367.355] | -0.075 ms / -0.021% | 2,214.250 [2,211.105, 2,215.270] | 16.230 / 14.180 | 70,356 / 20,994 | pass | 5/5 pass | bulk-memory, sign-ext | なし |
| O3 | 359.980 [359.180, 366.185] | -0.185 ms / -0.051% | 2,228.800 [2,224.010, 2,230.505] | 15.770 / 14.360 | 72,208 / 21,066 | pass | 5/5 pass | bulk-memory, sign-ext | なし |
| O3LTO | 357.920 [356.200, 365.470] | +1.875 ms / +0.521% | 2,266.210 [2,263.800, 2,282.445] | 17.190 / 11.605 | 73,251 / 23,176 | pass | 5/5 pass | bulk-memory, sign-ext | `random_get` (zstd/xz) |
| Os | 350.340 [347.015, 356.065] | +9.455 ms / +2.628% | 2,196.175 [2,186.905, 2,210.640] | 14.935 / 12.230 | 62,086 / 18,472 | pass | 5/5 pass | bulk-memory, sign-ext | なし |
| OsLTO | 348.195 [344.890, 352.720] | +11.600 ms / +3.224% | 2,203.435 [2,198.950, 2,220.470] | 13.755 / 15.195 | 61,808 / 20,281 | pass | 5/5 pass | bulk-memory, sign-ext | `random_get` (zstd/xz) |

B と B2 の zstd 中央値差から求めた `N` は 0.075 ms。O3LTO、Os、OsLTO は B より `N` を超えて速いが、最速の OsLTO も改善率は 3.224% で、凍結基準の5%に届かなかった。よって適格候補はなく、凍結規則の結果は **B を維持** である。xz と compile の値は記録したが、一次指標に代えて選定には使わない。

B では zstd・xz の圧縮入力を破損すると両方とも拒否され、WASM code section を破損した場合も zstd・xz とも `WebAssembly.compile` が拒否した。選定結果は B なので、この同じ B の2つの負の対照が baseline と選定変種の両方に該当する。

### CSV とログ

- 正式 CSV: [S6 decoder build options](S6-decoder-build-options.csv)。初回の失敗を含むデータ448行（ヘッダーを除く）で、失敗60行と成功した300 decode／60 compile 行を保持する。
- Chromium の初回失敗 CSV／log: `build/s6/formal-chromium-attempt1.csv`、`build/s6/formal-chromium-attempt1.log`
- Chromium の再計測 CSV／log: `build/s6/formal-chromium-attempt2.csv`、`build/s6/formal-chromium-attempt2.log`
- build A/A: `build/s6/formal-build-{B,B2,O3,O3LTO,Os,OsLTO}-{A,B}.log`、`build/s6/formal-aa-results.txt`
- Node test: `build/s6/formal-node-test-summary.csv`、`build/s6/formal-node-{variant}-{1..5}.log`
- feature inspection: `build/s6/formal-wasm-objdump.txt`、`build/s6/formal-wasm-feature-scan.txt`
- 負の対照: `build/s6/formal-node-B-1.log`、`build/s6/formal-negative-control-B-decoder.log`
- random_get preload 追試: `build/s6/followup-preload-B-with.log`、`build/s6/followup-preload-OsLTO-with.log`、`build/s6/followup-preload-OsLTO-without.log`、`build/s6/followup-preload-OsLTO-imports.log`
- 実行環境と server: `build/s6/formal-environment-before-chromium.txt`、`build/s6/formal-server.log`
