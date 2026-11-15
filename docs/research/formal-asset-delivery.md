# 形式検証の資材取得とSAT・Python配信監査

[調査一覧へ戻る](../../RESEARCH.md#7-分割した調査)

## 結論と適用範囲

[再監査で確認した200 HTML障害](session-review-formal-20261115.md)に対し、IDEの資材取得をengine別に分けました。Yosys SATはYosys本体とshareだけを取得し、Python/SBYの配信状態に依存しません。SBY/SMTBMCは両方を取得し、Pythonまたは選択solverの資材が不足すると実行前に `missing-assets` を返します。

G1とG2のSAT監査に加え、Python/SBYとYices2を通常buildへ接続しました。Pythonは固定ソースとpatchから44資材、合計807,139バイトを生成します。Yices2の製品WASMは1,970,004バイトで、原license・対応ソース・来歴を含めて監査します。VHDL、Verilog反例の独立再実行、停止・期限の製品経路は[43条件5回](../experiments/S15-formal-product-integration.md)で認定し、[実ブラウザーの4ボード画面](../experiments/S15-formal-browser-acceptance.md)も別に確認しました。既定solverは決定していません。実機のTang Nanoは本リポジトリでは試していません。

## 取得時の動作

`web/lib/formal-assets.mjs` の `loadForEngine(engine, options)` がIDEの入口です。従来の `loadAll()`、`loadYosys()`、`loadPython()` は診断用にも残します。

| 条件 | 動作 |
|---|---|
| `yosys-sat` | Pythonのmanifestも資材も要求しない |
| `smtbmc` | YosysとPython/SBY、`options.solver` で選んだsolverを取得。solverの未配布を実行前に判定 |
| 404、200 HTML、JSON解析失敗、hash不一致、途中切断 | 該当bundleを利用不可とし、成功した別bundleは保持 |
| 同じloaderで再試行 | 失敗した取得をやり直す。検証済みの成功結果だけを再利用 |
| `options.signal` の取消 | fetchへ伝播し、取得待ちも `AbortError` で終了 |
| `options.timeoutMs` の超過 | fetchを取り消し、`TimeoutError` で終了。既定60秒 |
| signalに応じない取得処理 | 待機を終了し、遅れて完了しても成功cacheへ追加しない |

資材取得の期限とrunnerの実行期限は別です。画面の実行時間設定は従来どおりrunnerに適用し、開始から終了までの総時間の上限とはしません。取得中の停止とproject・library変更では取得を取り消し、古い結果が新しい画面状態を上書きしないようにします。

Python manifestにはJSONのContent-Type、UTF-8、256 KiB以下、資材1から256件、重複しない安全なpath、正の整数size、SHA-256を要求します。合計sizeはloaderで64 MiB以下、生成時とworkerで32 MiB以下とし、各bodyが宣言sizeを超えた段階で読み取りを終了します。名前をURLへ変換するときはpathの各要素をencodeします。Yosysは従来の圧縮size/hash、展開後size/hashとCache Storageの検証を維持します。

SMTBMC用のsolver名と、実行するコマンド名は異なる場合があります。Yices2では `yices` と `yices-smt2` を区別し、runnerはprocess側と同じコマンド名で資材を検査します。IDEは選択したsolver IDをloaderへ渡します。loaderは `formal/solvers/manifest.json` と `<solver-id>.wasm` を既存の圧縮・hash検査で取得し、コマンド名で登録します。失敗・未認定のsolverは登録せず、取消後に遅れて完了しても成功cacheへ追加しません。Yices2を製品配布へ追加しました。不正なWASMはPython起動前に拒否し、Python、solver、Yosysそれぞれのworker factoryをSBYと反例処理へ渡します。

## Python/SBYと圧縮runtimeの接続

`scripts/build-web.sh` は `scripts/build-formal-python.py` を呼び、固定したYosys、SBY、Clickのソースと原license、process patch、adapterを `formal/python/` へ配置します。manifestにはsource pin、patch hash、原ファイルの出所とhash、配信する各ファイルのsize/hashを保持します。通常buildのCIでもSBYとClickを固定commitから取得します。

Playwrightのserver起動でもWebを再生成するため、各shardとRelease testsでYosys・SBY・ClickとYosys内の依存ソースを取得します。原licenseが欠けている場合は、ブラウザーの起動前に配信監査で停止します。

Releaseのソース書庫には `vendor/formal-python-sources.json` として来歴を同梱します。Gitがないときは、そのpinと元ソースのhashを照合してからpatchを適用し、同じbundleを再生成します。ソースの改変・欠損・リンクや来歴の欠落は拒否します。Release closureでも同梱した来歴と配信manifestのbyte一致を検査します。

Python workerには `web/lib/formal-pyodide.mjs` を接続しました。従来の直接起動では、通常配信でzstdにしたPyodide WASMの未圧縮URLを要求していました。修正後はpack manifestを読み、検証済みのlockを渡し、WASMと標準ライブラリーを取得するときに既存のhash検査とブラウザー用展開器を通します。runtimeの準備に失敗した場合は再試行でき、workerの準備例外もhostへ通知します。

## 生成物をHTTPで検査する

`scripts/formal-distribution.py` は `stage-licenses` と `audit` を持ち、通常の `scripts/build-web.sh` から両方を呼びます。`audit` は生成した `public_html/serve.py` のhandlerを読み、loopbackの空きportで実際に配信します。検査後はserverを閉じます。

handlerは `runpy.run_path()` で読み込み、配布先へPythonのbytecode cacheを作りません。監査前後で全ファイルの一覧とSHA-256を比較し、監査が配布物を変更しないことも検査します。E2Eの配布照合では、Python/SBYのmanifest・全資材と原licenseを固定ソースから別に再生成し、配布物とのbyte一致を要求します。

検査対象は以下です。

- SAT manifestのHTTP 200、JSONのContent-Typeと構造、COOP/COEP。
- `yosys.wasm` と `yosys-share.tar` の参照、HTTP取得、配信size/hash、Pagesの25 MiB未満という制限。
- zstdの場合は、固定版CLIによる展開と展開後size/hash。WASMのmagic/version。
- Yosys、ABC、cxxopts、fmt、toml++、SymFPU、Boost、zstd、SBY、Clickの原license計11ファイルとHTTP本文のbyte一致。WASI runtimeのlicenseは従来の同梱経路を維持。
- Python manifestのJSON Content-Type、固定git objectと現行patchから再生成したmanifestとの一致、全44ファイルのHTTP本文のsize/hash。pinやpatch、原licenseの欠落・改変も拒否。

通常buildでは不足していたYosys側の原licenseを追加し、Releaseにも `public_html/` 経由で含めます。SymFPUは上流の選択肢のうちBSD-3-Clauseを採り、選択を示す原文とBSD本文を両方保持します。固定submoduleと原文の対応は [第三者表記](../../THIRD_PARTY_NOTICES.md)から追えます。

出力JSONはPythonのpin・patch・資材の照合結果に加え、検証済みの独立したsolverビルドとのmanifest・WASM・build metadataのbyte一致を保存します。Yices2とGMPの原licenseを加えて計16件を照合し、共通HTTP取得でCORPも要求します。ブラウザー実行は `not-audited` です。この監査の成功はSATの実行結果や、全ツールのlicense/source closureの認定ではありません。全配布物の照合には従来の `scripts/audit-release-closure.py` を併用します。

## Yices2の製品配信と再生成

`scripts/build-formal-solvers.py` は、pin、GMP archive、SDK archive、patch、script、
原license、source inventoryを照合してからWASIを生成します。異なる入力の古いcacheは退避し、
同じ入力のcacheに改変があれば拒否します。検証前の部分出力は配信しません。
Webにはmanifest、WASM、正規化したコマンドとcompilerを含むbuild metadataだけを配置します。
原licenseとGMP原archive、Yices2の完全な固定ソース、patchと手順はsource Releaseへ収録します。
Gitがないソースは `.gitcommit` と `vendor/formal-yices2-source.json` で照合し、
変更・不足・追加・異なるリンクを拒否します。Release closureとE2E preflightもこれらを検査します。

HTTPで配信した製品資材を使い、`createFormalRunner()`経由のVerilog 6条件が各5回成功しました。
SQLite、反例VCD、実Yosys・SMTBMC・Yices2の子プロセスを確認しています。
別出力先とGit-free sourceから同じWASMを再生成しました。
[S15の生CSVと失敗試行](../experiments/S15-yices2-product.md)に条件と未確認範囲を記します。
以下は前段の14条件を認定した時点の履歴であり、後続の30回とは分けて保持します。

## 回帰試験と再実行

後続の製品接続では、VHDLを選択したときだけGHDLのWASMとlibrary archiveをhash照合して取得し、
GHDLの形式出力をSATとSBYへ渡します。SMTBMCの起動前にもYosysでpropertyとclockを検査し、
空のassert/cover、未対応state、複数clockを成功にしません。
VerilogのSAT・SMT反例は製品Icarusで原文を再実行し、独立VCDと違反propertyを照合します。
VHDL原文の独立再実行は利用不可と表示します。
編集時は実行と取得を停止し、古い結果・波形を破棄します。プロジェクト切替も世代番号で古い結果を拒否します。
[統合実験](../experiments/S15-formal-product-integration.md)に予備失敗、正式反復の基準と証拠を記録します。
以下は初期の14条件の時点で得た結果です。

```sh
node --test tests/web/formal-*.test.mjs tests/web/verified-assets.test.mjs
python3 -m unittest discover -s tests/check-formal-distribution -v
scripts/build-web.sh
python3 scripts/formal-distribution.py audit public_html
node --test --test-concurrency=1 tests/product/formal.test.mjs
```

最初の2コマンドは2026-11-15に実行し、関連単体試験149件と配信・書庫再生成の11件が成功しました。HTTP監査器では、fixtureの実HTTP配信と固定版zstdを使い、200 HTML、不正JSON、404、欠損・改変・途中までのbody、重複・不正metadata、誤ったContent-Type、COEP欠落、license改変、圧縮前後それぞれのhash不一致を拒否しました。Pythonではpinとソースの改変、原licenseの欠落も検査します。runtimeの3単体試験は、実際のブラウザー用zstd展開器を使います。HTTP監査用のfixtureはYosysの実行を検査するbinaryではありません。

別に `tests/product/formal.test.mjs` を追加しました。HTTPから圧縮SAT資材を取得し、製品loader、runner、実WASI workerを通して12条件を検査します。BMC、prove、反例、深さの境界、矛盾したassume、性質なし、不正なclock/edge、未対応構文を含みます。さらにHTTPから取得したPythonソースで原本SBYの `--setup` をPyodide上で実行します。ログを含むworkspace差分、結果、入力、snapshot、binary hash、commitと作業差分の有無を保存します。Gitがない書庫では `RELEASE-SOURCE.json` のcommitとmetadata hashを記録します。資材生成前のsynth試験からは分離し、通常CI・Release・書庫再ビルドのWeb build後に明示して実行します。

ローカルでは、[CI run 43700337952](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43700337952)のSAT資材と、現行のPython bundle・展開器を合わせた `FORMAL_WEB_ROOT=build/formal-product-web` で、この検査14件が成功しました。Yosys WASMのSHA-256は `11ee003141aa7c05b8413f77f44e7a1e54c124a66bb338ff38fd47028387b5c3` です。この検査はNode worker_threads上の回帰試験で、ブラウザー操作、solverの実行、SQLiteを含むSBY全実行、VHDL、反例の独立再実行の認定ではありません。製品の生成物はCIの通常buildで別途監査・実行します。

全Web単体試験は初回のローカル実行で、未生成のflasher資材と製品 `public_html/` により5件失敗しました。[CI run 43704401597](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43704401597)では、通常Web build、SAT・Python配信監査、製品回帰14件とWeb単体試験440件が成功しました。[製品試験の原記録](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43704401597/artifacts/14158384493)には、検査したmerge commit `e17c88c64429a43d885c8b18ae123a85350641ba` と同じYosys WASMのhashを保存しています。別jobのE2E shardでは、Yosysの原licenseを取得しておらずWeb再生成が停止しました。上記のソース取得を追加し、清浄な取得先で原license11件の配置とPythonの44資材・manifestのbyte一致を確認しました。

[続くCI run 43707742243](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43707742243)では、取得コマンドの全文を固定していた2件のライブラリー試験が失敗しました。改行と引数の追加を許容し、必要なソース取得と実行順序を引き続き検査するよう修正しました。修正後のローカル試験と、必要な取得先を除いた負の対照も確認しました。

[CI run 43710045365](https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43710045365)ではBuildが成功しましたが、E2E shard 2は監査が作成した `public_html/__pycache__/serve.cpython-314.pyc` を不要な配布物として拒否しました。監査でbytecodeを生成しない方式へ変更し、上記の配布照合も追加しました。ローカルでは関連単体試験150件と配信・書庫再生成11件が成功し、manifest・Pythonソース・原licenseの改変と欠損も拒否しました。画面操作は検査していません。

上記は配信監査を実装した時点の記録です。その後、全実装と自動回帰の完了後に4ボードの画面確認を実施し、[ブラウザー受入れ記録](../experiments/S15-formal-browser-acceptance.md)へ原証拠と失敗試行を保存しました。再監査時点の証拠書庫は変更せず、当時の障害記録と今回の実装を区別します。
