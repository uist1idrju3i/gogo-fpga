# S15 形式検証の言語・反例再実行・停止の製品接続

- 状態: 43条件を各5回、計215判定が期待どおり。画面確認は未実施
- 日付: 2026-11-15
- 担当: Devin
- 関連: [Yices2の製品配信](S15-yices2-product.md)、[形式検証資材](../research/formal-asset-delivery.md)

## 目的と仮説

HTTPから取得したGHDL・Yosys・Python/SBY・Yices2を製品runnerで実行し、
VHDLの下位化、Verilogの反例再実行、停止後の再実行を接続する。
既存の参照条件と同じ判定を得て、資材やソースの改変、停止、期限超過を成功と区別できるか確認する。
VHDL原文の独立シミュレーションは、この接続では実装しない。
下位化Verilogの形式検証と原VHDLの再実行を分け、後者を「利用不可」と表示する。

## 採否の基準（正式反復の前に固定）

- SAT 12条件、Yices2/SBY 6条件、VHDL 16条件と、停止・期限・再起動・負の対照9条件の
  計43条件を各5回実行し、statusとkindの不一致を0件とする。
- Verilogの反例5条件は、各回とも原文をIcarus WASIで再実行する。
  独立VCD、property、違反周期、clock、入力・出力の検査を通さずに確認済みとする件数を0件とする。
- VHDLの反例にVCDがあり、原文の独立再実行を確認済みとする件数を0件とする。
  空property、破損したGHDL library、構文エラー、混在HDLを成功とする件数を0件とする。
- 実SAT workerの停止と1秒の期限、SBYのsolver worker生成後の再帰的停止を検査し、
  停止後は同じrunnerで新しいjobが成功する。SBYが生成したsolver workerの未終了数を0とする。
- ソース編集では実行中のjobと反例再実行を停止し、古い結果と波形を破棄する。
  プロジェクト切替・再読込・cache改変を含む画面操作は、全実装後の別検査とする。

## 条件と再実行

基準はRelease closure修正後の `d455697772ff86c40a5129a886ee716bcd8511f2`。
正式反復の実装commit、変更の有無、スクリプトのhash、OS・CPU数・メモリー・Nodeの版は
反復出力の `metadata.json` に記録する。ビルド設定は変えず、既存の配信binaryを再利用する。
Yices2の版・固定ソース・GMP・SDKとbinaryの照合は[製品配信記録](S15-yices2-product.md)と同じである。

```sh
node --test tests/web/formal-*.test.mjs tests/web/sim-runner.test.mjs
FORMAL_WEB_ROOT=build/formal-product-web node --test --test-concurrency=1 tests/product/formal.test.mjs
node scripts/qualify-yices-product.mjs --scope all --web build/formal-product-web --out build/formal-product-integration --repeats 5
```

