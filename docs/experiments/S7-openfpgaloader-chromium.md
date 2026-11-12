# S7: Chromium における openFPGALoader ビルドオプション比較

事前登録。正式計測の前に、目的、仮説、基準、条件、手順を固定する。結果はこの文書と対応する CSV に記録する。

## 目的

openFPGALoader のビルドオプションが、Chromium 上の Web フラッシャーでの書き込み時間、WASM のロード時間とサイズ、ビルド時間、メモリー使用量、安定性に与える影響を比較する。仮想 USB による時間は実機の値として扱わず、実機では試していない。

## 仮説

B を基準に、B+O3、B+O3+LTOA、B+LTOA のいずれかが、安定性の条件をすべて満たしたうえで、B と B2 の差から求めるノイズ幅を超え、かつ主指標を 3% 以上改善すると予測する。条件を満たす候補がなければ B を維持する。

## 基準

安定性の各条件はすべて必須とし、ひとつでも満たさない候補は選定対象から外す。

1. すべての試行で成功し、ログに `FAIL` がなく、trap や hang がないこと。仮想デバイスの最終 SRAM／フラッシュ内容、または既存 E2E の検証信号が、期待する fixture のデータと一致すること。
2. 各候補を 2 回ビルドし、`.wasm` と `.mjs` の SHA-256 がそれぞれ一致すること。
3. 各候補の成果物を使い、`WASM_BUILD_ROOT=... node --test --test-concurrency=1 tests/sim/*.test.mjs` が 5 回連続で成功すること。
4. WASM が使う機能は、製品が必要とする WebUSB と JSPI に対応する安定版 Chromium でサポートされるものに限ること。`wasm-objdump` で検出した機能を記録する。
5. B と選定候補について、次の負の対照を行い、どちらも失敗を検出すること。
   - 1 byte 壊した `.fs` では、書き込み失敗（`FAIL` の検出または verify 不一致）が報告されること。
   - WASM code section の 1 byte を壊すと、UI がロード失敗を検出すること。
6. ビルドの peak RSS が 14 GiB 未満であり、ビルド wall time が B の 2 倍以下であること。

候補の主指標は、8 種類の書き込みケースそれぞれの経過時間の中央値を合計した値とする。B と B2 の主指標の差を `N = |primary(B) - primary(B2)|` と定義する。選定候補は、B より `N` を超えて速く、かつ 3% 以上速い候補とする。条件を満たす候補のうち最も速いものを選ぶ。候補どうしが `N` 以内の差で並ぶ場合は、フラグ数が少ないもの（LTO なしを LTO より優先し、Os を O3 より優先）、次に gzip 圧縮後の WASM が小さいものを選ぶ。該当候補がなければ B を維持する。

二次指標は instantiate の中央値、WASM の raw／gzip／zstd サイズ、ビルド wall time、peak RSS とする。仮想 USB の時間は実機の性能値ではない。

## 条件

- 基準 commit: `092a31bd1fa03ed900ae7eab2b3b4ad926bb80d6`（`origin/main`）。
- 変種は既存の `scripts/build-wasm.sh` profile 構文を使い、`--async=jspi` と pthread を有効にする。`--variant` なしの既定ビルドは変更せず、`.wasm` と `.mjs` の SHA-256 が `origin/main` のビルドと一致することを確認する。
- 変種は次の 5 つとする。
  - B: 現行設定の `-Os`、LTO なし。
  - B2: B を別の `BUILD_ROOT` で再ビルドする。A/A とノイズ幅の確認に使う。
  - B+O3: `-O3`。
  - B+O3+LTOA: `-O3` と全対象への LTO。
  - B+LTOA: `-Os` と全対象への LTO。
- 「Os」はユーザーの指定どおり B（現行設定）を指す。各変種の `flags.make` と `link.txt` で `-O` が各行にちょうど 1 つあること、および LTO フラグが期待どおりであることを S1b と同じ方法で確認する。
- Chromium headless と Playwright を使い、同じホストで他の重い処理を動かさずに実行する。Node からの書き込み測定は行わない。アプリの実際の Web フラッシャー経路と `tests/e2e/fake-usb-helpers.mjs` の仮想 WebUSB を使い、各試行で新しいページを使う。
- 書き込みケースは Tang Nano 1K、4K、9K、20K の各 SRAM／flash の計 8 ケースとする。fixture は `tests/fixtures` が作る `.fs` を使う。別に instantiate（モジュールのロード、compile、instantiate が ready になるまで）を測る。
- 5 回以上繰り返し、各反復で変種の順を round-robin に回転させる。1 ケース 120 秒を超えた場合は失敗として扱う。
- 基準 commit、emsdk と Chromium のバージョン、ホスト CPU、コマンド、環境変数、成果物の SHA-256、出力先を記録する。仮想 USB の結果には「実機では試していない」と明記する。

