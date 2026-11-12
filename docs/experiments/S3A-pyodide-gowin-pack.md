# S3A Pyodide gowin_pack のビットストリーム比較

- 状態: 完了
- 日付: 2026-09-15
- 担当: Devin
- 関連: `RESEARCH.md` の S3 節

## 目的と仮説

Pyodide 314.0.7 上の Apicula 0.35 `gowin_pack` が、native 版と同じ routed JSON から全 4 ボードの `.fs` を生成できるか確かめます。NumPy と msgspec の版が native 環境と異なりますが、出力はバイト単位で一致すると予想します。

## 採否の基準（結果を見る前に書く）

- 4 ボードそれぞれについて、native の出力と Pyodide の 5 回すべての出力がバイト単位で一致し、IDCODE が対象ボードに一致すること。
- 壊れた JSON、別デバイス指定、wheel の SHA-256 不一致、欠落 wheel の 4 負例をすべて検出すること。
- 1 件でも出力差または未検出の負例があれば採用せず、差分を報告すること。処理時間は記述統計として記録し、採否の閾値にはしません。

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | S2 の `9cda49c3ed6c301214e805a21586d797142d049a` |
| ホスト | Linux 7.0.0-38-generic、12 CPU、31,707,676 KiB メモリー |
| Node.js | v24.22.1 |
| Pyodide / Python | 314.0.7 / 3.14.2 |
| Pyodide packages | micropip 0.11.1、NumPy 2.4.6、msgspec 0.20.0 |
| Apycula | 0.35 |
| submodule | Yosys `28ba3cb926fe376fa05ebfc1b921747d011d4557`、nextpnr `62e659ed6748e9f60b2a4aa25dd4fe79a9605881` |
| 出力先と状態 | `build/pack/`。S1/S2 の Yosys、nextpnr、chipdb 成果物を再利用し、既存の Boost ステージは使用しません。 |
| 変える条件 | `gowin_pack` の実行環境（native / Pyodide） |
| 変えない条件 | 同じ WASI nextpnr の routed JSON、device、Apicula wheel、4 ボード |
| 繰り返し | 各ボード 5 回。Pyodide は 1 回だけロードし、各出力を native の出力と比較します。中央値・最小・最大を記録します。 |

## 手順

```sh
scripts/build-pack-assets.sh
node --test tests/synth/*.test.mjs
```

## 計測器の検証

同一ボードの 5 回実行を A/A 試行として扱い、各回の `.fs` を native 出力と比較します。さらに、壊れた入力、異なる device、改変 wheel、欠落 wheel を負の対照として使います。Pyodide のロード時間とボードごとの実行時間、`.fs` と配布 asset のサイズを測ります。メモリー使用量は測定しません。

## 結果

テスト出力で Pyodide runtime setup に 4,627.9 ms、pack assets 合計に 21,021,184 bytes を記録しました。全4ボードで native `.fs` と Pyodide `.fs` が5回とも一致し、IDCODE も一致しました。`lzma` import と fastcrc fallback 警告の保持も確認しました。ボードごとの生データは同名の CSV を参照してください。

Tang Nano 1K の最初の pack は Apicula の初回 import を含み 2,233.0 ms でした。残る4回は 236.1〜252.5 ms で、5回の中央値は 243.7 ms です。

## 捨てた試行と経緯

初回は Pyodide Node loader に file URL を渡して失敗しました。Node.js ではローカルパス、micropip にはホスト側の file URL を渡す形に修正しました。次の実行では micropip が仮想 FS 上の wheel を読めず、ホスト側の local wheel URL から install する形に変更しました。出力比較ができた後、Pyodide FS の未作成ファイルを示す `ErrnoError`（errno 44）を runner が許容するように修正し、全負例を含むテストを通しました。これらは実行連携の修正で、`.fs` の差を正規化する変更はありません。

## 結論

全4ボードで native と Pyodide の `.fs` がバイト単位で一致し、4種類の負例も検出しました。Pyodide は一度だけロードし、各ボードを5回 pack しました。以下の測定値は Node.js 上の Pyodide と native 参照の値であり、ブラウザーや実機の値ではありません。

## 未確認の点

ブラウザー Worker での実行と実機 Tang Nano での書き込みは、この段階では確認しません。

## ログ

テストログは実行環境のコマンド出力に記録しました。再生成コマンドは上記のとおりです。
