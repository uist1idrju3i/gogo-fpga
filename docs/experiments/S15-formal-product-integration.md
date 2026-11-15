# S15 形式検証の言語・反例再実行・停止の製品接続

- 状態: 予備回帰39件成功。正式5回反復の基準を固定
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

正式反復の結果は、実行完了後に生CSVとともに追記する。
各試行は43行のstatus、kind、言語、再実行状態、時間、solver・GHDL・library・ログのhashを保存する。
時間は統合経路全体の値であり、solverの計算時間として比較しない。

原ログ、入力、workspace差分、SQLite、形式VCD、独立再実行のstdout・stderr・VCDは
`build/formal-product-results-*` とCIの `ci-formal-product-*` artifactへ保存する。
`trial-*.json` が各証拠ディレクトリーを指す。既存の出力先を指定すると上書きを拒否する。

## 未確認の点

Nodeでの製品経路の確認と、ブラウザーの操作・画面の目視・実機を区別する。
4ボードの画面は、この記録の作成時点では0/4である。
VHDL原文の独立再実行、独自の `.sby`、混在HDL、複数clock、追加solverやSBY engineは有効にしない。
既存のnative GHDL参照試験は、ブラウザーで原VHDLを再実行できる証拠に置き換えない。
実機のTang Nanoは本リポジトリでは試していない。
