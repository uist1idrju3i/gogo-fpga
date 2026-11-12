# S5 WASI SDK のビルドオプション比較

- 状態: 完了
- 日付: 2026-10-28
- 担当: Devin
- 関連: T2 S5、基準 commit `aff4e61b576b4f18a3cb819069b16c4cc9c1652a`

## 目的と仮説

Yosys と nextpnr の WASI ビルドで、Release の最適化レベルと追加フラグを変え、合成・配置配線の時間、メモリー、配布サイズ、ビルド時間を比較する。候補によって実行時間または配布サイズが改善する可能性がある一方、出力の同一性、ビルド時間、ブラウザー互換性を損なう可能性もある。測定前には勝者を想定しない。

この記録は比較条件と採用基準を固定する。S4B、S4C の測定値、基準、結論は変更しない。

## 採否の基準（結果を見る前に書く）

候補は次のすべてを満たす場合に限り採用する。

1. 4 ボードすべての全試行で、Yosys の JSON ネットリスト、nextpnr の出力、最終 `.fs` が B とバイト単位で一致し、trap または失敗がない。
2. 次のいずれかを満たす。
   - Chromium の Tang Nano 20K における合成と配置配線の中央値が B より 10% 以上速く、かつ A/A のノイズ床を超える。
   - Yosys と nextpnr の `zstd -19` サイズの合計が B より 10% 以上小さく、Chromium の Tang Nano 20K における合成と配置配線の中央値が B より 5% を超えて遅くならない。
3. ビルド時間が B の 2 倍以下である。
4. 使用する target feature が Chromium、Firefox、Safari の現行安定版でサポートされる。根拠として MDN、caniuse、または webassembly.org の機能表を引用する。

どの候補も基準を満たさない場合は B を維持する。同等の場合はフラグが少ない候補を優先し、安定性を速度より優先する。

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | `aff4e61b576b4f18a3cb819069b16c4cc9c1652a`（S5 phase 1b で `origin/main` にリベース） |
| ホスト | Linux x86_64、kernel `7.0.0-38-generic`、論理 CPU 12 個、メモリー 31,707,676 kB |
| WASI SDK | 34.0、clang 23.1.0 |
| Node.js / Playwright | Node.js 24.22.1、Playwright 1.64.1。Chromium のバージョンは正式計測時に記録する |
| 関連 submodule | Yosys `28ba3cb926fe376fa05ebfc1b921747d011d4557`、nextpnr `62e659ed6748e9f60b2a4aa25dd4fe79a9605881`。正式計測時は `git submodule status` も記録する |
| その他のツール | Python 3.14.4、CMake 4.4.4、zstd 1.5.7 |
| 出力先と状態 | 各 WASI ビルドは `build/s5/<variant>/` に分離する。B と B2 は別の新規ディレクトリーでビルドする。既存の出力や CSV は上書きしない |
| 再現性 | `SOURCE_DATE_EPOCH` が未設定なら、Yosys submodule の `git log -1 --format=%ct`（`1791880533`、2026-10-13 08:35:33 UTC）を設定してビルドする。Yosys の WASI と native ビルドに適用する |
| JOBS | 12 論理 CPU のホストで `10` に固定し、各ツールのビルド時間とピーク RSS を `/usr/bin/time -v` で記録する |
| 変える条件 | 下表のとおり、B の実際のビルド条件を基準に変更を加える。Yosys の B の `symfpu.cc` 実コマンドは `build/s5/B/yosys/compile_commands.json` の該当エントリーにあり、`-O3` と `-Werror=unused-parameter` を含み `-DNDEBUG` を含まない。O2/Os/Oz は最適化フラグだけを変え、assert の状態を B とそろえる。 |
| 変えない条件 | WASI SDK 34.0、Release 構成、スタックサイズ、例外モデル、スレッド設定、入力 Verilog、nextpnr の seed・引数、native `gowin_pack`、対象の 4 ボード |
| 繰り返し | Node WASI は各 variant、各ボードにつき 5 回。各 repeat 内で variant の順番を交代する。中央値と最小・最大を記録する。Chromium は B と Node の出力同一性を通過した上位 2 候補までを、各ボード 5 回ずつ測る |

### 比較する variant