## 手順

1. `origin/main` を fetch し、記録する基準 commit から指定ブランチを作る。`scripts/build-wasm.sh` を引数なしで実行し、`.wasm` と `.mjs` の SHA-256 を `origin/main` の同じ既定ビルドと比較する。
2. 各変種を別の `BUILD_ROOT`（`build/s7/` 以下）でビルドする。コマンド、環境、wall time、peak RSS、`.wasm` と `.mjs` の SHA-256 を保存する。既存の出力を上書きしない。
3. 各ビルドの `flags.make` と `link.txt` を検査し、期待する最適化レベルが一つだけあり、LTO の有無と範囲が指定どおりであることを記録する。
4. 各変種を 2 回ビルドして A/A の SHA-256 を比較する。各変種の成果物を使ってシミュレーションテストを 5 回連続で実行し、すべての結果を保存する。
5. `wasm-objdump` で機能を調べ、安定版 Chromium の対応状況を確認する。
6. Chromium 上で、8 つの書き込みケースと instantiate を 5 回以上測る。反復ごとに変種順を回転し、毎回新しいページを使う。成功状態、ログ、fixture との一致を確かめ、失敗を含む全試行を記録する。
7. B と、結果に基づいて選ぶ候補のそれぞれで、1 byte 壊した `.fs` と code section を 1 byte 壊した WASM の負の対照を行い、UI が失敗を検出することを確かめる。
8. 安定性の各条件への適合を確認し、主指標から `N` を求めたうえで、固定した選定規則を機械的に適用する。結果と失敗試行を Markdown と CSV に記録し、ログは `build/s7/` に保存する。記録には VM 固有の絶対パスを含めない。

### 手順への追記（2026-10-29、事前登録後・正式計測前）

各 Chromium 書き込み試行では、`tests/e2e/fake-usb-helpers.mjs` の opt-in 状態取得を使って fake USB の最終状態を読み戻す。SRAM は `tests/sim/program.test.mjs` と同じ `parseFsPayload(..., true)` のバイト列、Tang Nano 20K の外付け NOR は `parseFsPayload(..., false)` のバイト列、その他の内蔵フラッシュは `GW1N`、20 バイトの `0xff`、`parseFsPayload(..., false)` を連結したバイト列と比較する。比較は各試行の UI 成功判定の後に行い、長さと全バイトが一致しなければ失敗とする。正式計測前の smoke では、期待値の先頭バイトを反転する負の対照を実行し、比較が不一致を検出することを確認する。基準 5 の負の対照では、fixture の先頭ビットを反転したファイルを入力して内容不一致を確認し、さらに WASM code section の命令を不正化して UI が load failure を検出することを確認する。fake デバイスのモデル（`tests/sim/fake-webusb.mjs`）と permanent test の assertions は変更していない。`tests/e2e/fake-usb-helpers.mjs` には opt-in の fake state capture を追加したが、既定では無効であり、既存の E2E 呼び出しは従来どおり動作する。

### 手順への追記（2026-10-30、事前登録後・正式計測前）

round 1 の instantiate 25 試行はすべて失敗した。以前のベンチは blob module worker から `/openFPGALoader.mjs` を import しており、`Failed to resolve module specifier` となった。production は `web/app.js` から同じ origin の module worker を作り、`web/worker.js` が `./openFPGALoader.mjs` を相対 import する。ベンチの instantiate 試行では、app module URL を基準に bench 専用 worker `scripts/s7-instantiate-worker.js` を作り、その worker 内で production と同じ `import("./openFPGALoader.mjs")` を行って `instantiate({ noInitialRun: true })` を呼ぶ。これは production の `web/worker.js` ではないため、計測時間に app 側の worker message handling は含まれない。worker 応答には `web/_headers` と同じ COOP、COEP、CORP を設定した。

