# S15: 原本SBYの子worker停止とファイル輸送の負の対照

[実験の索引](README.md) / [原本SBYの正式反復](S15-sby-repeated.md)

## 目的と固定条件

正常な反例・UNKNOWNと、取消・期限切れ・worker停止・壊れた輸送を混同しないことを調べます。上流のSBY・SMTBMC・ソルバーの判定処理は変更せず、検査用Node workerの境界だけで異常を注入します。前の正式反復の12条件・全成果物比較とは別の対照です。

SBY・Yosys・Click・PyodideとYices2・Z3は、前の正式反復と同じ固定ソース、パッチ、実バイナリーを使います。実行前にmanifestとSHA-256を照合し、実行に使った資材、計測器、stdout・stderr・全終了情報・全workerの起動と停止を保存します。予備値と正式値を分け、正式測定は清浄なcommitを固定します。出力の上書きは拒否します。

## 実行前の採否の基準

| 条件 | 必須の観測と期待値 |
| --- | --- |
| BMCの有界PASS | 原本SBYがPASS・終了0。輸送はexited・integrityVerified。proof成功へ昇格しない |
| BMCの反例 | 原本SBYがFAIL・終了2。輸送はexited・integrityVerified |
| proveのUNKNOWN | 原本SBYがUNKNOWN・終了4。輸送はexited・integrityVerified |
| 取消 | 実ソルバーWASIがstdinを待つ地点まで進み、rootを取り消す。cancelledで全workerが停止 |
| 期限切れ | 同じ地点で検査用workerを待機させ、rootの15,000 msの期限でtimeout。全workerが停止 |
| rootの停止 | 同じ地点で共有flagを設定し、rootの仮想pauseでNode workerを実際に終了17で停止。Nodeのexit通知をerrorへ接続し、crashedで全子workerが停止 |
| 早すぎる終了通知 | 同じ地点でrootの終了0・integrityVerified・空filesの通知を注入。活動中の子があるためprotocol-errorで拒否 |
| delta改変 | 実Yosys子の完全なdeltaを受信後、末尾の1バイトだけ改変。SHA-256の不一致を拒否 |
| root競合 | 実Yosys子のdelta適用直前にrootのモデルへ書き込み、before hashの不一致を拒否。rootを上書きしない |
| 非対応オプション | autotune、複数job、jobserver helper、一時ディレクトリ、linkを原本SBYへ渡す。所定の診断で子を起動せずに拒否 |

全条件でネイティブのsubprocess.run・Popen、Thread.start、存在するos.pipe・pipe2・fork・posix_spawnを、呼ばれたら例外を送出する検査用trapへ替えます。正常値を返す代替実装にはしません。resourceが実際にimportできないことも調べます。MAKEFLAGSへ継承jobserverを設定してから製品のbootstrapを実行し、正常終了後の値が空であることを確かめます。利用できないprocess timeは0秒へ置き換えず、原本のログの「unavailable」を確認します。

両ソルバー各9条件と、ソルバーに依存しないオプション拒否5条件を必須集合とします。ソルバーの待機点では、対応するWASMのhashと実workerの状態も記録します。取消・停止・壊れた輸送で、PASSの最終行や検証済み成果物を利用者へ返してはいけません。終了後はNodeの実exitを別に待ち、5,000 ms以内に全workerが停止することを要求します。

## 計測器と再実行

```sh
node scripts/probe-formal-controls.mjs \
  --sources build/S15/p3-sby-campaign-assets \
  --probes build/S15/p2-native-wasi-all-probes.json \
  --synth build/synth --out build/S15/p3-controls-preliminary
```

`--solver yices2|z3`と`--case NAME`で条件を選びます。正式版は`--formal`を加えます。独立監査器`audit-formal-controls.py`は、実行器の判定関数を呼ばず、生の終了情報・イベント・ファイルから全12列を作り直します。各CSV列の改変、欠落した待機・異常注入・実exit、早すぎる期限、UNKNOWNの終了0、未停止のworker、偽PASSとシンボリックリンクを負の対照にします。

正式なA/A 2回と5回の実行には次を使います。各回の23条件の後、[witnessの2形式](S15-sby-witness.md)も同じcommitで比較します。全結果を再監査し、反復間のソース・バイナリー・実行器の一致と、生CSV全14列を照合します。実行中の計測器は編集しません。

```sh
python3 scripts/measure-formal-controls.py \
  --sources build/S15/p3-sby-campaign-assets \
  --probes build/S15/p2-native-wasi-all-probes.json \
  --synth build/synth --yosys build/native/yosys \
  --out build/S15/p3-controls-campaign
python3 scripts/measure-formal-controls.py \
  --out build/S15/p3-controls-campaign --audit-only
```

正式版ではホストのOS・CPU・メモリー、Node・Pyodideの版、Pythonの実際の版、原本・パッチとバイナリーのhash、コマンド、UTCの開始時刻を保存します。ビルドを繰り返す試験ではなく、固定した既存資材を使います。5回の所要時間の最小・中央値・最大も保存しますが、期限切れや検査用待機を含む値をソルバーの性能とは扱いません。

## 結果と制約

予備検査は両ソルバー各9条件とオプション拒否5条件の全23条件で成功しました。その後の正式反復も、下記の通り完走しました。初回の不合格や中止も、後の成功で消さずに記録します。

初回のYices2予備検査では、14条件中3条件が検査用Node bridgeの不備で不合格になりました。実Yosys workerが正しい終了通知を送った後、deltaの書き出し中にNodeの自然終了0が届くと、bridgeが異常停止と誤分類していました。正常な終了通知を受け取った事実と、その後のNode exitを別に記録するよう修正します。製品の判定や採否の基準は変更しません。初回の全ログは`build/S15/p3-controls-preliminary-1`へ保全しています。

