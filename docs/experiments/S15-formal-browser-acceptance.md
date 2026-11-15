# S15 形式検証のブラウザー受入れ確認

## 目的と採否基準

[製品runnerの43条件5回反復](S15-formal-product-integration.md)で扱わない、
対象一覧、設定の保存、画面表示、実ブラウザーworkerの終了と復旧を確認する。
全実装と自動回帰の完了後に開始し、次の条件を採否基準とした。

- VHDL形式対象と混在プロジェクトのシミュレーション対象を、画面から保存・再読込できる。
- Tang Nano 1K・4K・9K・20Kの各画面で、新しいSAT実行の開始と成功を確認できる。
- 明示選択したYices2でBMC・prove・coverが動き、Verilog反例をIcarusで独立再実行できる。
- VHDLをGHDLで下位化してSATとYices2へ渡し、原文再実行の利用不可を理由付きで表示する。
- 停止・期限・編集・プロジェクト切替後に古い結果と波形を除去し、再実行できる。
- 改変したキャッシュを拒否して再取得できる。4ボードの全画面画像と主経路の録画を保存する。

## 実施条件

対象commitは `1ab86d26ba68a54c983e5f2c1b77a4aee4372f46`。
開始時の作業ツリーは清浄で、Web組立てによる案内placeholderの変更だけを実施した。
製品実装は、215判定の再認定を行った `d2a16d8` と同じである。
その後の変更は実験記録と、再読込後に元プロジェクトを選び直すE2Eの訂正である。

Linux上のheaded Chromium `156.0.8078.4` を使用した。
`scripts/build-web.sh` で現commitから組み立て、`public_html/serve.py` で配信した。
build-info、manifest、HTTP配信のhash、COOP/COEPを検査してから操作した。
HTTPで取得した `ide.mjs` と `web/ide.mjs` のSHA-256はともに
`d39b4e5bd71c7d98b0103f01ebcd7489e0a7f1937f8fe50d73f229e183cc9a9b` だった。
配信したsolver manifestのSHA-256は
`281452a51a55d6fd30acc25348c4651d2741eec6ec8a577b4b057ca77c8072bb`。

操作はPlaywrightによる実画面のクリック・入力と目視で行った。
キャッシュ破損・削除だけは実Cache Storageをscriptで変更し、復旧を通常UIから確認した。
worker生成・終了とDOM状態遷移の観測にもscriptを併用した。
Node worker_threads、native参照、実機の結果はブラウザーの成功数に含めない。
これは画面の受入れ確認であり、5回反復の性能比較ではない。

## 結果

| 対象 | 判定と確認内容 |
|---|---|
| 対象選択のE2E | 2/2成功。VHDL形式対象の解除・保存・再読込と、混在projectのVHDL除外・checkbox保存・再編集・実シミュレーション |
| 4ボード | 4/4。1K・4K・9K・20Kごとに新runのSAT成功と画面を目視し、全画面画像を保存 |
| Verilog SAT | 安全と反例を確認。Icarus独立再実行は「確認済み」、独立VCD波形も表示 |
| Yices2 | solverを明示選択してBMCの反例・独立再実行、prove成功、cover到達を確認 |
| VHDL | `TOP`・`ToP` と `CLK` でGHDLからSAT／Yices2へ接続。原文再実行は理由付きの「利用不可」 |
| 停止と期限 | SAT、再帰solver、Icarus再実行の実行中に停止・期限到達を確認。対象workerの終了後に再実行成功 |
| 編集と切替 | 完了後・実行中の編集で結果と波形を破棄。実行中のproject switchでworkerを終了し、新projectで再実行成功 |
| 再読込 | 元projectを画面で選び直すとtop・clock設定を保持。古い結果は残さず再実行成功 |
| キャッシュ | 改変データのhash不一致を検出し再取得。キャッシュ全体の削除後も再実行成功 |

[生CSV](S15-formal-browser-acceptance.csv)は、原JSONの31観測を転記したものである。
`outcome=failed` には、期待した反例・停止・期限到達も含む。試験自体の失敗数ではない。
時間は画面操作から観測した単発値で、solver単体の速度や厳密な応答期限を示さない。
特にIcarus再実行の期限は3秒設定に対して、クリックから全worker終了の確認まで7,259 msだった。
資材準備と終了監視を含み、3秒以内の応答を認定した結果ではない。

Surferのthread pool警告とfaviconの404を観察した。独立VCD波形の表示は確認できた。
これらを理由に判定条件を緩めてはいない。実機Tang Nanoは本リポジトリでは試していない。

## 失敗・中止した試行と訂正

失敗試行は[失敗・予備記録](S15-formal-product-integration-failures.csv)と証拠書庫へ保持した。
製品の不具合と、一時試験器の不具合を区別している。

1. 旧E2Eは再読込後の `blink` を検査して2件とも失敗した。元projectを選び直す追跡済み試験の修正後は2/2成功した。
2. ボード連続試験が前runの成功を再利用し、4K完了前に9Kへ進んだ。DOMで新runの開始・終了を記録するよう直し、4ボードとも再実行した。旧4K画像は採用しない。
3. 再帰solverの期限試験で、最初の入力は期限前に完了した。solver起動と期限到達の両方を確認できる条件で再実行した。
4. 通常完了後も再利用されるidle sim-workerを、試験器が未終了workerと誤認した。停止・期限時の強制終了と、通常完了後の待機を分けて確認した。
5. Icarus再実行の最初の期限試験は、再実行前に期限へ達するか、再実行が期限前に完了していた。合成から除外する実ループ負荷を加え、Icarus workerの生成後に期限へ達することと終了・再実行を確認した。