修正前の instantiate smoke は 0/5 で、worker error event から message、filename、stack を取得できなかった。response に production と同じ header set を加えた後の独立 smoke は 5/5 pass した。原因の詳細は browser event に現れなかったため、header 追加で解消したこと以上は特定していない。1 repeat の smoke は正式計測 CSV に含めない。最終 smoke の記録は `$REPO_ROOT/build/s7/chromium-instantiate-smoke-round2-coep.csv` と `.log` にある。実行コマンドは次のとおり。

```sh
cd "$REPO_ROOT"
mise exec -- node scripts/bench-s7-openfpgaloader.mjs \
  --mode=smoke --case=instantiate --variant=all --repeats=1 \
  --out=build/s7/chromium-instantiate-smoke-round2-coep.csv
```

## 結果（2026-10-30）

### 実行環境と出力

- 基準 commit は `092a31bd1fa03ed900ae7eab2b3b4ad926bb80d6`。実験用 build root は `$REPO_ROOT/build/s7/build-roots/<変種>` とし、各 build の出力を新規に作成した。
- Linux x86_64、Intel Xeon CPU D-1531 @ 2.20 GHz、12 論理 CPU、RAM 30 GiB。Node.js v24.22.1、Playwright 1.64.1、Emscripten 6.0.13、Binaryen `wasm-dis` 133、Chromium 156.0.8078.4 を使用した。
- 関連 submodule は emsdk `35659964bc2762fffec0d257997fb61475f765b7`、openFPGALoader `befbab4f646207dbaf1daf8b144dd980ad283dd5`、libusb `87a55632db62c9bdc58cd31d3ccfa673f1bb017f`、libftdi `92d657bcb543a9622947d984d4a8e725fb680e8c`、zlib `da607da739fa6047df13e66a2af6b8bec7c2a498`。
- S7 基準時点の引数なし既定 build を新しい `$REPO_ROOT/build/s7/default-confirmation/jspi-pthread` に作り、WASM は `84cb4077c3d02ab5392d47798e6a10d540ad8db9e547424926501bdaaccd285c`、MJS は `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` となった。`build-info.json` の値とも一致し、指定された origin/main の SHA と byte-for-byte で一致した。wall time は 145.47 秒、peak RSS は 255,784 KiB。これは測定時点の既定 build の記録である。
- 各変種の build は別の `BUILD_ROOT` に出力し、`/usr/bin/time -v` で計測した。B の実行例は次のとおり。A/A では別の build root を使い、各変種を2回 build して SHA を比較した。

```sh
cd "$REPO_ROOT"
BUILD_ROOT="$REPO_ROOT/build/s7/build-roots/B" \
  /usr/bin/time -v scripts/build-wasm.sh --variant=B
```

- sim は各変種で次のテストを5回実行した。B+O3 などでは3つの `B` を同じ変種名に置き換える。各回のログは `$REPO_ROOT/build/s7/formal-sim-corrected/` にある。

```sh
cd "$REPO_ROOT"
WASM_BUILD_ROOT="$REPO_ROOT/build/s7/build-roots/B" \
WASM_VARIANT=B WASM_VARIANTS=B \
  mise exec -- node --test --test-concurrency=1 tests/sim/*.test.mjs
```

- 正式 Chromium 行列は次のコマンドで実行した。1 ケースの timeout は 120 秒、各試行は新しい browser context/page を使い、5 反復で変種の順を round-robin に回した。

```sh
cd "$REPO_ROOT"
mise exec -- node scripts/bench-s7-openfpgaloader.mjs \
  --mode=formal --repeats=5 --variant=all --case=all \
  --manifest=build/s7/variants.json \
  --out=build/s7/formal-chromium-round2.csv
```

round 2 の 225 試行は 225/225 pass。8 programming cases の 200 試行はすべて UI 成功、`FAIL` なし、progress 100%、fake device の SRAM または flash 内容が fixture 由来の期待値と一致した。instantiate も 25/25 pass した。全生値は [S7 CSV](S7-openfpgaloader-chromium.csv) に収録し、round 1 と negative control を含む。round 1 の programming 時間は監査用に残すが、集計と選定には使っていない。正式行列の出力は `$REPO_ROOT/build/s7/formal-chromium-round2.csv`、実行ログは `$REPO_ROOT/build/s7/formal-chromium-round2.log` と `.csv.server.log` に保存した。

