# S15: 追加solverのSMTBMC/SBY独立監査と反復

[実験索引](README.md) / [接続層と固定資材](S15-extra-solver-smtbmc.md)

## 目的と対象

Bitwuzla/Boolectorを原本SMTBMC/SBYへ接続した結果を、生のstream、成果物、process記録から独立に検査します。検証の意味やSMT応答の解析は変更しません。製品での有効化、元HDLによるSMT反例の独立再実行、画面統合は別の認定です。両候補を製品catalogでは無効のままにします。

この記録は監査器と計測器の検証を扱います。資材のsource、build commit、コンパイラー、binary hashは[接続層の資材表](S15-extra-solver-smtbmc.md#資材)と前段のCLI認定記録を参照します。ここでは同じbinaryを再利用し、再ビルドしません。

## 事前基準

正式試行は `measure-extra-formal.py` を含む清浄なcommitを固定して実行します。先にA/Aを2回、続けて正式試行を5回実行し、各回でBitwuzla、Boolectorの順に交互に測ります。1候補につきnative参照、SMTBMC、SBY、異常対照を逐次実行します。途中で失敗した場合は停止し、同じ出力先を再利用しません。

| 対象 | 1候補・1回の条件 | 合計行数 | 全列数 |
|---|---|---|---|
| SMTBMC | 6 fixture、proveをbasecase/inductionへ分けた8条件 | 112 (A/A 32、正式80) | 15 |
| SBY | BMC/prove/coverの6条件 | 84 (A/A 24、正式60) | 19 |
| 異常対照 | 通常3、異常8、制限5の16条件 | 224 (A/A 64、正式160) | 14 |

SMTBMCの `phase` は上流の実行段階です。反復の種類は別の `series` 列へ保存し、取り違えません。異常8条件は取消、期限切れ、rootの異常終了、壊れた終了通知、破損差分、競合差分、構文エラー、未許可の終了codeです。制限5条件はautotune、並列jobs、jobserver、temporary、linkです。

全行のstatus/error、終了code、SMT log、stderr、VCD、YW、testbench、SQLite、model/solver/Yosysのhash、輸送記録を検査します。SBYは全成果物とSQLite全5表を検査し、記録している環境差だけを正規化します。SMTBMCとSBYの期待行数、全列、一意な条件の集合は既定のYices2/Z3から緩めず、追加候補を明示したときだけ切り替えます。

反復間では、source、solverとYosysのbinary、Node、Pyodide、native Python、計測器のsnapshotが一致することを必須にします。SMTBMCの終了と主要出力hash、SBYの正規化後の全成果物、対照の分類が全反復で一致しなければ不採用です。正式5回の時間は各条件の最小値・中央値・最大値を保存し、A/Aの時間を混ぜません。これらはVM上の検査であり、実機性能の値ではありません。

ZIPから未使用の場所へ証拠を復元し、全ファイルのhashと保存した監査器による再監査を必須にします。CSVの改変、欠落した成果物、異なるsolver hash、偽の成功状態を拒否する負の対照も必須です。これらが揃う前に正式認定とは扱いません。

## process境界の検査

Bitwuzlaは実WASIの `--help` と `--lang smt2` の2子processを要求し、順序、binary hash、実際の終了code、stderr、資源記録を照合します。helpの文字列を代わりに生成しません。

Boolectorは既定の `[0]` を広げず、明示した `[0, 10, 20]` と実codeを検査します。fixtureと段階から、最後が充足なら10、不充足なら20であることも照合します。BMCの違反、coverの到達、proveの帰納段階の不成立を同じ成功とは分類しません。

構文エラー対照は、検査専用workerがWASIの実 `fd_read` で最初の入力byteだけを `?` へ変えます。変更前後のbytesとhash、実solverの診断と終了1を保存し、trapと区別します。未許可code対照は、正常に実行したsolverの実codeと、検査用に9へ変えた通知を両方保存します。いずれも製品コードにはfault注入を追加しません。通常のFAIL/UNKNOWNと区別し、成果物や検証済みのPASSを公開しないことを検査します。

SMTBMCの正式証拠には、native参照のmetadata、native実行先とbinary本体、WASI本体を追加保存します。JSONの重複key、非有限値、証拠パスの途中のsymlinkも拒否します。容量を抑えるため、完了済み試行の同一入力を全byte照合後にhardlinkで共有します。内容を変えたり、symlinkで監査を迂回したりはしません。

## 監査器の予備検査と失敗

接続commit `82a37a7db556647de54c95e8ace9c19cbc5915ff` の既存予備記録を、新しい明示的solver選択で監査しました。SMTBMCは全16行13列、SBYは全12行16列が通っています。これは予備データの独立監査であり、正式反復の結果ではありません。

構文エラーと未許可codeの予備対照では、両候補で `runtime-error` と空の成果物を確認しました。初回の検査用観測メッセージは、detailの `type` が輸送用の `type` を上書きし、solver終了を `protocol-error` にしていました。`resultType` へ分離し、初回は除外しました。修正後は実parserの診断と終了1、正常codeから9への変更をそれぞれ記録できています。

全対照の予備03は、同じ作業コピーへのファイル追加でGitの状態が開始時から変わり、最終gateで停止しました。途中の16行が揃っていても、CSVと最終検査がないため採用しません。試行中の出力は削除せず保存し、次の検査はcommit後の固定した状態で行います。

commit `cee9eb0` の最初の正式計測は、A/A 2回と正式1回目のBitwuzlaまで個別監査を通過し、Boolectorの期限切れ対照で停止しました。設定15,000 msに対して `elapsedMs=14999.991565`、`status=timeout`、`error=null` を記録しています。全workerは停止し、成果物は空でしたが、設定より0.008435 ms早いため、期限到達の監査を通しませんでした。出力は `build/S15/p4-extra-formal-campaign-cee9eb0-01` に保持し、途中の成功を正式5回の結果へ混ぜません。

[Nodeのtimer](https://nodejs.org/docs/latest-v24.x/api/timers.html#settimeoutcallback-delay-args)は、callbackの正確な実行時刻を保証しません。修正では監査の許容幅を広げず、rootのtimer callbackで単調時計を確認し、残り時間が正なら切り上げた時間だけ再待機します。期限後だけ `timeout` へ遷移し、取消後の古いcallbackでは再待機しません。同じ早着時刻を与える単体検査を追加しました。solverや検証の意味は変えず、新しい清浄commitからA/Aと正式試行をすべてやり直します。

commit `5855050` の再試行は、A/A 2回と正式5回の全14組で個別監査を通過しました。しかし最終集計で、SMTBMCの版名が `pyodide` であるのに `pyodidePackage` を参照して停止しました。出力は `build/S15/p4-extra-formal-campaign-5855050-01` に保存し、正式結果として採用しません。単体fixtureも誤った共通キーを持っていたため、実際の3形式へ修正しました。SMTBMCの正常なJSON行では `error` が省略されることも分かり、独立監査済みの省略・空文字だけを集計の空欄へそろえ、非空のerrorは拒否します。

再試行前に、保存した14組の実行結果とmetadataを使う合成の集計fixtureで、全CSVと5標本の統計まで検査しました。集計用headerだけを新しい監査器に合わせ、個別監査の戻り値を検査済みの原本から与えるため、このfixtureは正式証拠ではありません。初回fixtureでも省略errorによる停止を記録し、修正後は112/84/224行の再構成と読み戻しが通りました。いずれも `build/S15/p4-extra-audit-aggregate-real-fixture-5855050-*` に保持し、正式計測は新しい清浄commitで再び全反復を行います。保存した正式証拠のheaderや監査器は書き換えません。

`negative-extra-formal.py` は、正式campaignの原本を変更せずに別のコピーで20件の改変を検査します。両候補の成果物・本体・hash・輸送のintegrity・欠落・余剰を各6件、3表のCSV status/errorを各2件、保存した監査器と集計結果を各1件変更します。各回の標準出力・標準エラー・終了code・変更前後のhashを保存し、前後の未改変状態がどちらも監査を通ることを要求します。hardlinkを共有していても変更先は別inodeへ置き換え、原本へ変更を伝えません。

## 再実行

前段で照合した各候補のnative/WASI buildを、診断manifestの `native` と `wasi` へ指定します。solverを指定しない従来のprobe/auditの既定対象はYices2/Z3のままです。次の計測器だけが追加2候補の全条件を要求します。

```sh
python3 scripts/build-formal-python.py --out build/S15/extra-audit-python
python3 scripts/measure-extra-formal.py \
  --sources build/S15/extra-audit-python \
  --probes build/S15/extra-probes.json --synth build/synth \
  --out build/S15/extra-formal-campaign
python3 scripts/measure-extra-formal.py \
  --audit-only --out build/S15/extra-formal-campaign
python3 scripts/negative-extra-formal.py \
  --campaign build/S15/extra-formal-campaign --out build/S15/extra-formal-negative
python3 scripts/package-extra-formal.py \
  --campaign build/S15/extra-formal-campaign --output build/S15/extra-formal-evidence.zip \
  --include licenses --include THIRD_PARTY_NOTICES.md \
  --include scripts/package-extra-formal.py
python3 scripts/package-extra-formal.py --restore \
  --output build/S15/extra-formal-evidence.zip --campaign build/S15/extra-formal-restored
```

ZIPは同じ内容をSHA-256のobjectとして一度だけ格納し、元の論理パス・byte数・実行権限の有無を目録へ保存します。nativeの隔離binの参照は、リポジトリー内の実体を検査して通常ファイルへ展開し、復元先にsymlinkを作りません。未知・重複・欠落したobject、不安全なパス、上限超過、異なる監査コードを拒否します。空の場所へ全byteを復元した後、保存した監査器で同じ全列監査を実行します。失敗試行を追加保存する場合は `--include` で指定し、採用したcampaignとは目録でも分けます。

監査器を実行する前にも、6つのPython原本を作業コピーとhash照合します。Pythonは `-I -B` と未使用のbytecode cache先を指定して起動し、復元物や環境変数を通じた通常importの置き換え、同梱cacheの実行を防ぎます。archiveでは `__pycache__`・`.pyc`・`.pyo` とdrive付きパスを拒否し、manifestも解析前に16 MiB以下へ制限します。負の対照の概要、script、各標準streamも `--include` を繰り返して追加できます。未改変へ戻した検査用コピーは正式campaignの代わりにしません。

計測器は全コマンド、submodule、各probeの実際の版・ホスト・資材・source・全snapshotを保存します。出力先が既存なら停止します。単体検査は `python3 -m unittest discover -s tests/check-solver-protocol`、構文検査は `node --check` と `python3 -m py_compile` です。

## 清浄commitでの正式結果

計測器と監査器を `b082702a21d4ed2b95b0fe7a12a8534d1449ffa7` に固定し、清浄な作業treeからPython接続資材を再生成しました。solverとYosysのbinaryは、前段で照合した資材を再利用しています。A/A 2回、その後に正式5回の全14組が個別監査と最終集計を通り、同じ保存証拠の `--audit-only` も成功しました。先の失敗試行や合成fixtureは混ぜていません。

ホストはUbuntu 22.04.5 LTS、Linux `6.8.0-1061-aws`、x86_64、Intel Xeon、2 CPU、メモリー8,327,749,632 byteです。Node v24.21.0、native Python 3.12.13、Pyodide 314.0.7を使用しました。資材表にある固定compilerとsolver版、全submodule、全command、snapshotとsource hashは各probeのmetadataと `plan.json` に保持します。

| 対象 | 正式行 | A/A行 | 合計行・全列 | 生CSV |
|---|---:|---:|---|---|
| SMTBMC | 80 | 32 | 112行15列 | [SMTBMC](S15-extra-formal-smtbmc.csv) |
| SBY | 60 | 24 | 84行19列 | [SBY](S15-extra-formal-sby.csv) |
| 異常対照 | 160 | 64 | 224行14列 | [controls](S15-extra-formal-controls.csv) |

各表の全cellを生の証拠から導出し、status、error、終了codeも含めて照合しました。errorは全行空です。SMTBMCの `exited` は全性質のPASSを意味しません。SBYは通常のPASS/FAIL/UNKNOWNと6種類の意味分類を維持します。異常対照の取消・期限切れ・crash・protocol/runtime errorと、正常な反例・UNKNOWNを区別し、全workerの停止を確認しました。

BitwuzlaのhelpとSMT子process、Boolectorの実終了10/20、実parserの構文エラー終了1、実codeから未許可9への変更を全反復で監査しました。native解決先、solver/Yosys/model hash、stderr、輸送のintegrity、VCD・YW・testbench・SQLite全5表、SBYの正規化後の全成果物も一致しています。SQLiteの生binary hashや実行時間まで反復一致とは主張せず、SQLiteの内容と保存hashをそれぞれ検査します。

正式5標本だけの最小・中央値・最大は[全条件の時間表](S15-extra-formal-timings.csv)へ保存しました。A/Aは時間集計へ含めません。VMのworker起動・Pyodide初期化・輸送を含む値であり、solverの探索性能やTang Nano実機の値ではありません。

### 改変対照とZIP復元

正式原本から分けた検査用コピーで改変20件すべてを拒否しました。成果物、本体・solver hash、輸送のintegrity、欠落・余剰、3表それぞれのCSV status/error、保存した監査器、保存集計を対象にしています。変更前後のbaselineはともに終了0で監査を通り、各改変は終了1です。[証拠概要](S15-extra-formal-evidence.json)に各変更の前後hash、stream hash、拒否理由を保存しました。全streamと実コマンドはZIP内の別分類の対照記録にあります。

証拠ZIP `p4-extra-formal-evidence-b082702-01.zip` は38,420,503 byte、全38,413論理ファイル、重複排除後7,461 objectです。SHA-256は `cbb86b879b089b76373cc35e2aa6b5f7773203c756ae7dfddb7c9e645b40e8e8`、manifestのSHA-256は `24a32cfc51ef767a9f99fa0367b6943295330fa96114dc62e87aeb0bbd6f32e2` です。計測・包装commitはともに上記の固定commitで、文書追記後のcommitを計測版とは扱いません。

ZIPには採用campaign、前述の失敗試行、診断fixture、改変対照、原licenseとNOTICE、包装scriptと検査を別の論理パスで同梱しました。全38,413ファイルは成功件数ではありません。未使用の空の場所へ全5,765,474,485 byteを展開し、保存した監査器で同じ全列監査を再実行しました。さらに全ファイルのbyte数・hash・modeを目録と再照合しました。容量を確保するため復元コピーだけを削除し、原本・ZIP・再監査の受領記録は保持しています。実行手順と失敗試行の分類はZIP内の `classification-and-commands.json` に保存しています。

同じ計測commitでPython 116件とWeb 273件の計389件が成功しました。後続のcatalog文言修正は、古い未ビルド・help未接続という無効理由だけを訂正し、`product-unqualified` のまま全modeで無効にします。資材の存在を申告しても両候補を有効化しない回帰検査を追加しました。

## 現在の判定

限定した原本SMTBMC/SBYの接続、全列監査、実行中停止を含む正式5回・A/A、改変対照、証拠復元後の監査は完了しました。元HDLによるSMT反例の独立再実行、製品資材の配布closure、製品worker/画面の接続と製品認定は未完了です。両候補は製品で無効のままです。Tang Nano実機は本リポジトリでは試していません。