製品コードと追跡済み試験は、一時試験器の修正では変更していない。
最終の判定には `final-run`、`supplemental-final`、`replay-deadline-final` を使用した。
旧runは経緯の証拠として保持し、最終の4ボード画像や主録画へ混ぜない。

## 原証拠と再確認手順

[実施セッション](https://app.devin.ai/sessions/d978c0f0cabc4a0faac01e03c62e2cf8)の添付
`pr28-browser-1ab86d2-evidence.tar.gz` に、失敗・成功のtrace、JSON、入力、
組立て・HTTP監査ログ、4ボード画像、最終報告、一時試験器、主録画を保存した。
稼働中serverの可変ログだけを除外した。書庫内の `evidence-sha256.txt` の100ファイルを再照合した。

| 証拠 | SHA-256 |
|---|---|
| 証拠書庫 | `073e04419e13e2f5f9eb6e530e38da8ebe2bba3d5888eac5a22b049713ddd1ce` |
| 生CSV | `390b99d806696ec4fa15a9430e4be4a63419079f3ca1811dd82208517ebff121` |
| 主経路JSON | `0fdc8aef18dc86ea26c3fa0d02349f21c8d358b40dcc83b8965d63bedcca751b` |
| 停止・切替の追加JSON | `9c0c3eaf2ef49b6dc41212882b1a3d55f4aaab5528084f4d494859cf5238e4dc` |
| 再実行期限JSON | `4e6fcdd88f95d8f67e1dae9e5fdf5a51fc01ffd518e3e53dba27fa5a796cae72` |
| 対象選択E2Eログ | `9a8de4f7c4ff24bd90ca6b51dc3ed42428205336997821a1dc1ad9c001243668` |

依存と固定資材を用意した同commitのcheckoutで、次の順に組み立て・配信する。

```sh
scripts/build-web.sh
python3 public_html/serve.py --port 8123
```

別端末で、通常E2Eの対象2件を実行できる。実施時は書庫内の
`targeted.config.mjs` を使い、重い合成fixture用globalSetupは使用していない。
後のレビューで試験器の収録漏れを訂正し、
[追跡対象の設定](../../tests/browser-acceptance/targeted.config.mjs)と
[主経路](../../tests/browser-acceptance/manual-ui.mjs)、
[停止・切替](../../tests/browser-acceptance/supplemental-ui.mjs)、
[再実行期限](../../tests/browser-acceptance/replay-deadline-ui.mjs)を保存した。
同じ受入れ条件を、添付書庫なしで再実行できる。
追跡版では配信URLと新しい出力先を指定でき、既存の出力先は空でも拒否する。
記録のrevisionは再実行時のcheckoutから取得し、対話操作が失敗した場合の終了コードは1とする。
製品コードと各条件の操作・判定は変更していない。

リポジトリのrootで、既存serverに対する対象2件を実行する。
出力先は未使用のものに変える。`FORMAL_BROWSER_BASE_URL` を省略すると8123番を使う。

```sh
FORMAL_BROWSER_OUT=build/browser-acceptance-targeted \
  npx playwright test --config tests/browser-acceptance/targeted.config.mjs
```

対話的な補助は、別々の出力先で次のように起動する。
配信先を変えるときは `--base-url http://127.0.0.1:8123/` を加える。

```sh
node tests/browser-acceptance/manual-ui.mjs --out build/browser-acceptance-main
node tests/browser-acceptance/supplemental-ui.mjs --out build/browser-acceptance-supplemental
node tests/browser-acceptance/replay-deadline-ui.mjs --out build/browser-acceptance-deadline
```

各scriptの起動後に、次のコマンドを標準入力へ1行ずつ入力する。
実施時の `manual-ui.mjs` は
`primary`、`boards`、`counterexample`、`edit`、`bmc`、`prove`、`cover`、
`vhdl`、`vhdlsmt`、`switchreload`、`stop`、`timeout`、`activeedit`、`cache`、`finish` を順に入力した。
追加の `supplemental-ui.mjs` は `recursive`、`recursivetimeout`、`replaystop`、`activeswitch`、`finish`、
`replay-deadline-ui.mjs` は `replaydeadline`、`finish` を使用した。
各scriptは独立した新しいブラウザーを起動し、`exit` で終了する。
再実行時は既存証拠を別へ保存し、空の出力ディレクトリーで実行する。
これは受入れ確認の補助であり、通常CIの自動gateには含めていない。

## 未確認・対象外

原VHDLの独立シミュレーション、独自の `.sby`、混在HDLの形式検証、
複数clock、追加solver・engineは、この画面確認で有効にしていない。
4ボード確認はWeb画面とSATの確認であり、合成・配置配線・USB書き込みの実機認定ではない。
実機のTang Nanoは本リポジトリでは試していない。