### Chromium の絶対値

次のセルは 5 試行の中央値と最小-最大をミリ秒で示す。各 primary は 8 cases の中央値の合計である。生の各試行値は CSV に残した。

| ケース | B | B2 | B+O3 | B+O3+LTOA | B+LTOA |
|---|---:|---:|---:|---:|---:|
| Tang Nano 1K SRAM | 560.950 [522.470-582.475] | 548.530 [541.595-561.665] | 574.280 [560.585-600.150] | 563.705 [540.755-597.150] | 518.650 [489.525-595.415] |
| Tang Nano 1K flash | 2198.445 [2188.050-2286.725] | 2202.680 [2182.555-2229.575] | 2233.180 [2195.885-2260.780] | 2197.105 [2142.965-2230.580] | 2147.910 [2113.520-2210.585] |
| Tang Nano 4K SRAM | 678.740 [649.820-762.205] | 654.880 [652.790-662.885] | 696.110 [673.785-728.980] | 651.550 [626.950-661.940] | 631.085 [620.480-644.470] |
| Tang Nano 4K flash | 3163.695 [3113.195-3228.310] | 3192.445 [3125.990-3358.285] | 3148.225 [3079.650-3196.575] | 3129.890 [3026.595-3265.095] | 3096.870 [3076.740-3177.265] |
| Tang Nano 9K SRAM | 809.340 [764.330-862.035] | 779.950 [775.630-851.305] | 799.015 [750.510-811.940] | 777.780 [762.165-810.625] | 736.410 [718.350-746.990] |
| Tang Nano 9K flash | 4193.490 [4112.785-4260.240] | 4145.095 [4086.595-4296.165] | 4134.890 [4057.885-4163.005] | 4195.050 [3959.945-4233.715] | 4045.980 [4029.520-4188.995] |
| Tang Nano 20K SRAM | 1055.105 [1048.605-1061.235] | 1069.175 [1033.320-1121.035] | 1080.435 [1028.880-1097.105] | 1063.365 [1041.625-1080.600] | 1014.565 [1003.055-1057.160] |
| Tang Nano 20K flash | 2831.750 [2747.470-2984.220] | 2953.925 [2783.075-3100.315] | 2814.095 [2747.100-2843.760] | 2832.010 [2777.910-2915.930] | 2803.225 [2736.140-2815.755] |

### 変種別の指標と安定性

`N = |primary(B) - primary(B2)| = |15491.515 - 15546.680| = 55.165 ms`。改善量は `primary(B) - primary(変種)` とし、改善率は B を分母にした。WASM 圧縮サイズは gzip level 9（mtime 0）と zstd 1.5.7 `-19` の値である。

| 変種 | primary (ms) | N (ms) | B 比の改善量 / 率 | instantiate 中央値 [最小-最大] (ms) | WASM raw / gzip-9 / zstd-19 (bytes) |
|---|---:|---:|---:|---:|---:|
| B | 15491.515 | 55.165 | 0.000 ms / 0.000% | 339.035 [327.760-350.530] | 2280871 / 635186 / 229717 |
| B2 | 15546.680 | 55.165 | -55.165 ms / -0.356% | 333.545 [302.990-348.270] | 2280871 / 635186 / 229717 |
| B+O3 | 15480.230 | 55.165 | 11.285 ms / 0.073% | 388.230 [335.385-395.175] | 2040830 / 702682 / 258099 |
| B+O3+LTOA | 15410.455 | 55.165 | 81.060 ms / 0.523% | 319.370 [310.000-333.450] | 1952305 / 679495 / 263481 |
| B+LTOA | 14994.695 | 55.165 | 496.820 ms / 3.207% | 297.640 [280.265-316.160] | 1639776 / 579467 / 229068 |

| 変種 | A/A の SHA 照合 | sim 連続実行 | WASM 機能の確認 | build wall / peak RSS |
|---|---|---:|---|---:|
| B | pass | 5/5 | bulk-memory、sign-extension、atomics、non-trapping float-to-int。SIMD なし | 165.55 秒 / 269452 KiB |
| B2 | pass | 5/5 | 同上 | 165.18 秒 / 262340 KiB |
| B+O3 | pass | 5/5 | 同上 | 145.49 秒 / 311176 KiB |
| B+O3+LTOA | pass | 4/5、安定性 gate 4 不合格 | 同上。`i64.trunc_sat_f64_u` あり | 189.56 秒 / 579820 KiB |
| B+LTOA | pass | 5/5 | 同上。`i64.trunc_sat_f64_u` あり | 154.47 秒 / 530932 KiB |