通常のCIでは `scripts/build-web.sh` で組み立てた `public_html` を使用する。
ローカルの資材は[既存のCI資材](../research/formal-asset-delivery.md#回帰試験と再実行)を基礎とし、
現行のPython・Yices2 bundle、GHDLのWASMとlibrary archive、Icarusの3 binaryを加えた。
製品試験はHTTP応答と圧縮前後のhashを照合し、Yosys、GHDL、Yices2とlibraryのhashを保存する。
Icarus各binaryのhashも試行metadataに残す。
Node worker_threadsでは、ブラウザーworker本体のメッセージと資材URLだけを変換する。
原Verilogの再実行には製品の `sim-worker.js`、`createSimRunner()`、`runIverilog()` をそのまま使う。

## 計測器と失敗試行

予備回帰の初回は、GHDLがメモリーを通常のregisterへ下位化した条件を試験側が未対応と期待し、
1条件が失敗した。実際のFAILとVCDを確認し、既存の参照fixtureと同じ期待値へ訂正した。
未対応のstate cellを拒否する単体試験は維持する。

次の試行では、SMT反例からtraceを読むPython補助jobが、試験器のSBY結果を上書きした。
実行結果はFAIL、独立再実行はverifiedだったが、試験器がstatusを読めず失敗した。
SBYとtrace補助の結果を別に保存するよう修正した。
独立VCDの格納先も製品runnerの `work/formal-replay.vcd` に合わせて照合する。

停止の試行ではSATの停止・期限・再実行と、SBYからsolverへの停止が成功した。
VHDLの追加SAT条件は、clockを持つfixtureにclockを指定していなかったため失敗した。
同じfixtureのclockとdepthを渡した後、製品回帰は39件すべて成功した。
これらの試行は正式反復へ数えず、ログhashを[失敗・予備記録](S15-formal-product-integration-failures.csv)へ保存する。

NodeにはCache Storageがないため、予備回帰ではcacheを開けない警告が出た。
検証済み資材をHTTPから取得して続行しており、ブラウザーのcache操作を検査したことにはならない。

## 結果と証拠

実装commit `cc36c4f1f1a8490952f6c04f321ad3a55ba1b8bb` の清浄な作業ツリーで5回実行した。
5回とも製品回帰39件が成功し、[生CSV](S15-formal-product-integration.csv)の43条件・計215行に不一致はなかった。
Verilogの反例は25/25が独立VCDの照合まで成功し、VHDLは70/70で原文再実行を利用不可と分類した。
実worker停止・期限・再起動と負の対照は、9条件を各5回、計45判定が期待どおりだった。
これらは前述の採否の基準を満たす。ただし、画面操作の検査は含まない。

各試行は43行のstatus、kind、言語、再実行状態、時間、solver・GHDL・library・ログのhashを保存した。
Nodeは24.22.3、Linux kernelは6.8.0-1060-aws、CPUは2個、メモリーは8,328,228,864 bytes。
以下は同じ条件を5回実行したときの最小・中央値・最大で、単位は秒。
個別条件の時間は資材取得後の下位化・worker起動・再実行を含む統合経路の値であり、solverの計算時間として比較しない。
製品回帰の総時間はHTTP取得も含む。

| 条件 | 最小 | 中央値 | 最大 |
|---|---:|---:|---:|
| SAT identity | 0.908 | 0.972 | 0.973 |
| SBY bmc-violation | 6.015 | 6.045 | 6.146 |
| VHDL depth-n | 4.393 | 4.434 | 4.471 |
| 製品回帰1回の総時間 | 121.063 | 121.507 | 124.495 |

実行したYosysのSHA-256は `11ee003141aa7c05b8413f77f44e7a1e54c124a66bb338ff38fd47028387b5c3`。
Icarusの3 binaryも5回とも同じhashだった。
`ivlpp` は `7ab296df67635fc272b5dfa95c3e0e5e0f7176271b4035d26f847e266c6936af`、
`ivl` は `936223cd9204283fe16a1b3232684a9766573088d2d0da3fa08a2c94fcfdb30f`、
`vvp` は `909014061e6dbde49f2f86b47c4a2b536abaea0c79678a7b901e6b816de1bc83`。
各試行の取得先に未commitの変更はなかった。スクリプトと実装のhashは試行全体のmetadataへ保存した。

関連の形式検証・sim-runner単体158件も成功した。
全Web単体の初回は配信物とopenFPGALoader資材がなく、429件中5件が失敗した。
CI由来の配信資材と現行Webソースを配置し、artifact metadataを検証した後は447件すべて成功した。
配信監査の単体20件、Release closureの単体15件、solver protocolの単体151件も成功した。

原ログ、入力、workspace差分、SQLite、形式VCD、独立再実行のstdout・stderr・VCDは
`build/formal-product-results-*` とCIの `ci-formal-product-*` artifactへ保存する。
`trial-*.json` が各証拠ディレクトリーを指す。既存の出力先を指定すると上書きを拒否する。
5回分の原証拠は[実施セッション](https://app.devin.ai/sessions/d978c0f0cabc4a0faac01e03c62e2cf8)の添付
`formal-product-integration-evidence.tar.gz` にも保存した。
書庫のSHA-256は `d24341c12a972a7d1bd101a1d1abf88e820e12774a8d2a20ac9fbb2dc328cdef`。

## レビュー修正後の再認定

初回の正式反復後、VHDLだけのプロジェクトで画面の対象一覧が空になる問題と、
`TOP` や `ToP` を指定すると下位化後の `top` を見つけられない問題をレビューで検出した。
画面の対象を `.v`、`.vh`、`.vhd`、`.vhdl` とし、選択の保存・再読込を検査するE2Eを追加した。
GHDL下位化後は、後続のSAT・SMTBMCへ渡すtopとclockを小文字へそろえる。
元のプロジェクトと入力の設定は変更しない。

大小文字の回帰4件は修正前にすべて `Missing formal top module` で失敗し、
修正後のformal-runner単体は21件、全Web単体は451件が成功した。
修正前のログとhashを[失敗・予備記録](S15-formal-product-integration-failures.csv)へ追記した。
画面確認はこの修正のため、アプリ操作前に中断した。

修正commit `1207b400264a8d85e7e45c59bb8814743cd73bd4` の清浄な作業ツリーで、
同じ43条件を各5回、計215判定として再実行した。
今回は実GHDLを使うVHDL条件も `formal.top: "ToP"` と大文字のclockで実行した。
[修正後の生CSV](S15-formal-product-integration-reviewed.csv)は初回と別に保存し、不一致は0件だった。
各回の製品回帰39件、Verilog反例25/25の独立再実行、VHDL原文再実行70/70の利用不可分類も成功した。
ホスト、Node、配信binary、SDKとビルド設定は初回と同じで、実装と試験器のhashは再記録した。

```sh
node scripts/qualify-yices-product.mjs --scope all --web build/formal-product-web --out build/formal-product-integration-reviewed --repeats 5
```

| 条件（秒） | 最小 | 中央値 | 最大 |
|---|---:|---:|---:|
| SAT identity | 0.948 | 0.976 | 1.111 |
| SBY bmc-violation | 6.028 | 6.050 | 7.142 |
| VHDL depth-n | 4.379 | 4.429 | 5.296 |
| 製品回帰1回の総時間 | 120.875 | 121.927 | 130.816 |

時間の範囲は初回と同じで、solver単体の比較ではない。
5回分のログ、metadata、SQLite、VCD、入力、大小文字の修正前後とWeb単体のログを、
実施セッションの添付 `formal-product-integration-reviewed-evidence.tar.gz` に保存した。
書庫のSHA-256は `1b958c1ae5e55aca6dafea00fa4e609abe0da7362e76e167986d94b5a60bcdf1`、
修正後CSVは `564b4ebf0fd168ea287652a115d0b67aa12cde39461431b6814936c49dd6e3d6`。
画面確認は修正後の実装と自動回帰が完了してから再開する。

## 対象一覧の修正先を訂正した後の再認定

再レビューで、前節の対象一覧の修正が `renderSimulationSettings()` に誤適用され、
`renderFormalSettings()` の候補はVerilog限定のままだったことを確認した。
VHDLとVerilogの混在プロジェクトでシミュレーションの選択を変更すると、
VHDLが `simulation.files` に入り、以後の保存をschema検査が拒否した。
前節の215判定はNodeの製品runnerの結果であり、対象一覧の修正を検証した証拠にはならない。
ブラウザー操作は再び中断し、旧revisionの録画を最終の画面証拠には使用しない。

commit `d2a16d854aba8ca4a2f6d243d3d99906a0601981` で、シミュレーション候補をVerilog限定へ戻し、
形式検証の候補と空表示だけをVHDL対応へ修正し直した。
混在プロジェクトの選択変更・保存・再読込・再編集を既存E2Eへ追加した。
VHDL対象のE2Eも、再読込後に検証タブを開いてから操作するよう直した。
これらの画面操作はNodeで代用せず、最終実装のブラウザー検査で実行する。

このcommitの清浄な作業ツリーから同じ43条件を各5回実行し、
[対象一覧修正後の生CSV](S15-formal-product-integration-ui-fixed.csv)の215判定に不一致はなかった。
Verilog反例25/25の独立再実行と、VHDL原文再実行70/70の利用不可分類も維持した。
ホストとNode、ビルド設定、配信binaryは前節と同じで、実装のhashを再記録した。

```sh
node scripts/qualify-yices-product.mjs --scope all --web build/formal-product-web --out build/formal-product-integration-ui-fixed --repeats 5
```

| 条件（秒） | 最小 | 中央値 | 最大 |
|---|---:|---:|---:|
| SAT identity | 0.942 | 0.947 | 0.999 |
| SBY bmc-violation | 6.026 | 6.073 | 6.090 |
| VHDL depth-n | 4.453 | 4.459 | 5.694 |
| 製品回帰1回の総時間 | 121.031 | 122.304 | 136.150 |

全Web単体は、案内placeholderを配置した状態の初回に451件中2件が失敗した。
`scripts/build-web.sh` でアプリを組み立てた後は451件すべて成功した。
初回ログのhashも失敗・予備記録へ追記した。
実施セッションの添付 `formal-product-integration-ui-fixed-evidence.tar.gz` に、
5回分の原証拠、metadata、単体の失敗・成功ログと組立てログを保存した。
書庫のSHA-256は `80f86552938a51d6e9075e4354c8529a3735c8a959ba9ded927b1ad1add0b8e3`、
CSVは `c76bc055c95406a0b0d79030b6cb3f1a4604e0ac9fa301d5fb1c3a595d53fa30`。
当該commitの再レビューは新規指摘0件だった。CI全体と画面確認は引き続き別に確認する。

## ブラウザー試験の再読込条件の訂正

commit `6a817c576eec1170b157d57fcd441e62e3b909eb` のWebを組み立て、
HTTP配信監査とソースのhash照合後に、VHDL対象と混在プロジェクトのE2Eを実ブラウザーで実行した。
2件とも選択解除と保存までは進んだが、再読込後の検査に失敗した。
起動時の `initializeProject()` は保存済み一覧の先頭を開くため、試験が作成したプロジェクトではなく
`blink` の対象を検査していた。製品の保存不具合と判断する証拠は得ていない。

試験を修正し、作成時の名前を保持して、再読込後に画面のプロジェクト選択で開き直す。
プロジェクト名を確認してから検証タブとcheckboxを検査する。
原ログのhashは失敗・予備記録へ保存した。修正後の2件と残りの画面検証は別途実施する。

## 未確認の点

Nodeでの製品経路の確認と、ブラウザーの操作・画面の目視・実機を区別する。
4ボードの画面は、この記録の作成時点では0/4である。
VHDL原文の独立再実行、独自の `.sby`、混在HDL、複数clock、追加solverやSBY engineは有効にしない。
既存のnative GHDL参照試験は、ブラウザーで原VHDLを再実行できる証拠に置き換えない。
実機のTang Nanoは本リポジトリでは試していない。
