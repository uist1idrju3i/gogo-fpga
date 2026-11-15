# 形式検証の公開障害と製品化境界の再監査

2026-11-15時点の実装担当者向け記録です。前回計画の主張を、コード、既存実験、今回のHTTPとloader診断で再評価します。実装変更は行っていません。

[再監査の入口](session-review-20261115.md) / [証拠台帳](session-review-evidence-20261115.md) / [RESEARCH](../../RESEARCH.md#7-分割した調査)

## 1. 公開版で起きていること

元レビューの `15b-formal-run.png` と `15c-formal-reason.png` は、形式検証のエラーログに `Unexpected token '<'` を表示しています。今回のHTTP取得は2026-11-15 08:15:51 UTCです。

| URL | HTTP | Content-Type | byte数 | 内容 |
|---|---|---|---|---|
| `https://fpga.moe/` | 200 | text/html; charset=utf-8 | 31,297 | アプリのHTML |
| `https://fpga.moe/formal/python/manifest.json` | 200 | text/html; charset=utf-8 | 31,297 | トップページと同一hash |
| `https://fpga.moe/synth/manifest.json` | 200 | application/json | 2,854 | 合成資材のmanifest |
| `https://fpga.moe/publication-info.json` | 200 | application/json | 196 | 公開元 `fdd38db` |
| `https://fpga.moe/build-info.json` | 200 | application/json | 1,137 | ビルド情報 |

トップとPython manifest応答のSHA-256は、ともに `3d3e41e8669eef078ec53ce7606cb5d194b48d4e0493f14b7bdbd7a5c3cc44c3` です。単なる404とは異なり、HTTP成功扱いのHTML代替応答です。HTTP再取得は読取りのみで、今回ブラウザーUIを再操作した結果ではありません。

## 2. 失敗の伝播

基準コードは `e3c6e769aa2dfed1900546211ad852b601d78f85` です。

```text
web/ide.mjs: startFormal
  → formalAssetLoader.loadAll()
      → Promise.all([loadYosysCached(), loadPython()])
          → loadPythonBundle()
              → fetch formal/python/manifest.json
              → HTTP 200なので続行
              → response.json() でSyntaxError
      → 全体がreject
  → catchで「形式検証に失敗しました」
  × formalRunner.run() には到達しない
```

`web/lib/formal-assets.mjs` はfetchそのものの例外と非成功HTTPを `null` にしますが、JSON解析の例外は捕捉しません。Yosysの取得には `.catch(() => null)` があります。Pythonの失敗Promiseは `pythonPromise ??=` に保持され、同じloaderで再試行しても再fetchしません。取得時の取消・期限もloaderには見当たりません。

`web/lib/formal-tool-process.mjs` は `command.runtime === "python"` のときだけPython processを起動し、それ以外はYosys WASI workerを起動します。SAT実行そのものがPythonを必要とするわけではありません。問題は、IDEの共通事前ロードでPython失敗に巻き込まれる点です。

## 3. 今回の最小診断と、その限界

証拠書庫の `audit/diagnose-assets.mjs` は、現行loaderへsyntheticなYosys資材と標準Responseを与える診断です。404と200 HTMLを切り替え、同じloaderに2回ずつ `loadAll()` を呼びます。これは性能比較やsolver試験ではありません。

| Python manifest応答 | 1回目 | 2回目 | fetch回数 |
|---|---|---|---|
| 404、HTML | yosysあり、sources空、manifest null、solvers空でresolve | 同じ | 1 |
| 200、HTML | SyntaxErrorでreject | 同じ例外でreject | 1 |

これにより、公開側の200 HTMLがSATの開始にも波及する構造と、失敗Promiseの再利用を確認できました。実際のYosys binary、SBY、solverを動かしたわけではありません。「catchを加えればSATが使える」と復旧を断言する根拠にはしません。

既存の `tests/web/formal-assets.test.mjs` は、manifest不在、正常manifest、hash不一致、unsafe path、Yosys資材とPython不在を検査します。200 HTML専用の回帰試験はありません。mockの `json()` は値を返すだけなので、実際のJSON解析エラーを自然には発生させません。

`web/serve.py` は標準の `SimpleHTTPRequestHandler` を使い、PagesのSPA代替応答を実装していません。`tests/e2e/openrouter-auth.spec.mjs` には実SATの成功・反例ケースが既にありますが、同じファイルに200 HTMLを注入するケースはありません。ローカル404と公開200 HTMLの差が、既存SAT試験だけでは検出できない理由の候補です。今回そのE2E自体を実行したわけではありません。

## 4. 配信生成はどこまでつながっているか

| 要素 | 現状 | 完了と見なせない理由 |
|---|---|---|
| `scripts/build-web.sh` | webをコピーし、合成、Surfer、Icarus、pack、license資材を追加 | `formal/python/` の生成接続がない |
| `scripts/build-formal-python.py` | Python/SBY、SQLite、stdlib等をmanifest化できる | 通常のWeb配信buildに未接続。solver/Pyodide本体全体を生成するものではない |
| `loadYosys()` | synthのhash検証済み資材を再利用 | 実公開binaryと結果の結び付けは別の検査 |
| `loadPythonBundle()` | 安全なpath、件数、サイズ、hashを検査 | JSON例外、部分取得、取得中停止、再試行の診断が不足 |
| `loadAll()` | yosys、sources、manifestを束ねる | solverは常に空のobject |
| `formal-python-process.mjs` | Python workerと子processの制御 | 配信物を作る機能ではない |
| `formal-runner.mjs` | SAT/SBYを起動し結果を分類 | 必要資材や入力がなければ実行できない |

配布計画は、binaryの生成、圧縮、manifest、hash、展開、worker起動、license/source closure、Release/Pagesへの収録を分けて扱う必要があります。Python bundleの生成だけを完了条件にするとsolver不在を残します。

## 5. 実装済みの機能と残る接続

| 主題 | コードにあるもの | 製品化の残件・制限 |
|---|---|---|
| Yosys SAT | property inventory、bmc/prove、反例、停止、timeout | 共通loaderを通れること、実配信binary、再実行までの統合 |
| SBY/SMTBMC | `.sby` 生成、bmc/prove/cover、status解析、Python/子worker | Pythonとsolverの配布、全経路の実資材認定 |
| cover | runner、mode選択、status変換、単体試験 | 新規実装の空白ではなく、実製品資材での完走が未確認 |
| VHDL | GHDLの合成と既存S15実験 | 製品形式検証はVerilogファイルを要求する。実験のVHDL成功を転用できない |
| `.sby` | schemaにパスを保存できる | user指定の `.sby` はrunnerでunsupported-input |
| ソース | Verilogとheaderを選択 | libraries配下を除外。同名basenameはSBYで拒否 |
| 資源制限 | timeout、worker、出力・輸送の上限 | `memoryMiB` はschema検査と保存があるが、実行制限への接続を確認できない |
| 停止 | runner実行中の停止とtimeout | loader待機はrunner起動前。取得中の停止・期限は別の試験が必要 |
| 画面 | 開始・停止、結果、VCD、旧結果の無効化 | 失敗理由の粒度、資材の利用可能性、再試行の設計 |

blinkテンプレートには形式検証propertyがありません。資材障害を除いても、検証に意味がある入力を別に用意しなければ成功を期待できません。propertyなしや矛盾したassumptionを安全性の証明として扱わないことが受入れ条件です。

SMT runnerは `input.assets.solvers` の存在を検査しますが、空objectも真値です。選択solverのbinaryが実在し検証済みかまで、入口の判定だけでは保証できません。`web/ide.mjs` のsolver選択肢は `probe-verified` を有効化条件にし、`formalCapabilities()` の配布資材との照合を使っていません。この状態では選択可能という表示が製品の実行可能性を過大に示します。

## 6. Z3推奨の訂正と、solver別の根拠

旧計画はZ3を既定にすることを推奨しました。しかし、[S15のVHDL反例](../experiments/S15-smt-vhdl-replay.md)は、固定版Z3が `print_failed_asserts` のSMTIO解析でクラッシュし、13件すべてでcounterexampleを生成できなかったため、その経路の候補から除外したと記録しています。MITライセンスや圧縮サイズだけでこの反証を上書きできません。

[native/WASI比較](../experiments/S15-solver-native-wasi.md)は各5回、A/A 2回、329行31列、294負の対照を記録しています。これは当時の実験条件での比較であり、公開画面、製品用loader、VHDL反例経路すべての合格ではありません。

同記録のZ3 WASIは31,458,902 byte、zstd後5,246,594 byteです。hostでの展開後hash一致は確認されていますが、ブラウザーdecoderと製品manifestへの接続は未完了と明記されています。圧縮後25 MiB未満という一点から配信完成とは判断しません。

`web/lib/formal-capabilities.mjs` ではYices2/Z3がprobe-verified、Bitwuzla/Boolectorがproduct-unqualifiedです。後者にも追加のbuild、SMTBMC、SBY、独立監査の実験記録があります。catalogの状態と実験の進展の不一致は、経路ごとの認定表で整理すべきです。「追加候補を調べていない」とは書けません。

採否は、solver版・binary hash・engine・mode・言語・反例・再実行・ブラウザー・licenseを列にして決めます。Yices2のGPLとGMP等の依存条件、Z3の失敗、追加候補の認定を独立に評価し、既定は結果がそろうまで保留するのが妥当です。

## 7. 文書と履歴の読み方

SAT runner、SMT runner、UIに関する履歴は次のcommitで確認できます。旧PR番号を現リポジトリへ当てはめると404になるため、commitを原典にします。

- [43c90e0: SAT実行・worker・反例](https://github.com/uist1idrju3i/gogo-fpga/commit/43c90e0875c661f080e89fae13771efd3132b095)
- [e82154e: SBY/SMTBMC・SMT再実行](https://github.com/uist1idrju3i/gogo-fpga/commit/e82154e550308be5927cd28e077ea4977a62f559)
- [147d8d6: UIとSurfer接続](https://github.com/uist1idrju3i/gogo-fpga/commit/147d8d6df668de43dd0c5f5db71690758753d18c)

[形式検証調査](formal-verification.md)、[solver調査](formal-solvers.md)、[capability調査](formal-capabilities.md)、[S15の索引](../experiments/README.md)には、実験当時の未完了記述が残ります。その記録は保持し、現在の製品状態への注記を付けるのが適切です。過去の試験の成功、後続実装、公開配布を一つの状態に統合すると、今回のような漏れを見逃します。

## 8. 次の変更で必要な確認

P0は、SATの必要資材を分離し、404、200 HTML、不正JSON、破損hash、取得失敗、再試行、取消・期限を検査することです。P1は、Python/SBY/solverの配信closureと、製品binaryによるBMC/prove/cover、Verilog/VHDL、反例再実行の認定です。各経路が使えない間は理由を表示し、資材不在を安全性の成功へ変換しません。

今回の関連単体試験は `node --test tests/web/formal-*.test.mjs` の120件が成功しました。これは既存の部品試験が通ることを示します。公開manifestへのHTML応答、実solverの製品配信、実機確認まで合格した結果ではありません。