build wall と RSS は各変種の最初の smoke build の値であり、正式 Chromium 計測中には build を行っていない。`flags.make` と `link.txt` の確認は全変種で pass した。B と B2 は `-Os`、LTO なし、B+O3 は `-O3`、LTO なし、B+O3+LTOA は `-O3` と LTO、B+LTOA は `-Os` と LTO だった。section listing は `$REPO_ROOT/build/s7/formal-wasm-objdump.txt` にある。instruction scan は各 WASM に対して Binaryen 133 の `wasm-dis --all-features` を実行し、結果を `$REPO_ROOT/build/s7/formal-wasm-feature-scan.txt` に保存した。全変種で `memory.copy`、`memory.fill`、`i32.extend8_s`、`i32.extend16_s`、atomics、saturating float-to-int conversions を確認し、SIMD 命令はなかった。`i64.trunc_sat_f64_u` は LTO の2変種で確認した。計測したすべての module は Chromium 156.0.8078.4 で instantiate できた。build gate は RSS 14 GiB 未満、wall time が B の 2 倍以下であり、全変種が通った。A/A の全 SHA は `$REPO_ROOT/build/s7/formal-aa-results.csv` にある。SHA は各変種の2 build で一致した。代表する一致値は次のとおり。

| 変種 | A1 = A2 `.wasm` SHA-256 | A1 = A2 `.mjs` SHA-256 |
|---|---|---|
| B | `ecf7617859639422050c1098edc1dac04e943def90cb5a7328b8035714cb42b7` | `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` |
| B2 | `ecf7617859639422050c1098edc1dac04e943def90cb5a7328b8035714cb42b7` | `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` |
| B+O3 | `d5a3e8f029375f70e8aae6f278fdb08d1f27b55a725bf377c3f8a66c3c3a3633` | `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` |
| B+O3+LTOA | `191123667fc7c13ea3b7f75eb19e24fbcb94570c3be4e75d556c1fbf4fc263e2` | `f66be852ed33c8245fe781d900a7124186a6d3cd611a81849e1019ae080d8d44` |
| B+LTOA | `5ccccd017186a7a8d137f9791e08a53cf2fedaa5aaa59143028def8908557812` | `f66be852ed33c8245fe781d900a7124186a6d3cd611a81849e1019ae080d8d44` |

### 選定

B+O3+LTOA は sim が 4/5 のため、他の測定値にかかわらず安定性 gate 4 に不合格で、選定対象外とした。B2 は noise floor のみを求める基準である。選定可能な変更候補 B+O3 は B より 11.285 ms（0.073%）速いだけで、`N` と 3% の両条件を満たさない。B+LTOA は B より 496.820 ms（3.207%）速く、`N = 55.165 ms` を超え、3% 条件も満たす。よって凍結規則による選定は **B+LTOA**。この選定を反映し、引数なしの JSPI build では B+LTOA を既定にする。以前の既定 build は `scripts/build-wasm.sh --variant=B` で再現できる。

### JSPI 既定 profile の再現確認

引数なしの JSPI build は、出力先 `build/jspi-pthread` と metadata の variant `C` を保ったまま、`-Os` と全対象への LTO を使う。出力 WASM の SHA-256 `61c4943252821a0d1405133c11690b7718fb5af28c86bf102e926ccba780a642` は S7 の B+LTOA 成果物 `5ccccd017186a7a8d137f9791e08a53cf2fedaa5aaa59143028def8908557812` と異なるが、`-ffile-prefix-map=$build_root=/build` が出力下位ディレクトリー名 `/build/jspi-pthread/` と `/build/B+LTOA/` を埋め込むためである。MJS の SHA-256 はどちらも `f66be852ed33c8245fe781d900a7124186a6d3cd611a81849e1019ae080d8d44` で一致し、パスの正規化は行っていない。

`strings` と WAT の diff では、埋め込みパスと、その長さの違いに伴う data offset のみが変化した。

