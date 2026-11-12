# S4A ブラウザー内ビルドの測定

- 状態: 完了
- 日付: 2026-10-27
- 担当: Devin
- 関連: `RESEARCH.md` の S4 節

## 目的と仮説

Chromium の Worker 内で、Tang Nano 1K・4K・9K・20K の Verilog テンプレートを合成・配置配線し、`.fs` を作成できるか確認します。Node WASI Yosys、Node WASI nextpnr、native `gowin_pack` で作成した基準ファイルと、ブラウザーの出力がバイト単位で一致すると予想します。

## 採否の基準（結果を見る前に書く）

- 4 ボードそれぞれで5回の出力が基準 `.fs` とバイト単位で一致し、IDCODE が一致すること。
- 各回で合成・配置配線・ビットストリームの時間が記録されること。
- Yosys、nextpnr、gowin_pack の memoryBytes を記録すること。取得できない値は成功扱いにせず、理由を記録すること。
- 1回でも出力差、IDCODE 不一致、計測値欠落があれば、実験を完了扱いにせず原因を記録する。

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | `e90e19916f4682e5b4dcfbb9ae134ecc66152a6f` |
| ホスト | Ubuntu 26.04.1 LTS、Linux 7.0.0-38-generic、12 CPU、30.2 GiB メモリー |
| Node.js | v24.22.1 |
| Playwright / Chromium | Playwright 1.64.1、Chrome for Testing 156.0.8078.4 (revision 1248) |
| submodule | Yosys `28ba3cb926fe376fa05ebfc1b921747d011d4557`、nextpnr `62e659ed6748e9f60b2a4aa25dd4fe79a9605881` |
| ツール | Yosys v0.70、nextpnr 0.11.1、WASI SDK 34.0、Pyodide 314.0.7 (Python 3.14.2)、Apicula 0.35、NumPy 2.4.6、msgspec 0.20.0 |
| 出力先と状態 | `BUILD_ROOT=build/t2-s4-verify` を使って Web app を再構成。WASI と pack build asset は既存成果物を使用 |
| 変える条件 | ボード family |
| 変えない条件 | Verilog、制約、WASI 引数、Chromium、Worker、期待ファイル |
| 繰り返し | 各ボード5回。各 test の最初の実行は Pyodide 初期化を含み、以降は同じ page の Worker を再利用 |

## 手順

```sh
BUILD_ROOT=build/t2-s4-verify scripts/build-web.sh
PLAYWRIGHT_PORT=8123 BUILD_ROOT=build/t2-s4-verify npx playwright test tests/e2e/synthesis.spec.mjs --reporter=line
```

## 計測器の検証

Playwright E2E は各ブラウザー成果物の SHA-256 とサイズを、Node pipeline が作った基準 `.fs` と照合します。IDCODE は基準ファイルで board table と照合し、SHA-256 一致によりブラウザー結果も同じ byte 列であることを確かめます。build event が返す per-stage timing と memoryBytes を全20回で確認します。

## 結果

全4ボードで5回ずつ、計20回のブラウザービルドを実施しました。期待値との `.fs` のバイト比較、IDCODE 検査は20回すべて成功し、各ボードの5ビルド後にfake USBでSRAMへ書き込めました。出力サイズは1Kが351,954 bytes、4Kが1,167,294 bytes、9Kが2,069,320 bytes、20Kが4,618,782 bytesです。

| ボード | 合成 中央値 (ms) | 配置配線 中央値 (ms) | ビットストリーム 中央値 (ms) | Yosys memoryBytes | nextpnr memoryBytes | gowin_pack memoryBytes |
|---|---:|---:|---:|---:|---:|---:|
| Tang Nano 1K | 1,558.8 [1,506.1–1,629.0] | 486.7 [420.8–518.0] | 318.0 [304.3–7,242.3] | 31,653,888 | 18,874,368 | 78,512,128 (5回目は94,240,768) |
| Tang Nano 4K | 1,554.5 [1,416.7–1,607.6] | 468.1 [417.6–494.9] | 572.3 [514.8–7,249.3] | 31,653,888 | 23,724,032 | 94,240,768 |
| Tang Nano 9K | 1,533.2 [1,439.5–1,584.3] | 613.6 [601.8–629.9] | 839.0 [779.5–7,808.5] | 31,653,888 | 26,542,080 | 113,115,136 |
| Tang Nano 20K | 1,563.3 [1,526.8–1,748.3] | 1,079.0 [974.4–1,089.0] | 1,423.0 [1,399.5–8,172.4] | 31,653,888 | 33,357,824 | 162,988,032 |