修正後の2回目は全23条件が成功しました。3回目は待機対象のSharedArrayBufferが実際のstdinのものであることと、rootの競合ファイルが改変されずに残ることも確認し、全23条件が成功しました。同じ作業コピーでWeb・実WASIの既存272件も成功しています。これらは未コミットの予備値であり、正式な同一commitの確認とは区別します。生CSV、各終了情報、全イベント、全workerの実exitと資材は、それぞれ`build/S15/p3-controls-preliminary-2`と`build/S15/p3-controls-preliminary-3`へ保存しています。

4回目は取消・期限切れ・停止・早すぎる終了通知の全条件で、実stdin待機を強制終了まで保つようにしました。待機の観測通知だけでソルバーが先に終了してしまう競争を避け、活動中であることを保証します。全23条件が成功し、全101 workerの実exit、全138出力ファイルとCSV全12列の独立監査が成功しました。証拠は`build/S15/p3-controls-preliminary-4`、監査結果は同名の`-audit.json`です。これも未コミットの予備値です。

witness用mapの最初の生成は、`formalff -ff2anyinit -anyinit2ff`という互いに排他的なオプションを同時に渡して停止しました。出力mapは生成されていません。ログは`build/S15/p3-witness-map-preliminary.log`へ保存しました。その後は上流の手順で生成し、[witnessの別記録](S15-sby-witness.md)の予備比較まで進めました。初回の失敗を変換の成功とは扱いません。

待機を使う期限切れは、ソルバー計算の速度や性能を測る試験ではありません。Nodeの終了17をerrorへ接続する試験も、ブラウザーのOOM検知を測ったものではありません。実ブラウザーの画面、配布物、実機のTang Nanoでは本リポジトリで試していません。

SMTBMCの代表条件はYWを直接生成するため、通常のSBY実行からyosys-witness子が自然に起動するわけではありません。witnessの変換境界は別のfixtureで実際に起動し、原本SBYの意味論や回路の反例検証とは分けて記録する必要があります。

## 正式5回とA/A 2回

清浄な`56219e54dc03fe1d4de98e1c572d9ddda81bd4e6`で、A/A 2回の後に正式5回を実行しました。全7組で23条件が成功し、事前基準の変更や、破棄・上書きした正式試行はありません。測定中のソースと計測器は変更していません。

[生CSV全161行14列](S15-sby-controls-56219e5.csv)は、A/A 46行と正式115行を分け、全966出力ファイル・707 workerの起動と実exit・元のstatus・イベント・stdout・stderrから作り直して一致しました。SHA-256は`081ffc2241b80e1de302fb19b44b15a0012c54e73f7479c92c67df8ac19ab020`です。通常のPASS/0・FAIL/2・UNKNOWN/4、cancelled、timeout、crashed、protocol-error、改変と競合のruntime-errorは、全回で区別したままです。

同じ7組で[witnessの2形式](S15-sby-witness.md#正式5回とaa-2回)も比較しました。こちらは全14行9列・42出力・21 workerで、上記のSBY全161行とは別に監査します。全7組でソース・commit・バイナリー・Node・Pyodide・Python・計測器・期限とwitness出力の同一性を確認しました。

OSはLinux 6.8.0-1061-aws x64、CPUはIntel Xeonの論理2 CPU、メモリーは8,327,749,632 byteでした。Node v24.21.0、Pyodide package 314.0.7、native Python 3.12.13です。全条件の正式5回の最小・中央値・最大を[集計JSON](S15-sby-controls-56219e5.json)へ保存しました。期限は15,000 msですが、workerの起動・待機と停止を含む所要時間はソルバーの計算性能ではありません。

### 証拠の保全と再監査

元の相対path・サイズ・SHA-256を、[A/A 1](S15-sby-controls-aa-1.files.csv)、[A/A 2](S15-sby-controls-aa-2.files.csv)、[正式1](S15-sby-controls-run-1.files.csv)、[正式2](S15-sby-controls-run-2.files.csv)、[正式3](S15-sby-controls-run-3.files.csv)、[正式4](S15-sby-controls-run-4.files.csv)、[正式5](S15-sby-controls-run-5.files.csv)、[予備・失敗試行](S15-sby-controls-preliminary.files.csv)、[共通資材と計測器](S15-sby-controls-common.files.csv)へ分けました。1 CSVは1 MiB未満です。

全6,158ファイル、元のサイズ1,117,151,581 byteを、SHA-256による重複排除で1,668 objectへ保存しました。`S15-sby-controls-evidence-56219e5.zip`は31,461,003 byte、SHA-256は`be04adae984dc238de1c159b11f682eeb614de6242665209bc128f7b41816edf`です。native起動用のsymlinkは含めず、入力binaryの実体は残しています。

```sh
unzip S15-sby-controls-evidence-56219e5.zip restore.py README.txt
python3 restore.py S15-sby-controls-evidence-56219e5.zip evidence-restored
python3 evidence-restored/scripts/measure-formal-controls.py \
  --out evidence-restored/build/S15/p3-controls-campaign --audit-only
```

実際にZIPから別directoryへ全6,158ファイルを復元して全件のサイズ・hashを再確認し、復元したPython計測器だけでSBY全161行14列とwitness全14行9列の独立監査が成功しました。ZIPはチャットで渡し、repositoryには生CSV・集計・目録と本記録を残します。

### 採否と残件

事前基準を満たしたため、この23条件の停止・輸送・制限の扱いを採用します。原本の判定処理や不合格条件を緩めたものではありません。SBY実行から自然にwitness子が起動した証拠、回路の反例の独立再実行、製品の配布・画面統合、CI全体、実機のTang Nanoは別の範囲です。