| variant | Yosys と nextpnr の WASI ビルド条件 |
|---|---|
| B | 現行スクリプトをそのまま使う。Yosys の `symfpu.cc` 実コマンドは `-O3` で `-DNDEBUG` なし。Yosys ビルドは `SOURCE_DATE_EPOCH` が未設定なら Yosys submodule の commit 時刻を設定する。nextpnr は upstream の `USE_IPO=ON` により ThinLTO を有効にする。追加の WASI 設定を unset した configure probe でも、Yosys の既定 `-O3` と nextpnr の `USE_IPO=ON` / `-flto=thin` を確認した。 |
| B2 | B と同じ設定を、別の新規ビルドディレクトリーで再ビルドする A/A 試行 |
| O2 | B に `-O2` のみ追加する。`-DNDEBUG` は追加しない。 |
| Os | B に `-Os` のみ追加する。`-DNDEBUG` は追加しない。 |
| Oz | B に `-Oz` のみ追加する。`-DNDEBUG` は追加しない。 |
| LTO | B に加えて C、C++、linker に `-flto` を指定する。nextpnr は `-DUSE_IPO=OFF` にし、upstream の ThinLTO フラグが後から付くのを防ぐ。 |
| TLTO | Yosys は B に加えて C、C++、linker に `-flto=thin` を指定する。nextpnr は B と同一の成果物を再利用する。効果なし（B は upstream の USE_IPO で ThinLTO 済み）。 |
| SIMD | B に加えて C、C++、linker に `-msimd128` |
| TC | B に加えて C、C++、linker に `-mtail-call` |

この比較では Yosys の例外モデル変更（`-fwasm-exceptions`）、nextpnr の例外モデル変更、スタックサイズ変更、スレッド、wasm-opt/Binaryen を試さない。例外モデル、スタック、スレッドの変更は安定性上のリスクがあり、wasm-opt/Binaryen は新しい依存として承認が必要なため除外する。

WASI SDK の標準 target feature は bulk-memory、multivalue、mutable-globals、nontrapping-fptoint、reference-types、sign-ext である。候補が新たに使う target feature は採用基準 4 に従って確認する。

## 測定項目

- 各 variant の Yosys と nextpnr それぞれについて、固定した `JOBS=10` でビルド時間（秒）とピーク RSS を記録する。
- 各 WASM のバイト数、SHA-256、pinned zstd 1.5.7 の `zstd -19` 圧縮後バイト数を記録する。
- Node WASI で Tang Nano 1K、4K、9K、20K を各 variant 5 回実行し、Yosys と nextpnr の時間（ms）、終了時の `WebAssembly.Memory.buffer.byteLength` を記録する。
- Yosys が生成した JSON ネットリスト、nextpnr の JSON 出力、native `gowin_pack` が生成した `.fs` の SHA-256 を記録し、全ての出力を B と比較する。
- 同じ Chromium を使い、B と Node 試験で同一性を通過した上位 2 候補までを各ボード 5 回実行する。既存の `toolchain:build-complete` build event から合成・配置配線の時間を取り、`.fs` の SHA-256 を記録する。
- 失敗、trap、無効な出力も CSV に残す。試行を除外する場合は、理由を記録する。

## 手順

計測器の確認では B と B2 の新規ビルド、SHA-256 の比較、1 バイト変更による負の対照、B の Tang Nano 1K 1 回の smoke run を行う。これは正式な variant 比較ではない。正式マトリクスの実行コマンドは次のとおり。出力先は新規であることを確認してから実行する。

```sh
python3 scripts/run-s5-matrix.py \
  --phase matrix \
  --reuse-builds \
  --jobs 10 \
  --output-csv docs/experiments/S5-wasi-build-options.csv \
  --output-dir build/s5/matrix-runs

python3 scripts/run-s5-matrix.py \
  --phase chromium \
  --variant B \
  --variant <候補1> \
  --variant <候補2> \
  --append \
  --output-csv docs/experiments/S5-wasi-build-options.csv \
  --output-dir build/s5/chromium-runs
```

Chromium の `<候補1>` と `<候補2>` は Node WASI の全ボードで出力同一性を通過した候補から選ぶ。候補が 1 つ以下なら、存在するものだけを指定する。正式な `.csv` は全試行を終えるまで作成しない。

## 計測器の検証

- A/A: B と B2 の Yosys、nextpnr WASM の SHA-256 がそれぞれ一致することを確認する。Node WASI の B、B2 の時間中央値も併記し、中央値の差を A/A のノイズ床として報告する。
- 負の対照: B の JSON ネットリストと `.fs` のコピーをそれぞれ 1 バイト変更し、SHA-256 比較器が両方の不一致を検出する。
- smoke run: B、Tang Nano 1K、1 回で Node WASI の合成・配置配線と出力ハッシュを記録する。
- この検証を終え、ハーネスのレビューを受けるまで正式なマトリクスを始めない。

