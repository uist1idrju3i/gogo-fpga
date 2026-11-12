# S15: 原本SBYの仮想process接続

[実験の一覧](README.md) / [形式検証の事前基準](S15-formal-verification.md) / [process境界とSMTBMCの予備記録](S15-sby-process.md)

この記録は接続層と初期試行を保持します。その後の[全268成果物・16列の独立監査器](S15-sby-artifact-audit.md)は、JNY・JUnit・root logの限定した環境差、SQLiteのUNKNOWN最終行不在、再帰的終了と改変の拒否を別に記録します。[正式5回・A/A 2回](S15-sby-repeated.md)も完了しました。以下の残件表現は本接続層を記録した時点のもので、worker異常対照と製品統合は現在も未完了です。

## 目的と実装範囲

SBY、Yosys、SMTBMC、solverを、ブラウザー用のprocess・pipe・filesystem境界で接続します。SMTの生成・応答解析、property評価、SQLiteへのstatus記録、BMC・prove・coverの最終判定は上流のPythonを維持します。原本の固定版、native比較条件、Pyodideの制約は親のprocess記録を参照します。

`patches/sby-process.patch`は、SBYのPopenとselect、jobserver、resource計測の境界だけを変更します。native側のASTは、ブラウザー分岐を取り除くと原本と一致することを検査します。ブラウザーでは`-j 1`を強制し、autotune、temporary directory、link mode、jobserver helperを拒否します。process時間は0へ置き換えず、取得できないと表示します。

親Pyodideは同期実行中にmessageを受け取れないため、子の起動要求だけをmanagerへ送り、stdout・stderr・差分・完了通知は共有メモリーから読みます。YosysはWASI worker、SMTBMCとwitnessは別のPyodide workerで実行します。子が完了する前に差分を送り切り、親はpoll中にも差分を読みます。適用前にpath、件数、サイズ、hash、親との競合、ファイルとディレクトリーの衝突を検査し、親のlogやSQLiteを上書きしません。

許可するのは`cd WORKDIR; TOOL ARGS`の限定した形だけです。shellを起動せず、Yosys・SMTBMC・witnessのargvを検査します。対象外のsolverやoptionは拒否します。通常のengineの非ゼロ終了は、workerのcrash、期限切れ、取消、輸送の破損と区別します。

## 比較器の基準

ここで追加する比較器は予備検査です。6条件を両solverで実行し、各条件のstatus file、終了コード、最後のDONE行、modeによる分類が事前表と一致することを要求します。basecaseとinductionは別の子として残し、短いproveのUNKNOWNをPASSに変えません。cover未到達のFAILもassert違反と区別します。

入力、設定、Yosys script、RTLIL・SMTの本文、engine log、VCD・YW・testbench・制約のファイル名と内容をnativeと比較します。RTLIL・SMTの先頭にあるcompilerを含むYosys版表示、engine logの経過時刻は別に保存して比較を正規化します。SQLiteは整合性・外部キーを検査し、上流の5表の全行・全列を比較します。作成時刻の列だけを比較対象から外し、元のDBは保持します。WALが未確定のDBは受け付けません。

SBY全体のlog、Yosysの資源・時間、JUnit XML、JNY JSONも全て保存しますが、この層ではその全フィールドの独立監査まで完了とはしません。JNYのcell_sortsにnative/WASIの列挙順の差があり、原文を残して別途検査します。正式5回とA/A 2回、負の対照、全列の独立監査、反例の再実行、配布資材のclosure、画面統合、ブラウザー操作は後続の検証です。

## 初期の試行と失敗

未commitの`p3-sby-runtime-preliminary-3`では、両solver各6条件が期待するstatusになりました。これはstatus中心の予備実行であり、全成果物比較や正式反復ではありません。

最初の接続は、JavaScriptの`null`がPyodideで`None`にならず、未完了のprocessから差分を取ろうとして停止しました。共有メモリーの待機状態は`undefined`を返すように修正しました。engine判定は変えていません。さらに、runpyの終了後も循環参照がSQLite接続を保持し、WALが残ることが分かりました。PythonのGCで終了したprocessの参照を回収してから成果物を取り出すと、`preliminary-4`の短いBMCではDBが確定し、nativeの5表と作成時刻以外が一致しました。