4条件の再現コマンドは次のとおり。各 build の出力は別の `BUILD_ROOT` に保存した。

```sh
export REPO_ROOT="$(git rev-parse --show-toplevel)"
BUILD_ROOT="$REPO_ROOT/build/ofl-default-oslto-factor-check" JOBS=2 "$REPO_ROOT/scripts/build-wasm.sh" --variant=B+LTOA
BUILD_ROOT="$REPO_ROOT/build/ofl-default-oslto-factor-B" JOBS=2 "$REPO_ROOT/scripts/build-wasm.sh" --variant=B
BUILD_ROOT="$REPO_ROOT/build/ofl-default-oslto-default" JOBS=2 "$REPO_ROOT/scripts/build-wasm.sh"
BUILD_ROOT="$REPO_ROOT/build/ofl-default-oslto-aa" JOBS=2 "$REPO_ROOT/scripts/build-wasm.sh"
```

| 条件 | 結果 |
|---|---|
| 1. `--variant=B+LTOA` | `$REPO_ROOT/build/ofl-default-oslto-factor-check/B+LTOA/` の WASM `5ccccd017186a7a8d137f9791e08a53cf2fedaa5aaa59143028def8908557812`、MJS `f66be852ed33c8245fe781d900a7124186a6d3cd611a81849e1019ae080d8d44`。S7 の `$REPO_ROOT/build/s7/build-roots/B+LTOA/B+LTOA/` と両方一致した。 |
| 2. `--variant=B` | `$REPO_ROOT/build/ofl-default-oslto-factor-B/B/` の WASM `ecf7617859639422050c1098edc1dac04e943def90cb5a7328b8035714cb42b7`、MJS `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27`。S7 の `$REPO_ROOT/build/s7/build-roots/B/B/` と両方一致した。旧 `jspi-pthread` build の WASM `84cb4077c3d02ab5392d47798e6a10d540ad8db9e547424926501bdaaccd285c` とは不一致だが、MJS は旧値 `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` と一致した。 |
| 3. 既定 build と S7 B+LTOA | `$REPO_ROOT/build/ofl-default-oslto-default/jspi-pthread/` の WASM `61c4943252821a0d1405133c11690b7718fb5af28c86bf102e926ccba780a642`、MJS `f66be852ed33c8245fe781d900a7124186a6d3cd611a81849e1019ae080d8d44`。`flags.make` と `link.txt` は build path を置き換えた後の diff がそれぞれ 0 行だった。`strings` diff は削除7行・追加7行の計14行で、全行が埋め込み build path。`wasm-dis` WAT diff は削除14,038行・追加14,038行。内訳は data 24行、global 2行、`i32.const` 27,766行、memory offset 248行、`i64.const` 4行、`call` 16行、閉じ括弧16行で、後者は offset を含む差分 hunk に現れた。比較ファイルは `$REPO_ROOT/build/ofl-default-oslto-diff-s7.wat`、`ofl-default-oslto-diff-default.wat`、`ofl-default-oslto-diff-s7.strings`、`ofl-default-oslto-diff-default.strings`。 |
| 4. 既定 build の A/A | `$REPO_ROOT/build/ofl-default-oslto-aa/jspi-pthread/` は1回目と同じ WASM `61c4943252821a0d1405133c11690b7718fb5af28c86bf102e926ccba780a642`、MJS `f66be852ed33c8245fe781d900a7124186a6d3cd611a81849e1019ae080d8d44` だった。 |

1回目と A/A の build log は `$REPO_ROOT/build/ofl-default-oslto-default.build.log`、`$REPO_ROOT/build/ofl-default-oslto-aa.build.log` にある。factor build のログは同じ `build/` 直下の `ofl-default-oslto-factor-check.build.log` と `ofl-default-oslto-factor-B.build.log` に保存した。

asyncify は S1b のフラグを維持し、現行スクリプトと origin/main の `flags.make` / `link.txt` は build root 置換後の diff が各 0 行（configure-level の一致でバイト同一性は未確認）だったが、この VM での full link は 1:18:51・peak RSS 15.3 GB で終了コード 2 により失敗し、バイト同一性は本リポジトリでは試していない（origin/main でも同じ失敗となるかは未確認）。

### 負の対照