### Phase 1a の記録（JOBS=2、SOURCE_DATE_EPOCH 固定前）

2026-10-28 と 2026-10-29 に B と B2 の WASI 資材を別ディレクトリーへ新規ビルドした。B の Yosys は 2,555.96 秒、ピーク RSS は 393,280 KiB、52,926,660 bytes だった。nextpnr は 206.70 秒、984,520 KiB、34,172,028 bytes だった。B2 の Yosys は 2,552.350 秒、393,568 KiB、52,926,660 bytes、nextpnr は 206.340 秒、984,840 KiB、34,172,028 bytes だった。zstd 1.5.7 の `-19` で B2 の Yosys は 9,449,054 bytes、nextpnr は 5,804,193 bytes になった。

Yosys の A/A は不一致だった。B の SHA-256 は `8376ebab361800f771ce0c283699fc3ea6140f1caecb81a0fd0d7d687a7544b0`、B2 は `4c252e3bbda1917e284d7043ac675c0635de50d67f2e7750ff3cab8644df5ba3`、既存の `build/wasi` は `aa18e2c167d614e4194796041bf4cb533a659b0028668418ee109a6cd9cc58aa` だった。WASM 内の ABC 文字列にビルド日時が含まれ、B と B2 で値が異なることを確認した。nextpnr は B、B2、`build/wasi` の全てが `b011f1d2798dead2698d58037d40523885330b7c0c7df2cf9577f07dbcfc7e7f` で一致した。B と B2 の Yosys 実行時間は測っていないため、A/A のノイズ床は未算出である。

B、Tang Nano 1K、1 回の Node WASI smoke run は成功した。合成は 1,213.761 ms、配置配線は 364.444 ms、終了時のメモリーは Yosys が 31,653,888 bytes、nextpnr が 18,874,368 bytes だった。JSON ネットリスト SHA-256 は `ed1a8270df866111bd762c3472668206859171d70301cbd12317a585adb5b5bf`、nextpnr 出力は `b94aa344cd99d2caa2228eeed445e62a76ea008d5410125080a1963e717259bd`、`.fs` は `6f83a9e8e96aa5f39b0da9a4176859098b2d5fba4bfb2cf0e5bd3c9aea5d29d3` だった。負の対照ではコピーした JSON と `.fs` の各 1 byte を変更し、両方の SHA-256 不一致を検出した。生データと実行ログは `build/s5/instrument-validation.csv` と `build/s5/instrument-validation-runs-retry/` にある。

Phase 1a の時点では、JOBS=2 の B と B2 のビルド時間から、未ビルドの 7 variant を約 322 分、Node の 180 試行を約 7 分、Chromium の最大 60 試行を約 20 分と見積もり、全体を約 5.8 時間とした。これは後述する JOBS=10 の見積もりに更新する前の値である。

### Phase 1b の記録（JOBS=10、SOURCE_DATE_EPOCH 固定）

2026-10-28 に B と B2 の出力先を削除し、新規ディレクトリーに再ビルドした。どちらも `SOURCE_DATE_EPOCH=1791880533` でビルドされ、Yosys WASM の SHA-256 は `05598a8d79b716f8711287b2e16610f8a0a7f8610ff9bdfbf6b1ce19839ff037` で一致した。両方のファイルは 52,926,644 bytes、zstd 1.5.7 の `-19` 圧縮後は 9,448,979 bytes だった。ビルド時間は B が 838.420 秒、B2 が 839.160 秒で、ピーク RSS はそれぞれ 393,416 KiB と 393,420 KiB だった。

nextpnr の B と B2 の SHA-256 は、どちらも `b011f1d2798dead2698d58037d40523885330b7c0c7df2cf9577f07dbcfc7e7f` で、`build/wasi` の既存成果物とも一致した。nextpnr のビルド時間は B が 93.910 秒、B2 が 91.950 秒だった。既存の Yosys `build/wasi` は修正前にビルドした成果物で、SHA-256 は `aa18e2c167d614e4194796041bf4cb533a659b0028668418ee109a6cd9cc58aa` だった。新しい B/B2 の A/A 判定には使わず、同一条件で再ビルドした B と B2 の一致を判定した。

WASM の文字列には `Oct 13 2026 08:35:33` が含まれ、ソースで確認した `__DATE__` と `__TIME__` が固定された。B、B2 のいずれにも `build/s5` を含むパス文字列はなかった。ビルドコマンドの `-ffile-prefix-map` は `WASI_BUILD_DIR` で決まる `$build_dir` を `/build` にマップする。

