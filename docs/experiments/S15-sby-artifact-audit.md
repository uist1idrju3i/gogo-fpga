# S15 P3: SBY成果物と全16列の独立監査

[実験の索引](README.md) / [接続層の実装と初期試行](S15-sby-runtime.md) / [調査の索引](../../RESEARCH.md#7-分割した調査)

## 目的と現在の範囲

SBY全体のnative/Pyodide比較を、比較器自身の`error: null`や主要ファイルだけで成功としないための監査です。`scripts/audit-formal-sby.py`は、生CSV全16列を元ファイルから独立に導き直します。`scripts/sby-artifact-audit.py`は、実行環境による差を明示したフィールドだけで正規化し、除いた元の値を`variations`へ記録します。SBY・SMTBMC・solverの判定処理は変更しません。

この層は計測器の整備です。未commitの予備試行と、後述の清浄な実装commitの確認を分け、いずれも正式反復には数えません。その後の[正式5回・A/A 2回](S15-sby-repeated.md)は別に完了しました。実SBYを動かしたworkerの全異常対照、元回路の反例検査、UIと配布は未完了です。実機では本リポジトリで試していません。

## 固定条件と実行前の基準

回路、SBY設定、深さ、solver、期待分類は`tests/synth/formal-sby-cases.mjs`と[接続層の6条件](S15-sby-runtime.md)を変更しません。Yices2/Z3の全12条件が重複なく存在することを必須とします。診断用の`--solver`/`--case`で一部だけを出力しても、この監査を成功させません。

| 条件 | status / rc | 独立した分類 | 成果物数 |
|---|---|---|---:|
| bmc-prefix | PASS / 0 | bounded-pass。証明へ昇格しない | 20 |
| bmc-violation | FAIL / 2 | counterexample | 24 |
| prove-inconclusive | UNKNOWN / 4 | basecase成功・induction失敗。assert violationへ昇格しない | 25 |
| prove-invariant | PASS / 0 | basecaseとinductionが成功したproved | 21 |
| cover-reached | PASS / 0 | covered。安全性証明ではない | 24 |
| cover-unreached | FAIL / 2 | unreached。assert violationとは別 | 20 |

成果物数は入力・設定・root log・JUnit・JNY・status・SQLiteを含み、2 solverの合計は268です。native stdout/stderrはさらに別に保持します。VCD/YW/testbench/SMTCは、違反・induction反例・cover到達でのみ必須とし、未到達時に余分なtraceがあっても拒否します。

正式試行では、比較器とnative基準のcommitが一致し、双方のworktreeが空であることを必須とします。solverはP2のclean build、Yosysは製品用資材を使い回し、実行入力のnative/WASI binaryとYosys shareを証拠へ保存してSHA-256を再計算します。nativeの実command prefix、Python/Yosysの版、source snapshot、元Python sourceのhash、patch、stageした全Python資材も照合します。Pyodideのnative process/thread制約、初期の`-j 1`、process time unavailableの扱いは接続層のままです。

## 全列と終了の監査

CSVの列名・順序・行数を固定し、JSONにだけ成功が残る場合や、CSVの値だけが異なる場合も拒否します。

| 列 | 独立した根拠 |
|---|---|
| solver / case / mode / depth / expected | 全12条件の独立した期待表、native設定、per-case JSON |
| status / kind / exitCode | mode別分類、実終了、status file、最終DONE、JUnit、SQLite、各phaseのlog |
| elapsedMs | root transportの有限な正の実測値。欠測や非有限値を0にしない |
| artifactCount / comparedCount | 固定した全成果物集合と、旧主要成果物集合の再計算 |
| sqliteSha256 / modelSha256 | 保存したPyodideのSQLite/SMT2の全byte |
| solverSha256 / yosysSha256 | 保存したWASI入力binary、build metadata、再帰的なsolver実行記録 |
| error | 全検査の成功を必要とし、単なる空欄を信用しない |

`native.json`の全file inventoryを原本のサイズ・SHA-256と照合し、native/Pyodide双方のfile setを完全一致させます。root stdoutとroot logfileの全byteも一致が必要です。status fileの第2値はrc、第3値は経過秒で、後者はroot summaryとJUnitのtimeに一致する必要があります。

tool childはBMC/coverで4件、proveで5件です。root logのcommandから得たargvと全childのargvを照合します。SMTBMCのbasecase/inductionを混ぜず、phaseごとの`Status: passed/failed`と通常のrc 0/1を照合します。各SMTBMCのsolver childは1件で、solverの実hash・argv・終了0・integrity・出力・有限な資源値を確認します。取消、timeout、crash、不完全な輸送、未検証の終了は、通常のengine非ゼロ終了へ読み替えません。

## 許す環境差と、保持する内容

| 対象 | 許す差 | 保持して比較する内容 |
|---|---|---|
| root log / summary / JUnit system-out | SBY/SMTBMCの時計、所要時間、入力の絶対path、記録済みのnative executable prefix | cwd、全argv、phase、property、status、全診断と順序 |
| Yosys log | GNU/Clangのcompiler表示、所要時間・memory・profiling | Yosysの版・git pin、compilerの種類、Logfile hash、全pass出力 |
| IL / SMT2 | 先頭のcompiler表示 | generatorの版・git pin、全モデル本文 |
| JNY | generatorのcompiler表示、`cell_sorts`のtype順 | 全JSON構造、全要素と値。重複key/type、非有限値は拒否 |
| JUnit | timestamp、hostname、経過秒、Linux/EmscriptenのOS値 | XML構造、全property、test、failure、skipped、system-out |
| SQLite | 各表の`created`のみ | schema SQL、全column定義、全5表の全行・他の全列 |

時間は書式と整合性を検査し、単に行ごと削除しません。native commandはmetadataの完全なprefixだけを仮想tool名へ置き換え、未知の実行commandを許しません。browserのprocess timeは未提供と確認し、0秒を許しません。Yosysのresource footerとprofilingは各1件を必要とします。JNYの要素を削ったり、SQLiteのstatusやtraceを除いたりしません。XMLの宣言・entity、未確定のWAL/SHM、SQLiteの破損・外部キー違反・未知schemaは失敗です。

### UNKNOWNとSQLiteの注意

固定版SBYの`prove-inconclusive`では、rootの最終表示とstatus fileはUNKNOWNですが、SQLiteの`task_status`表には行がありません。`task_property_status`にはinduction反例に伴うFAIL、`task_trace`には`engine_case=induction`のVCD/YWが残ります。これをrootのassert violationやproof PASSへ読み替えてはいけません。監査はこの条件でだけ最終status行の不在を要求し、他の5条件では最終status行とrootの一致を要求します。traceのpath集合とphaseも検査します。

原典は固定版の`vendor/sby/sbysrc/sby_status.py`、`sby_mode_prove.py`、`sby_engine_smtbmc.py`です。固定commitはPython manifestとnative metadataに保存します。製品のstatusアルゴリズムを監査側へ移植するのではなく、この6 fixtureの期待条件を独立して検査します。

## 計測器の負の対照

`tests/check-solver-protocol/test_sby_audit.py`は外部binaryがなくても動く全12条件のfixtureを作り、正常な268成果物を監査します。全16CSV列の変更、違反条件の全24成果物それぞれの変更と欠落、構文として有効なstatus・command・generator・JNY・JUnit・SQLite schema/rowの変更、再帰的solverの異常、未検証の終了、実行入力やnative原本の変更を拒否します。重複JSON key、NaN/Infinity、親directoryのsymlinkも拒否します。`cell_sorts`の並び、`created`、resource時間だけの許可された変更では同じ正規形となり、除いた値が記録に残ることも確認します。

このunit fixtureでの拒否は、実SBYの計算中にworkerを停止する対照とは別です。後者を実施済みとは扱いません。

## 予備試行と失敗

監査器の初回はroot logfileのnative/Pyodide差で停止しました。nativeはYosys絶対pathとPython+SMTBMC絶対path、Pyodideは仮想tool名でした。任意のpathを消すのではなく、native metadataへ実commandを保存し、起動と監査で同じ値を使うようにしました。次にproveの`engine_0.basecase`/`engine_0.induction`を初期のstage名の正規表現が受け付けず停止しました。stage名の`.`を受け付けても文字列自体は保持します。失敗log `p3-artifact-normalizer-preliminary-1.log`も保全します。

その後、`p3-audit-runtime-preliminary-1`と`-2`の各12条件で、per-case監査は全268成果物と16列を照合できました。後者は実行binaryとnative build metadataも保存しています。親は`d6c5e6e58565b426747845707bde834a7fa71582`ですが、どちらも未commitの監査器を含む試行です。完全な監査のclean-worktree基準を満たさず、正式な成功には数えません。`-2`の[生CSV](S15-sby-artifact-audit-preliminary.csv)は捨てずに保存します。

予備の実行環境はNode v24.21.0、native Python 3.12.13、Pyodide package 314.0.7です。Yices2/Z3/Yosysの実binaryは[接続層の同一commit確認](S15-sby-runtime.md#清浄な実装commitの予備確認)と同じものを使い、今回も起動前にhashを照合しました。Python unitは既存分を含む44件、うち新監査器は9件が成功しました。raw log・metadata・全成果物と失敗記録の保全は次節へまとめます。

## 清浄な実装commitの確認

`0ae89ed6452a0b1dcec21dd2705bb4891e39b90a`のworktreeが空の状態で、native基準とPython資材を再生成しました。同じ状態で全12条件のPyodide比較と、完全な独立監査を実行し、いずれも成功しています。生CSVは[全12行16列](S15-sby-artifact-audit-0ae89ed.csv)です。全268成果物を比較し、既知の差の元の値は1,372件のvariation記録として保存しました。これは重複を含む記録数で、許容フィールドの種類数ではありません。unit/Web/実WASIは計316件 (272 + 44) が成功しました。正式反復ではなく、計測器の同一commit確認です。

native YosysのSHA-256は`d298997c12f89e845b76ba0a8b484ad5ebbe63b604397948bbd0d8ecfd9e318c`、WASI Yosysは`85812d62f2aaf0a4ab9ed8c933a862cc4eec18a874160b4fc36e5871d82ff644`、shareは`531b97d2d9d99eb375177def6adaace730539ab33f529d09294840cb00bead5f`です。solverのnative/WASI hashは各build metadata・全列CSV・保存入力を相互照合しました。runtimeとsource/pin/patchの実測metadataは証拠へ保持しています。

`S15-sby-audit-evidence-0ae89ed.zip`には、原本・全成果物・独立監査の詳細・入力binary・Python資材・316件のlog・予備の失敗と結果を含めました。[全3,176ファイルの目録](S15-sby-artifact-audit-0ae89ed.files.csv)のサイズとSHA-256を、ZIP再読込みで全件照合しています。ZIPは46,561,178 byte、SHA-256は`31ae68b8b4661a075148d3bfc4cfe45e37798154f09367827b5026bf61cb001e`です。

native起動用のsolver symlinkはZIPから除き、実binaryとhashは比較結果の`inputs/`へ収めました。未commit予備試行の重複binaryもZIPには重ねず、そのmetadata・raw結果・snapshot・artifactは保持しています。成功した同一commitの`inputs/`は全件収録済みです。ZIPはチャットで渡し、repositoryには生CSV・目録・実験記録を置きます。

## 再実行

[接続層の再実行手順](S15-sby-runtime.md#比較器の予備実行)で、新しいnative基準とPython資材、比較結果を清浄な同じcommitから生成します。その後、次を実行します。出力は新規のpathを選び、既存の証拠を上書きしません。

```sh
python3 -m unittest discover -s tests/check-solver-protocol -v
python3 scripts/audit-formal-sby.py build/S15/p3-sby-comparison-new \
  --out build/S15/p3-sby-comparison-new/independent-audit.json
```

全列監査の成功は、上流の意味論の独立証明ではありません。正式5回・A/A 2回、SBYの全異常対照、元回路の反例検査、witness実行境界、配布・UI・全CIは引き続き別の完了条件です。