修正後の`preliminary-5`でも両solver各6条件が期待するstatusと終了コードになりました。Web・実WASIの271件、Pythonの32件が成功しました。jobserverの検査では、OS pipe、Popen、subprocess.runを呼ぶと失敗するstubを置き、1 slotの貸出・返却と2 slotの拒否を確認しました。検査器自身の初回はsysのimport漏れで停止し、修正後に成功しています。

この段階は未commitの予備結果です。性能の採否、提出commitの確認、T6全体の完了を意味しません。実機は本リポジトリでは試していません。

## 比較器の予備実行

`p3-sby-runtime-comparison-1`では12条件すべてが基準を満たしました。各条件で11〜16個の主要成果物とSQLite全5表を照合しています。入力と設定を含む全ファイルの一覧も一致しました。これは未commitの比較器での予備試行です。比較器は全stdout/stderr、子の終了記録、nativeの元ファイル、Python資材、source snapshot、manifest、16列の生CSVを出力します。正式な全列監査を実施した結果ではありません。

再実行にはP2の固定native/WASI solverと製品用Yosys資材が必要です。solver manifestの生成は[P2の正式比較](S15-solver-native-wasi.md)を参照します。出力先は既存のものを上書きしません。

```sh
node scripts/probe-upstream-formal.mjs \
  --probes build/S15/p2-native-wasi-all-probes.json \
  --out build/S15/p3-sby-native-new
python3 scripts/build-formal-python.py --out build/S15/p3-sby-assets-new
node scripts/probe-formal-sby.mjs \
  --sources build/S15/p3-sby-assets-new \
  --probes build/S15/p2-native-wasi-all-probes.json \
  --synth build/synth \
  --baseline build/S15/p3-sby-native-new \
  --out build/S15/p3-sby-comparison-new
```

SQLite読取り器の3件では、作成時刻だけの差は同じ論理行となり、statusの変更は残ること、欠落・破損・未確定のWAL・外部キー違反・未知の表を拒否することを確認しました。読取りでDBのbyteが変わらないことも検査します。子processの4件では通常の非ゼロ終了と、改変・hash不一致・取消・crash・輸送破損を分けて検査しました。初回は単体fixtureのisolation指定と必須optionの不足、その後は期待するファイル一覧の順序を誤って失敗しました。fixtureだけを修正し、製品の拒否条件や比較を緩めていません。

## 清浄な実装commitの予備確認

`ca0ac68003a33c925d01ae588897c26489050f92`からnative基準とPython資材を再生成し、両solver各6条件を再実行しました。双方のmetadataのworktreeは空で、保存した実行コードのsnapshotも同commitと全バイト照合しました。12条件すべてで上記の分類と主要成果物・SQLiteが一致しています。同commitでWeb・実WASI275件とPython35件も成功しました。これは正式反復や全列の独立監査を実施した結果ではありません。

Nodeはv24.21.0、native Pythonは3.12.13、Pyodide packageは314.0.7です。実バイナリーの版表示でYices 2.7.0とGMP 6.3.0、Z3 5.3.3をnative/WASI双方で確認しました。Yosys nativeは0.70、git sha1 28ba3cb92です。solverはP2のclean build、Yosysは製品用資材を使い回し、起動時にbinary・shareのhashを照合しました。OS・CPU・memory・submodule statusは同じVMで試行後に採取したmetadataへ記録し、計測時点の負荷や性能値とは扱いません。

[生CSV](S15-sby-runtime-preliminary.csv)全12行16列、入力・全log・全成果物・source snapshot・stageしたPythonとlicense、初期の失敗と修正後の試行を、証拠ZIP `S15-sby-runtime-evidence-ca0ac68.zip`に保全しました。[全2,624ファイルの目録](S15-sby-runtime-files.csv)をZIPの再読込みでsize・SHA-256照合し、[ZIPのSHA-256](S15-sby-runtime-evidence.sha256)も保存しています。実行用の別名であるnative solverのsymlinkは除外し、実バイナリーのhashと版表示はmetadata・version logに保持しました。証拠のhash照合とproofの独立検査は別です。JNY・JUnit・root logの全フィールド比較、正式反復、負の対照と元回路の反例検査は引き続き残件です。