B、Tang Nano 1K、1 回の Node WASI smoke run は成功した。合成は 1,204.625 ms、配置配線は 363.528 ms、runner の wall time は 2.396 秒だった。終了時のメモリーは Yosys が 31,653,888 bytes、nextpnr が 18,874,368 bytes だった。JSON ネットリスト SHA-256 は `0dc67c8be84b75ba4956e17e2f6dc4954053918f0269e1b759ecb188b79bb485`、nextpnr 出力は `b94aa344cd99d2caa2228eeed445e62a76ea008d5410125080a1963e717259bd`、`.fs` は 351,954 bytes、SHA-256 `6f83a9e8e96aa5f39b0da9a4176859098b2d5fba4bfb2cf0e5bd3c9aea5d29d3` だった。負の対照ではコピーした JSON と `.fs` の 1 byte 変更を両方検出した。生データと実行ログは `build/s5/phase1b-build.csv`、`build/s5/phase1b-smoke.csv`、`build/s5/phase1b-smoke-runs/` にある。

この見積もりを作成した時点では正式な計測は未実施だった。JOBS=10 の B と B2 の平均ビルド時間は Yosys と nextpnr の合計で約 15.5 分だった。これを残り 7 variant に当てはめると約 108.7 分、Node の 180 試行は smoke と同じ 2.396 秒を仮定して約 7.2 分、Chromium の最大 60 試行は 1 試行 20 秒として約 20 分となり、合計は約 2 時間 16 分である。候補によるビルド時間の差や再試行を含まない外挿である。正式試行の結果は「結果」節に記録する。

## 結果

正式試行は attempt3 の条件で完了した。生データは [S5 の CSV](S5-wasi-build-options.csv) に記録した。4,916 データ行があり、失敗した試行も保持している。Node は 180/180 試行、負の対照は 4/4、Chromium は 60/60 試行が成功した。

### WASM のサイズとビルド資源

サイズは WASM / zstd 1.5.7 `-19` の bytes、時間は秒、ピーク RSS は KiB である。再利用した成果物の時間と RSS は、その成果物を作成した成功ビルドの値を示す。O2/Os/Oz の Yosys と LTO の nextpnr は attempt3 で再ビルドし、他のビルド成果物は再利用した。TLTO の nextpnr は B の成果物を再利用し、独立したビルドはない。

| Variant | Yosys bytes / zstd-19 | Wall / peak RSS | nextpnr bytes / zstd-19 | Wall / peak RSS | 成果物の出所 |
|---|---:|---:|---:|---:|---|
| B | 52,926,644 / 9,448,979 | 838.420 s / 393,416 KiB | 34,172,028 / 5,804,193 | 93.910 s / 989,624 KiB | Yosys・nextpnr とも Phase 1b |
| B2 | 52,926,644 / 9,448,979 | 839.160 s / 393,420 KiB | 34,172,028 / 5,804,193 | 91.950 s / 982,660 KiB | Yosys・nextpnr とも Phase 1b |
| O2 | 49,333,486 / 8,751,619 | 799.280 s / 388,504 KiB | 33,034,104 / 5,584,365 | 90.510 s / 970,912 KiB | Yosys を attempt3 で再ビルド、nextpnr は attempt2 を再利用 |
| Os | 49,549,630 / 8,006,605 | 743.820 s / 407,416 KiB | 31,588,315 / 5,228,948 | 83.840 s / 912,620 KiB | Yosys を attempt3 で再ビルド、nextpnr は attempt2 を再利用 |
| Oz | 52,910,797 / 7,502,944 | 694.540 s / 493,144 KiB | 30,704,401 / 4,895,812 | 80.890 s / 899,788 KiB | Yosys を attempt3 で再ビルド、nextpnr は attempt2 を再利用 |
| LTO | 42,363,416 / 8,779,367 | 1,536.720 s / 7,790,104 KiB | 30,492,749 / 4,696,980 | 150.790 s / 1,482,864 KiB | Yosys は attempt2 を再利用、nextpnr を attempt3 で再ビルド |
| TLTO | 44,313,274 / 8,861,412 | 966.390 s / 1,369,260 KiB | 34,172,028 / 5,804,193 | — | Yosys は attempt2 を再利用、nextpnr は B の成果物を再利用 |
| SIMD | 53,151,329 / 9,525,646 | 842.820 s / 394,172 KiB | 34,163,579 / 5,810,119 | 94.420 s / 988,916 KiB | Yosys・nextpnr とも attempt2 を再利用 |
| TC | 52,926,427 / 9,449,974 | 838.930 s / 393,592 KiB | 34,171,957 / 5,804,040 | 93.180 s / 988,656 KiB | Yosys・nextpnr とも attempt2 を再利用 |