B と選定変種 B+LTOA のそれぞれで Tang Nano 9K SRAM を用い、`.fs` の先頭ビットと WASM code section を壊した。4 対照すべてが失敗を検出した。負の対照は正式な timing 行列には含めない。

| 変種 | 対照 | 検出結果 |
|---|---|---|
| B | `.fs` の1 bit反転 | fake SRAM の byte 0 が期待値 `255` に対して `254` となり、内容不一致を検出 |
| B | WASM code section の1 byte破損 | UI が `失敗：書き込み失敗`、progress 0 を表示。WebAssembly compile が function body count mismatch で拒否 |
| B+LTOA | `.fs` の1 bit反転 | fake SRAM の byte 0 が期待値 `255` に対して `254` となり、内容不一致を検出 |
| B+LTOA | WASM code section の1 byte破損 | UI が `失敗：書き込み失敗`、progress 0 を表示。WebAssembly compile が function body count mismatch で拒否 |

各対照の実行ログと CSV は `$REPO_ROOT/build/s7/negative-control-B-fs.log`、`negative-control-B-wasm.log`、`negative-control-BpLTOA-fs.log`、`negative-control-BpLTOA-wasm.log` と同名の CSV に保存した。

### 失敗した試行と診断

- round 1 の `$REPO_ROOT/build/s7/formal-chromium-round1.csv` と `.log` は変更せず保存した。200 programming trials は UI と fake device の内容検査を通ったが、25 instantiate trials はすべて `TypeError: Failed to resolve module specifier '/openFPGALoader.mjs'` で失敗した。blob worker 内の root-relative import が解決されない harness の誤りだったため、round 1 全体を失敗した試行として扱い、そこに含まれる programming timings は選定・結果表に使用していない。新しい URL resolution を確認してから round 2 を全件やり直した。
- instantiate 修正の初期 smoke 2 回は 0/5 だった。worker error event の詳細は取得できなかった。production と同じ COOP、COEP、CORP header を worker route に付けた後は 5/5 pass した。失敗イベントだけから詳細な browser 内原因は確認できていない。初期 smoke は `$REPO_ROOT/build/s7/chromium-instantiate-smoke-round2.csv` と `chromium-instantiate-smoke-round2-diagnostic.csv`、最終 smoke は `chromium-instantiate-smoke-round2-coep.csv` に保存した。
- B+O3+LTOA は `$REPO_ROOT/build/s7/formal-sim-corrected/BpO3pLTOA-run-5.log` で gate 4 に不合格となった。USB disconnect during transfer のテストで `NotFoundError` が続き、`spawnSync` の 90 秒 timeout 経路に入った。ログ中の `__PROGRAM_RESULT__` は `exitCode:0` だが、timeout 経路の外側は失敗を返した。分類は timeout/host load としたが、host load が原因という仮説は未確認である。isolated diagnostic は 1/1 pass したものの、5回連続の正式失敗を置き換えるものではない。再実行して gate の結果を上書きしていない。
- B+LTOA の初回 run 1 は調査中断時に停止し、`$REPO_ROOT/build/s7/formal-sim-corrected/BpLTOA-run-1.log` は 14 pass、0 fail、1 cancelled だった。その後の独立 rerun series は `$REPO_ROOT/build/s7/formal-sim-corrected/BpLTOA-rerun-1.log` から `BpLTOA-rerun-5.log` まで 5/5 pass した。中断 run 1 は連続 pass の代わりにせず、完了した5回の series で安定性を判定した。

仮想 FT2232、GOWIN TAP、NOR flash での測定であり、**実機では試していない**。配布先での実機書き込み、別の Chromium channel、別 OS の検証は**本リポジトリでは試していない**。

### レビュー時の E2E 回帰確認（2026-10-30）

`tests/e2e/web-flasher.spec.mjs` と `tests/e2e/synthesis.spec.mjs` はどちらも `fake-usb-helpers.mjs` を import する。両 spec を含む下記コマンドは 38/38 pass（web-flasher 26、synthesis 12）した。`playwright.config.mjs` の webServer が `scripts/build-web.sh` を実行してから配信するため、この実行で `dist/` も再構築した。

```sh
PLAYWRIGHT_PORT=8123 mise exec -- npx playwright test \
  tests/e2e/web-flasher.spec.mjs tests/e2e/synthesis.spec.mjs
```
