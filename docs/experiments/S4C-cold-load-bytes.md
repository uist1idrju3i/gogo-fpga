# S4C ブラウザーの初回配信量

- 状態: 完了
- 日付: 2026-10-28
- 担当: Devin
- 関連: [S4 初回配信量](../../RESEARCH.md)

## 目的と仮説

4 ボードそれぞれで、冷たいブラウザーキャッシュから初回のビルドと書き込みを行うとき、`dist/` のどのファイルが要求され、本文が何バイト転送されるかを確認します。選択したボードの chipdb 以外は、4 ボードでほぼ同じ配信量になると予想します。

## 採否の基準（結果を見る前に書く）

これは形式を選ぶ比較ではなく、配信物の実測です。実施前に定めた成功条件は、4 ボードすべてで要求本文を集計し、Worker の要求とボード別 chipdb の要求を確認することです。各ボードの Playwright テストは新しい browser context を使うため、各 1 回の冷たい初回計測で足ります。これは配信物の棚卸しであり、バイト数の採否基準は設けません。同じ条件の反復は行いません。

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | `c937a2dbf1ff3505bf6ecaa5b37e44f0fdadf9c2` からの作業ブランチ |
| ホスト | Linux 7.0.0-38-generic x86_64、12 CPU、30.2 GiB メモリー |
| Node.js / Chromium | Node.js 24.22.1、Chromium 156.0.8078.4 |
| 資材のバージョン | Pyodide 314.0.7、Python 3.14.2、zstd 1.5.7 |
| submodule | zstd `f8745da`、xz-embedded `62d5603`、Yosys `28ba3cb`、nextpnr `62e659e` |
| 出力先と状態 | `scripts/build-web.sh` で `dist/` を再生成 |
| 変える条件 | Tang Nano 1K、4K、9K、20K の4種類 |
| 変えない条件 | 同一の `dist/`、同一の Playwright テスト、初回ビルドと fake USB による書き込み |
| 繰り返し | ボードごとに新しい browser context で冷たい初回計測を1回。既存テストの後続4ビルドは集計しない |

## 手順

```sh
scripts/build-web.sh
PLAYWRIGHT_PORT=8123 npx playwright test
```

テストは同一 origin の成功した GET 応答本文を集計し、Worker のビルド・pack 資材、合成資材、書き込み資材を含む結果を `build/s4-first-load-<board>.json` に出力します。集計対象は各 browser context の初回ビルドと fake USB 書き込みで、ファイルパスごとの応答本文バイト数です。

## 計測器の検証

Playwright はビルド Worker、pack Worker、zstd 合成資材、pack WASM の要求を明示的に検査します。別の負の対照では圧縮 pack 資材を壊し、SHA-256 検証が失敗することと、不正な Cache Storage 項目を再取得することを確認しました。4 ボードともビルドと fake USB 書き込みが成功し、期待する `.fs` と byte 単位で一致しました。

## 結果

4 ボードとも 43 個の異なる要求パスがあり、成功した GET 応答本文の合計は 33,408,160〜33,661,797 bytes でした。内訳は synth 5 パス、pack 10 パス、その他 28 パスです。合計と分類別の値は同名 CSV に記録しました。

| ボード | 要求パス数 | synth (bytes) | pack (bytes) | その他 (bytes) | 合計 (bytes) |
|---|---:|---:|---:|---:|---:|
| Tang Nano 1K | 43 | 16,016,710 | 14,219,198 | 3,172,252 | 33,408,160 |
| Tang Nano 4K | 43 | 16,168,484 | 14,219,198 | 3,172,252 | 33,559,934 |
| Tang Nano 9K | 43 | 16,178,057 | 14,219,198 | 3,172,252 | 33,569,507 |
| Tang Nano 20K | 43 | 16,270,347 | 14,219,198 | 3,172,252 | 33,661,797 |

Playwright は Chromium 156.0.8078.4 で全 50 テストに成功しました。測定 JSON は再実行時に再生成される build 出力で、コミット対象には含めません。

## 捨てた試行と経緯

最初の全 E2E 実行では pack Worker の verified loader が自分の raw wheel 要求を再度捕捉し、初期化前に処理が停止。loader 作成時に元の `fetch` を捕捉した後、次の全実行で合成 Cache Storage の要求数に pack の zstd 要求も含まれること、および Pyodide が pack WASM の fetch エラーを内部で警告として扱うことが判明しました。そこで合成要求の集計を synth に限定し、Pyodide 初期化前に pack WASM を検証するよう修正。最終実行は 50 テストすべて成功です。失敗した試行の測定値は結果に採用していません。

## 結論

冷たい browser context からの初回ビルドと書き込みでは、ボードごとに 33.4〜33.7 MB の成功応答本文を取得しました。配信先は Cloudflare Pages を目標とし、ユーザーが実機で確認した後に公開します。USB 書き込みは Playwright の fake USB によるもので、Tang Nano 実機での計測ではありません。

## 未確認の点

Cloudflare Pages に配置したときの応答量と実機での動作は、この計測では確認していません。デプロイも行っていません。

## ログ

JSON の計測値は `build/` に生成します。E2E を再実行すると再生成できます。