### Node WASI のボード別時間とピークメモリー

時間は各 5 回の中央値 [最小-最大] ms、メモリーは各ボード・variant の最大値 bytes である。

| Variant | Board | Synth ms | PnR ms | Yosys / nextpnr memory bytes |
|---|---|---:|---:|---:|
| B | 1K | 1,198.472 [1,087.826-1,218.569] | 358.361 [350.842-359.889] | 31,653,888 / 18,874,368 |
| B | 4K | 1,207.426 [1,129.536-1,234.579] | 375.946 [372.640-385.254] | 31,653,888 / 23,724,032 |
| B | 9K | 1,214.594 [1,156.791-1,224.225] | 513.368 [502.500-520.166] | 31,653,888 / 26,542,080 |
| B | 20K | 1,206.442 [1,185.799-1,237.978] | 937.888 [928.923-952.130] | 31,653,888 / 33,357,824 |
| B2 | 1K | 1,209.737 [1,126.735-1,223.778] | 357.268 [346.554-364.663] | 31,653,888 / 18,874,368 |
| B2 | 4K | 1,203.818 [1,103.607-1,228.068] | 373.605 [369.069-378.756] | 31,653,888 / 23,724,032 |
| B2 | 9K | 1,195.214 [1,115.708-1,212.242] | 510.961 [499.602-524.743] | 31,653,888 / 26,542,080 |
| B2 | 20K | 1,187.583 [1,102.094-1,218.177] | 942.416 [941.616-978.700] | 31,653,888 / 33,357,824 |
| O2 | 1K | 1,084.389 [1,030.930-1,100.355] | 337.687 [330.413-348.406] | 31,653,888 / 18,874,368 |
| O2 | 4K | 1,066.120 [1,022.834-1,074.369] | 363.753 [349.236-366.820] | 31,653,888 / 23,724,032 |
| O2 | 9K | 1,072.047 [1,031.631-1,080.760] | 492.765 [492.513-502.579] | 31,653,888 / 26,542,080 |
| O2 | 20K | 1,063.438 [1,051.281-1,073.227] | 936.940 [931.491-954.123] | 31,653,888 / 33,357,824 |
| Os | 1K | 1,024.090 [1,021.406-1,078.297] | 372.661 [371.849-376.033] | 31,588,352 / 18,874,368 |
| Os | 4K | 1,038.926 [1,028.032-1,062.051] | 391.838 [378.208-402.831] | 31,588,352 / 23,658,496 |
| Os | 9K | 1,024.548 [1,021.423-1,029.222] | 535.841 [529.008-545.591] | 31,588,352 / 26,542,080 |
| Os | 20K | 1,027.945 [1,020.774-1,051.452] | 1,018.458 [1,008.115-1,029.317] | 31,588,352 / 33,357,824 |
| Oz | 1K | 1,198.075 [1,189.430-1,238.689] | 468.497 [462.916-474.558] | 31,588,352 / 18,874,368 |
| Oz | 4K | 1,209.625 [1,196.035-1,213.004] | 488.125 [480.954-491.524] | 31,588,352 / 23,658,496 |
| Oz | 9K | 1,204.275 [1,186.154-1,224.810] | 655.314 [649.367-696.202] | 31,588,352 / 26,542,080 |
| Oz | 20K | 1,199.190 [1,191.415-1,219.801] | 1,238.289 [1,236.803-1,258.244] | 31,588,352 / 33,357,824 |
| LTO | 1K | 914.336 [889.786-920.566] | 358.552 [348.595-366.227] | 31,326,208 / 18,874,368 |
| LTO | 4K | 925.384 [888.157-969.045] | 376.958 [375.574-384.366] | 31,326,208 / 23,658,496 |
| LTO | 9K | 915.061 [887.105-918.195] | 522.496 [517.749-528.204] | 31,326,208 / 26,542,080 |
| LTO | 20K | 907.395 [902.333-915.872] | 948.846 [931.767-1,006.348] | 31,326,208 / 33,357,824 |
| TLTO | 1K | 1,172.903 [1,142.247-1,206.576] | 356.645 [344.796-361.444] | 31,653,888 / 18,874,368 |
| TLTO | 4K | 1,189.031 [1,136.584-1,208.099] | 373.896 [364.663-379.849] | 31,653,888 / 23,724,032 |
| TLTO | 9K | 1,200.337 [1,115.721-1,208.881] | 507.850 [506.255-529.808] | 31,653,888 / 26,542,080 |
| TLTO | 20K | 1,213.487 [1,161.063-1,219.731] | 950.083 [943.319-972.673] | 31,653,888 / 33,357,824 |
| SIMD | 1K | 1,149.782 [1,117.800-1,154.787] | 350.948 [347.235-360.148] | 31,653,888 / 18,874,368 |
| SIMD | 4K | 1,156.818 [1,138.269-1,218.139] | 377.378 [367.473-387.585] | 31,653,888 / 23,724,032 |
| SIMD | 9K | 1,158.153 [1,127.470-1,163.480] | 513.214 [508.519-522.942] | 31,653,888 / 26,542,080 |
| SIMD | 20K | 1,140.346 [1,103.820-1,226.501] | 944.062 [935.073-945.166] | 31,653,888 / 33,357,824 |
| TC | 1K | 1,215.315 [1,200.584-1,242.997] | 361.183 [352.839-363.763] | 31,653,888 / 18,874,368 |
| TC | 4K | 1,196.800 [1,151.784-1,204.162] | 375.105 [365.642-383.672] | 31,653,888 / 23,724,032 |
| TC | 9K | 1,199.571 [1,119.361-1,220.468] | 511.528 [503.246-516.429] | 31,653,888 / 26,542,080 |
| TC | 20K | 1,163.480 [1,142.375-1,207.844] | 949.009 [944.255-953.714] | 31,653,888 / 33,357,824 |