中央値はCSVに記録した5回の計測値から算出しました。各ボードの最初のビットストリーム段階はPyodideの初期化とpackage loadを含むため、7.2–8.2秒です。2回目以降は1Kが304–337 ms、4Kが515–574 ms、9Kが779–870 ms、20Kが1,399–1,423 msでした。`memoryBytes` はWASM memoryまたはPyodide heapのbyte lengthです。CSVの各行に実測値と出力サイズを記録しました。

選択ボードで必要なsynthesis assetの合計は、manifestのsizeを使うと1K 103,588,656 bytes、4K 107,859,398 bytes、9K 110,513,029 bytes、20K 115,160,215 bytesです。4 familyすべてのchipdbを含む `build/synth` は144,122,194 bytesでした。

計測時の主要入力のSHA-256は次のとおりです。WASMの値はmanifestと一致し、実行結果の同一性は各出力のsizeとSHA-256を検査するE2Eで確認しました。

| ファイル | SHA-256 |
|---|---|
| `build/synth/yosys.wasm` | `aa18e2c167d614e4194796041bf4cb533a659b0028668418ee109a6cd9cc58aa` |
| `build/synth/nextpnr-himbaechel-gowin.wasm` | `b011f1d2798dead2698d58037d40523885330b7c0c7df2cf9577f07dbcfc7e7f` |
| `build/synth/yosys-share.tar` | `531b97d2d9d99eb375177def6adaace730539ab33f529d09294840cb00bead5f` |
| `web/build-worker.js` | `b159b4aef12c1bb6b88e8b75032de67c37291f8d3017b63b621c2d98cb56a0d5` |
| `web/lib/wasi-p1.mjs` | `fae11efc92f76f59e1168a19cf2f3c4e238165112642248cb9ac7a481eaa6229` |
| `web/lib/build-runner.mjs` | `a61c419d02405c13a463a32df8d83b1555a90f78036f9768f7e07ca4765292bb` |
| `web/pack-worker.js` | `fef4c002f124e6216947213ca300931091a55be9514e6fed76098a96578c7470` |
| `web/lib/gowin-pack.mjs` | `f31e109b90a02d2a64b2b3dee7a0faa2844593a90955a590dda25a42b1ffe3c9` |

結果は VM / Chromium 上の値です。Tang Nano実機のビルド時間、メモリー量、書き込み性能を示すものではありません。生データは [CSV](S4A-browser-build.csv) を参照してください。

## 捨てた試行と経緯

初回のPlaywright実行では、project storeの拡張子許可リストに`.json`がなく、生成したJSON artifactを保存できませんでした。許可リストへ追加した後、保存と`.fs`の読戻しが成功しました。2回目以降の書込みボタンがdisabledのまま残る問題は、ビルド状態の通知でprogram formを再計算するように修正しました。

構文エラーの初回確認ではProblems panelが空でした。診断parserの結果にeditorの文書範囲がなかったため、editorが診断を空に正規化してpanelを上書きしていました。診断へ行範囲を付け、file / line metadataを保持するよう修正しました。chipdb欠落のテストはroute.abort()では一般的なfetch errorしか得られなかったため、HTTP 404を返してasset名とstatusを確認する方法に変更しました。cancelの初期テストはPlaywright routeの二重処理を起こしたため、workerの停止後にrouteを使わず再buildする形にしました。

## 結論

採否基準を満たしました。4ボード各5回の成果物はすべてnative基準ファイルとbyte-identicalで、IDCODEとSRAM fake USB書込みも成功しました。失敗した計測試行はありません。上記の失敗は計測前の実行・診断経路の修正であり、計測値としてCSVへ取り込んでいません。

## 未確認の点

実機 Tang Nano でのbuild、書き込み、性能はこの実験の対象外です。
