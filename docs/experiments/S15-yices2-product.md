# S15 Yices2 の製品配信と SBY 実行

- 状態: 配信と Verilog 6 条件の Node worker 実行を確認。製品全体の認定は継続
- 日付: 2026-11-15
- 担当: Devin
- 関連: [形式検証の配信](../research/formal-asset-delivery.md)

## 目的と仮説

固定した Yices2 と GMP を既存の診断用設定のまま WASI にビルドし、
通常配信の manifest と HTTP から得たバイナリーを製品の worker で実行する。
SBY の初期化だけでなく、Yosys、SMTBMC、Yices2 の子プロセスが実行され、
既存の 6 条件で status、終了コード、SQLite、反例が整合するとの仮説を検査する。
既定 solver の確定とブラウザーの画面確認は、この実験だけでは判断しない。

## 採否の基準（実行前に固定）

- BMC の有界成功と違反、prove の UNKNOWN と証明成功、cover の到達と未到達の
  6 条件を各 5 回実行し、期待 status と終了コードの不一致を 0 件とする。
- 成功・失敗の双方で、実 Yosys と SMTBMC の子プロセスおよび solver の
  SHA-256 と正常な通信終了を確認する。子プロセスが動かない setup の結果は代用しない。
- 改変した配信 manifest、WASM、サイズ、SHA-256、MIME、欠落した license、
  Git を含まないソースの改変を、負の対照ですべて拒否する。
- 反例には VCD と upstream の status.sqlite が存在し、SQLite の整合性検査を通す。
- 配信単位は 25 MiB 未満。ビルド設定は既存の `-O2` と WASI 例外設定を維持する。

パスを変えた予備ビルドで、GMP の `pprime_p.c` が絶対パスを WASM 内へ残すことを検出した。
以降は `-ffile-prefix-map` だけを追加し、異なる出力先での 2 ビルドが完全一致すること、
既存の 6 条件が各 5 回とも一致することを追加の事前基準とする。
最適化、例外、メモリー、単一 thread、GMP の静的リンク設定は変えない。

## 条件と手順

基準は `8bdfa4fb31bf6580995dc05779bed6261ead60b6`。
診断用の予備ビルドは既存スクリプトで作り直し、WASM は 1,970,052 bytes、
SHA-256 は `e6cffbb45b09fa8dacf78ef5d7ea9eb27e03e2a562ce14c7097a4ab63083bfe7` だった。
これは製品認定の実行前に取得したビルド成立性の確認であり、認定結果には数えない。
source pin、SDK、patch、実コンパイラー、コマンドは製品 build metadata に保存する。
各試行の生の値と失敗は、実行スクリプトの CSV と JSON に保存する。

| 項目 | 値 |
|---|---|
| ホスト | Linux 6.8.0-1060-aws x86_64、2 CPU、MemTotal 8,133,036 KiB |
| Node.js | v24.22.3 |
| compiler | 実行した Clang 23.1.0-wasi-sdk。SDK pin は RESEARCH の表を参照 |
| source | manifest の pin、source inventory hash、patch、script、原 license の hash で固定 |
| 出力 | `build/formal-solvers` を再生成。SAT と Pyodide は既存の配信資材を再利用 |
| 変更条件 | ビルド出力先と Git の有無。最適化・例外・メモリー設定は固定 |
| 反復 | 同じ 6 条件を順に各 5 回。独立した worker で実行 |

```sh
python3 scripts/build-formal-solvers.py build
python3 scripts/build-formal-solvers.py stage --web public_html
node --test --test-concurrency=1 tests/product/formal.test.mjs
node scripts/qualify-yices-product.mjs --web build/formal-product-web --out build/yices-product-qualification
python3 scripts/qualify-yices-source.py --out build/yices-gitfree-qualification
```

後ろの 2 コマンドは既存出力を上書きしない。再試行では別の `--out` を使う。

## 結果

[生 CSV](S15-yices2-product.csv) の 30 行で、期待 status と分類の不一致は 0 件だった。
HTTP の manifest と圧縮資材を製品 loader で検証し、`createFormalRunner()`、
原本 SBY、Yosys、SMTBMC、実 Yices2 worker を通した。
全条件で子プロセスの整合性、選択 solver の hash、status と終了コードを確認した。
status.sqlite の整合性検査も 30 回すべて成功し、違反と到達の条件には VCD が存在した。
SAT の 12 条件と SBY setup を合わせ、各回の Node test は 20 件とも成功した。