### Node の出力同一性

ハッシュを同じボードの B と全回比較した結果である。

| Variant | Netlist JSON | PnR output JSON | `.fs` |
|---|---:|---:|---:|
| B | 20/20 | 20/20 | 20/20 |
| B2 | 20/20 | 20/20 | 20/20 |
| O2 | 20/20 | 20/20 | 20/20 |
| Os | 20/20 | 20/20 | 20/20 |
| Oz | 20/20 | 20/20 | 20/20 |
| LTO | 20/20 | 20/20 | 20/20 |
| TLTO | 20/20 | 20/20 | 20/20 |
| SIMD | 20/20 | 20/20 | 20/20 |
| TC | 20/20 | 20/20 | 20/20 |

4 個の負の対照はすべて成功した。

### Chromium finalists

Node の Tang Nano 20K で各回の synth + PnR を合計し、その中央値で順位を付けた。B2 は A/A 対照のため候補から除外した。出力同一性を全試行で通過した候補のうち、LTO と O2 を Chromium の測定対象に選んだ。

| Variant | Node 20K median per-run total (ms) | 選定 |
|---|---:|---|
| LTO | 1,861.300 | finalist 1 |
| O2 | 2,004.657 | finalist 2 |
| Os | 2,048.583 | finalist 外 |
| SIMD | 2,075.419 | finalist 外 |
| TC | 2,117.194 | finalist 外 |
| B2 | 2,129.460 | A/A 対照、候補外 |
| B | 2,140.299 | 基準 |
| TLTO | 2,163.597 | finalist 外 |
| Oz | 2,435.993 | finalist 外 |

Chromium は B、LTO、O2 を各ボード 5 回測定した。時間は中央値 [最小-最大] ms、`.fs` identity は各ボード 5 回の一致数である。20K の total は各回の synth + PnR の合計値から求めた中央値である。

| Variant | Board | Synth ms | PnR ms | 20K median per-run total (ms) | `.fs` identity |
|---|---|---:|---:|---:|---:|
| B | 1K | 1,598.490 [1,540.480-1,692.350] | 450.735 [431.870-465.840] | — | 5/5 |
| B | 4K | 1,576.980 [1,526.035-1,610.025] | 465.020 [444.880-515.990] | — | 5/5 |
| B | 9K | 1,574.415 [1,538.775-1,700.210] | 633.595 [578.200-663.675] | — | 5/5 |
| B | 20K | 1,547.610 [1,506.945-1,599.650] | 1,030.855 [999.915-1,095.225] | 2,566.865 | 5/5 |
| LTO | 1K | 1,184.320 [1,145.755-1,279.725] | 464.610 [447.770-479.825] | — | 5/5 |
| LTO | 4K | 1,275.495 [1,202.295-1,281.865] | 510.510 [435.505-547.575] | — | 5/5 |
| LTO | 9K | 1,233.075 [1,217.090-1,266.720] | 668.720 [561.955-722.490] | — | 5/5 |
| LTO | 20K | 1,259.840 [1,205.615-1,299.600] | 1,046.925 [959.510-1,090.480] | 2,296.095 | 5/5 |
| O2 | 1K | 1,359.110 [1,279.970-1,376.705] | 413.725 [403.285-471.405] | — | 5/5 |
| O2 | 4K | 1,338.175 [1,262.730-1,447.190] | 461.380 [424.140-475.390] | — | 5/5 |
| O2 | 9K | 1,357.470 [1,303.460-1,367.565] | 553.035 [515.340-685.540] | — | 5/5 |
| O2 | 20K | 1,308.485 [1,298.950-1,372.170] | 1,034.540 [962.320-1,121.490] | 2,341.030 | 5/5 |

