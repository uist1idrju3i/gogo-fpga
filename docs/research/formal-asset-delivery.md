# 形式検証の資材取得とSAT配信監査

[調査一覧へ戻る](../../RESEARCH.md#7-分割した調査)

## 結論と適用範囲

[再監査で確認した200 HTML障害](session-review-formal-20261115.md)に対し、IDEの資材取得をengine別に分けました。Yosys SATはYosys本体とshareだけを取得し、Python/SBYの配信状態に依存しません。SBY/SMTBMCは両方を取得し、Pythonまたは選択solverの資材が不足すると実行前に `missing-assets` を返します。

この変更はG1と、G2のうちSAT配信の監査に対応します。Python/SBYとsolverの通常buildへの接続、製品binaryの認定、VHDL、反例の独立再実行の画面統合は残件です。既定solverは決定していません。実機のTang Nanoは本リポジトリでは試していません。

## 取得時の動作

`web/lib/formal-assets.mjs` の `loadForEngine(engine, options)` がIDEの入口です。従来の `loadAll()`、`loadYosys()`、`loadPython()` は診断用にも残します。

| 条件 | 動作 |
|---|---|
| `yosys-sat` | Pythonのmanifestも資材も要求しない |
| `smtbmc` | YosysとPython/SBYを取得。solverの未配布を実行前に判定 |
| 404、200 HTML、JSON解析失敗、hash不一致、途中切断 | 該当bundleを利用不可とし、成功した別bundleは保持 |
| 同じloaderで再試行 | 失敗した取得をやり直す。検証済みの成功結果だけを再利用 |
| `options.signal` の取消 | fetchへ伝播し、取得待ちも `AbortError` で終了 |
| `options.timeoutMs` の超過 | fetchを取り消し、`TimeoutError` で終了。既定60秒 |
| signalに応じない取得処理 | 待機を終了し、遅れて完了しても成功cacheへ追加しない |

資材取得の期限とrunnerの実行期限は別です。画面の実行時間設定は従来どおりrunnerに適用し、開始から終了までの総時間の上限とはしません。取得中の停止とproject・library変更では取得を取り消し、古い結果が新しい画面状態を上書きしないようにします。

Python manifestにはJSONのContent-Type、UTF-8、256 KiB以下、資材1から256件、重複しない安全なpath、正の整数size、SHA-256を要求します。合計sizeは64 MiB以下とし、各bodyが宣言sizeを超えた段階で読み取りを終了します。名前をURLへ変換するときはpathの各要素をencodeします。Yosysは従来の圧縮size/hash、展開後size/hashとCache Storageの検証を維持します。

## 生成物をHTTPで検査する

`scripts/formal-distribution.py` は `stage-licenses` と `audit` を持ち、通常の `scripts/build-web.sh` から両方を呼びます。`audit` は生成した `public_html/serve.py` のhandlerを読み、loopbackの空きportで実際に配信します。検査後はserverを閉じます。

検査対象は以下です。

- SAT manifestのHTTP 200、JSONのContent-Typeと構造、COOP/COEP。
- `yosys.wasm` と `yosys-share.tar` の参照、HTTP取得、配信size/hash、Pagesの25 MiB未満という制限。
- zstdの場合は、固定版CLIによる展開と展開後size/hash。WASMのmagic/version。
- Yosys、ABC、cxxopts、fmt、toml++、SymFPU、Boost、zstdの原license計9ファイルとHTTP本文のbyte一致。WASI runtimeのlicenseは従来の同梱経路を維持。

通常buildでは不足していたYosys側の原licenseを追加し、Releaseにも `public_html/` 経由で含めます。SymFPUは上流の選択肢のうちBSD-3-Clauseを採り、選択を示す原文とBSD本文を両方保持します。固定submoduleと原文の対応は [第三者表記](../../THIRD_PARTY_NOTICES.md)から追えます。

出力JSONは、Python/solverとブラウザー実行を `not-audited` と明記します。この監査の成功はSATの実行結果や、全ツールのlicense/source closureの認定ではありません。全配布物の照合には従来の `scripts/audit-release-closure.py` を併用します。

## 回帰試験と再実行

```sh
node --test tests/web/formal-*.test.mjs tests/web/verified-assets.test.mjs
python3 -m unittest discover -s tests/check-formal-distribution -v
scripts/build-web.sh
python3 scripts/formal-distribution.py audit public_html
```

最初の2コマンドは2026-11-15に実行し、関連単体試験142件とHTTP監査器の7件が成功しました。HTTP監査器では、fixtureの実HTTP配信と固定版zstdを使い、200 HTML、不正JSON、404、欠損・改変・途中までのbody、重複・不正metadata、誤ったContent-Type、COEP欠落、license改変、圧縮前後それぞれのhash不一致を拒否しました。fixtureはYosysの実行を検査するbinaryではありません。製品の生成物はCIの通常buildで別途この監査を受けます。

全Web単体試験も試しましたが、ローカルでflasher資材と製品 `public_html/` を生成していなかったため、5件が失敗しました。資材を要する検査の最終判定は、生成後のCIで行います。4ボードのブラウザー操作と画面の目視は、この時点では実施していません。再監査時点の証拠書庫は変更せず、当時の障害記録と今回の実装を区別します。