| 条件 | status / 分類 | 最小 / 中央値 / 最大 (ms) |
|---|---|---|
| bmc-prefix | PASS / bounded-pass | 3973.984 / 4028.671 / 4037.447 |
| bmc-violation | FAIL / counterexample | 3999.308 / 4055.473 / 4065.931 |
| prove-inconclusive | UNKNOWN / unknown | 5324.108 / 5394.475 / 5465.139 |
| prove-invariant | PASS / proved | 5344.992 / 5438.215 / 5481.251 |
| cover-reached | PASS / covered | 4033.642 / 4087.039 / 4135.760 |
| cover-unreached | FAIL / unreached | 4014.208 / 4065.724 / 4388.265 |

製品 WASM は 1,970,004 bytes、SHA-256 は
`893f8d55b4d0a21bc61f311fa48806a0400cdc0e1f7be4b0073f24b0a7719c2d`。
異なる出力先での 2 ビルド、通常の製品ビルド、Git を含まないソースからのビルドで一致した。
Git を拒否する wrapper を置いた再生成でも Git 呼出しは 0 件で、入力と WASM が一致した。
再生成は 87.122 秒だった。GMP archive の配置が `build/cache` と
`vendor/formal-archives` で異なるため、実コマンドを含む build metadata の byte 列は異なる。
この archive のパスだけを共通の記号へ置換すると、来歴の全項目が一致することも要求した。

配信・ソース来歴の単体試験 20 件、Release closure の単体試験 9 件、
formal 関連の Web 単体試験 142 件が成功した。manifest、binary、proof、license、
MIME、source inventory、size、SHA-256、不正 path・リンクの負の対照を含む。
Web 全単体試験の初回は、未生成の flasher と `public_html` に依存する 5 件が失敗した。
製品の完全な Web 組立てを行う CI の結果は別に確認する。

## 失敗試行と警告

- 初期 WASM は出力先によって hash が異なった。GMP の絶対パス混入を検出し、
  `-ffile-prefix-map` を追加した。初期の 1,970,052 bytes は採用しない。
- Git-free 試験の初回は、検査スクリプトが GMP archive の配置を誤り、ビルド前に停止した。
  配置を修正し、別出力で再試行した。
- 2 回目は WASM が一致したが、archive の配置を含む manifest 全体の一致条件で停止した。
  事前の採否基準どおり WASM と入力の一致を要求し、来歴では上記の 1 パス以外の差を拒否する。
- upstream 由来の Autoconf の endian 警告、WASI の errno include、未使用の timer、
  一部 link 引数、GMP の未使用式と演算子の優先順位の警告は残る。ソースや判定の意味は変更していない。

## 証拠の保存と再現

各反復のログ hash は CSV にある。実行スクリプトは commit と作業差分、使用した script の
SHA-256、Node の版、試行ごとの結果と solver の identity を JSON に残す。
大きなログと VCD は `build/formal-product-results-*` と CI の
`ci-formal-product-*` artifact に保存する。各結果には入力と結果の hash を保持する。
コンパイルの標準出力は private build のコマンド別 `*.log` に保存し、
`private-build/metadata.json` が全コマンドの終了コード・時間・ログ hash を持つ。
外側の `build.log` が空でも、これらの診断ログを証拠として用いる。

## 未確認の点

PR レビューで、Release 試験の submodule 取得対象に Yices2 がなく、対応ソース書庫に
`vendor/yices2/.gitcommit` を保存していない不備を確認した。取得対象と書庫生成を修正し、
solver closure の正常系、固定 commit の欠落・改変、ソース・patch・配信物の改変拒否を
専用の単体試験 6 件へ追加した。最小の Git-free 再生成試験と、実際の Release 書庫全体の
再組立ては別の確認であり、後者は引き続き確認する。

この記録だけで、VHDL、独立した HDL 反例再実行、製品全体の停止・編集・再読込を認定しない。
Node worker_threads の結果は、ブラウザーでの操作や 4 ボードの目視確認に置き換えない。
実機の Tang Nano は本リポジトリでは試していない。