### A/A のノイズ

差は B と B2 の各回の synth + PnR 合計値の中央値の絶対差、割合は B に対する比率である。

| Board | B median (ms) | B2 median (ms) | Difference (ms) | Difference (%) |
|---|---:|---:|---:|---:|
| 1K | 1,557.498 | 1,574.400 | 16.902 | 1.085% |
| 4K | 1,589.091 | 1,576.739 | 12.352 | 0.777% |
| 9K | 1,717.094 | 1,711.269 | 5.825 | 0.339% |
| 20K | 2,140.299 | 2,129.460 | 10.839 | 0.506% |

## 捨てた試行と経緯

最初の build フェーズは GNU `time` の表示ラベル `h:mm:ss or m:ss` を誤解析して B の後に停止したため、時間パーサーを修正して B2 を別フェーズでビルドした。B の nextpnr 初回ビルドは PATH に Node.js がなく失敗したため、Node.js を PATH に加えて `nextpnr-retry` にビルドした。最初の smoke run は Node.js の WASI 実行後に閉じられた file descriptor を二重 close して失敗したため、既存の nextpnr helper と同じ `EBADF` 処理を追加し、新しい出力先で再実行した。

### 失敗した試行: 初回 A/A（JOBS=2、SOURCE_DATE_EPOCH 固定前）

B と B2 の Yosys WASM はどちらも 52,926,660 bytes だったが、SHA-256 はそれぞれ `8376ebab361800f771ce0c283699fc3ea6140f1caecb81a0fd0d7d687a7544b0` と `4c252e3bbda1917e284d7043ac675c0635de50d67f2e7750ff3cab8644df5ba3` で、66,642 bytes が異なった。既存の `build/wasi` の SHA-256 は `aa18e2c167d614e4194796041bf4cb533a659b0028668418ee109a6cd9cc58aa` だった。ABC の `mainUtils.c`、`cmdUtils.c` および Cadical の version source が `__DATE__`、`__TIME__` を使い、Yosys の `kernel/version.cc.in` も同じマクロを使うことを確認した。したがって、確認した日時文字列は CMake/Make 生成ではなくコンパイル時マクロ由来である。初回 B/B2 の ABC 文字列には異なるビルド日時が入っていた。

### 失敗した試行: 低最適化 Yosys のビルド

従来の O2/Os/Oz 条件は最適化フラグに `-DNDEBUG` も加えていた。B の `build/s5/B/yosys/compile_commands.json` に記録された `passes/cmds/symfpu.cc` の実コンパイルコマンドは `-O3` を含み、`-DNDEBUG` は含まない。一方、従来の O2 コマンドは `-O3 -O2 -DNDEBUG` だった。`vendor/yosys/passes/cmds/symfpu.cc:68-70` では該当する `bool b` が `assert(b)` だけで使われ、`vendor/yosys/CMakeLists.txt:109-113` は未使用引数をエラーにする。そのため `-DNDEBUG` が assert を無効にした条件だけ `-Werror=unused-parameter` で失敗した。条件を修正し、O2/Os/Oz から `-DNDEBUG` を除いた。upstream の警告設定は変更しない。

### 失敗した試行: nextpnr の LTO 条件

従来の nextpnr LTO と TLTO の成果物は、B と同じ SHA-256 `b011f1d2798dead2698d58037d40523885330b7c0c7df2cf9577f07dbcfc7e7f` だった。`vendor/nextpnr/CMakeLists.txt:38` で `USE_IPO` が既定で ON になり、同ファイルの 50-62 行で CMake IPO を有効にする。B、LTO、TLTO の `CMakeCache.txt` も `USE_IPO:BOOL=ON` だった。B の nextpnr compile command には `-flto=thin` が入り、LTO の compile command は明示した `-flto` の後ろに `-flto=thin` が続いていた。54 個の `.obj` はいずれも LLVM bitcode magic `42 43 c0 de` であり、B は既に ThinLTO である。LTO は nextpnr だけ `-DUSE_IPO=OFF` とし、明示した `-flto` が compile/link command に残る条件に直した。TLTO は B の nextpnr WASM を再利用し、別ビルドによる効果を主張しない。

修正後の LTO は `build/s5/attempt3-builds/LTO/nextpnr/CMakeCache.txt` で `USE_IPO:BOOL=OFF`、`himbaechel/uarch/gowin/CMakeFiles/nextpnr-himbaechel-gowin.dir/flags.make` と `link.txt` で `-flto` あり・`-flto=thin` なしを確認した。`make -B -n VERBOSE=1 nextpnr-himbaechel-gowin` の `main.cc` compile command も同じ条件だった。52 個すべての `.obj` は LLVM bitcode magic `42 43 c0 de` で、WASM SHA-256 は `fd4b6d1edccd2ac5558b1f9447d20fe83409ff1615aeee94a58294e440fd4b73`。B の `b011f1d2798dead2698d58037d40523885330b7c0c7df2cf9577f07dbcfc7e7f` とは異なる。

## 判定（事前に決めた基準に当てはめた結果）

判定に使った値は Chromium の Tang Nano 20K の値です。各回の「合成 + 配置配線」を合計し、5 回の中央値をとりました（attempt3）。大きさは、Yosys と nextpnr の zstd -19 の合計です。

| 案 | 20K の中央値 | B との差 | zstd の合計 | B との差 | ビルドの時間（Yosys + nextpnr） | B との比 |
|---|---:|---:|---:|---:|---:|---:|
| B | 2,566.865 ms | — | 15,253,172 bytes | — | 932.330 s | 1.00 |
| LTO | 2,296.095 ms | 10.5% 速い | 13,476,347 bytes | 11.6% 小さい | 1,687.510 s | 1.81 |
| O2 | 2,341.030 ms | 8.8% 速い | 14,335,984 bytes | 6.0% 小さい | 889.790 s | 0.95 |

- 基準 1（出力の一致）：判定に使った全案が、全ボード・全回でネットリスト、配置配線の結果、`.fs` を B とバイト単位で一致させました（Node 各 20/20、Chromium 各 5/5）。trap と失敗は 0 件です。
- 基準 2：LTO は 2 つの条件の両方を満たします。速さは 10.5% で、10% を超えています。Node の B と B2 の差（20K で 0.506%）も上回ります。大きさは 11.6% 小さく、遅くもなっていません。O2 は、速さ（8.8%）と大きさ（6.0%）のどちらでも基準に届きません。
- 基準 3：LTO のビルドの時間は B の 1.81 倍で、2 倍以内です。
- 基準 4：LTO は WASM の新しい機能を使いません。target features は B と同じです。
- 結論：LTO を採ります。Yosys は `-flto` を付けます。nextpnr は `USE_IPO=OFF` と `-flto` で全体を LTO にします。

### 注意すること

- Chromium での B の 20K の中央値は、attempt2 で 2,691.440 ms、attempt3 で 2,566.865 ms でした。測る回によって 4.6% 変わります。速さの差 10.5% は基準をわずかに超えただけなので、大きさの条件も満たすことを採用の主な根拠にします。
- LTO の Yosys のビルドは、ピーク RSS が 7,790,104 KiB です。B は 393,416 KiB でした。CI の runner のメモリーで足りるかは、採用の PR の CI で確かめます。
- Os は、zstd の合計が 13,235,553 bytes（13.2% 小さい）でした。Node の 20K でも B より速く、2,048.583 ms でした。ただし、決勝に残す 2 案を速さの順で選ぶ規則だったため、Chromium では測っていません。Os と LTO を組み合わせた案も試していません。
- nextpnr の TLTO は B と同じです。B は upstream の `USE_IPO`（`vendor/nextpnr/CMakeLists.txt:38`、50〜62 行）で、すでに ThinLTO でビルドされています。
- 実機の Tang Nano では試していません。

## 未確認の点

LTO で新しい target feature は増えず、B と同じである。実機の Tang Nano では測定していないため、結果を実機の性能として扱わない。LTO を既定ビルドに反映する変更は別 PR で行う。

- S5B で追加測定: [S5B Yosys・nextpnr の Os／LTO／Os+LTO 比較](S5B-os-lto-chromium.md)で候補を追加比較し、凍結した選定規則により OsLTO を選んだ。既定 build script への反映は別 PR で行う。

## ログ

大きなビルドログと Node WASI の実行ファイルは `build/s5/` に置き、コミットしない。正式記録では再生成コマンドと SHA-256 を示す。
