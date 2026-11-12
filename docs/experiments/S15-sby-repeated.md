# S15: 原本SBYの正式反復とA/A照合

対象はT6 P3の計測です。上流SBYからYosys・SMTBMC・Yices2/Z3を呼ぶnative/Pyodideの全12条件を、同じ版・同じ入力で繰り返します。[全成果物の独立監査](S15-sby-artifact-audit.md)で使った既知差だけを正規化し、反復間でも全成果物の内容が同じになるか確認します。[実験の索引](README.md)へ戻れます。

## 実行前に固定した基準

| 項目 | 固定する内容 |
|---|---|
| 仮説 | process境界の差で、SBYの判定・終了・成果物の意味は変わらない |
| 条件 | Yices2/Z3 × BMC深さ内PASS、BMC反例、prove UNKNOWN、prove PASS、cover到達、cover未到達 |
| 計測器の事前確認 | A/Aを2回。その後に正式5回。全12条件を各回欠落なく実行する |
| 採否 | 全7組が成功し、native/Pyodideで全成果物・16列・全SQLite列・再帰的終了が一致する。未知差は0件 |
| 反復間の採否 | 同じ12条件の正規化後の全成果物hashが、A/Aと正式5回の間で全て一致する |
| 時間 | nativeとPyodideの有限かつ正の実測時間を保存し、正式5回の最小・中央値・最大を出す。高速化の採否基準にはしない |
| 中止 | A/Aまたは反復の差を検出した時点で後続を止める。失敗・log・既存の証拠は消さない |
| 除外しないもの | ordinary engine nonzero、UNKNOWN、cover未到達を失敗した測定として除かない。期待した意味・終了コードと照合する |

1組はnative全12条件、その直後に対応するPyodide全12条件です。nativeを先に生成するのは、各回固有の比較基準が必要なためです。別の最適化候補を比較する実験ではなく、実行順を使った速度の優劣は主張しません。時間にはworkerの起動・資材読込み・process・成果物回収が含まれます。

期待値は[既存6条件の表](S15-sby-artifact-audit.md#固定条件と実行前の基準)と同じです。各回268成果物、全7組で1,876成果物を比較します。A/Aは24行、正式は60行で、合計84行です。元の16列に`phase`・`iteration`・`nativeElapsedMs`を足した19列を、生の証拠から独立に作り直します。経過時間を除いた全成果物hashの一致は、時間そのものの一致を意味しません。

## 固定する版と入力

SBY/Yosys/Clickのpin、Yices2/Z3のビルド済みnative/WASI、Yosysのnative/WASI/shareは[接続層の実測](S15-sby-runtime.md#清浄な実装commitの予備確認)と同じものを使います。比較前には独立監査で実入力binaryとmetadataのSHA-256を照合し、source/pin/patchとPython資材のhashも調べます。binaryを作り直す候補比較ではありません。

実行版は、この事前基準と計測器を含む清浄なcommitへ固定します。runnerは開始時・各processの前後・完了時にcommitと空のworktreeを確認し、版や保存済みsourceが変わった場合は成功としません。実行中のスクリプトは編集しません。`plan.json`へcommit・runner hash・OS・CPU数・メモリー・引数・指定した環境変数を保存し、各組のmetadataへ実Node/Python/Pyodide・pin・binary hash・source snapshotを保存します。

## 再実行

前提は[SBY接続層の準備](S15-sby-runtime.md#比較器の予備実行)と同じです。native solverを含むprobe manifestとYosys資材が必要です。出力先は存在しない新しいパスを使います。

```sh
git status --porcelain
python3 scripts/build-formal-python.py --out build/S15/p3-sby-campaign-assets
python3 scripts/measure-formal-sby.py \
  --sources build/S15/p3-sby-campaign-assets \
  --probes build/S15/p2-native-wasi-all-probes.json \
  --synth build/synth --out build/S15/p3-sby-campaign
python3 scripts/measure-formal-sby.py \
  --out build/S15/p3-sby-campaign --audit-only
```

runnerが最初に2回のA/Aを実行し、その後の5回を正式反復として分けます。nativeとPyodideの両probeへ`--formal`を渡し、既存の予備測定と区別します。このflagだけで成功とはしません。全12条件の独立監査を各回実施したうえで、別の集計経路から19列・全84行・全反復のhash・時間統計を照合します。

`aa-1`・`aa-2`・`run-1`から`run-5`の各directoryにnative・Pyodideの元の証拠と実行logを置き、元の値を残します。終了後に`all-independent-audits.json`、`results.csv`、`summary.json`、実際に実行した`commands.json`を追加します。失敗時は`failure.json`を追加し、成功のsummaryへ置き換えません。元の証拠が必要なので、`--audit-only`は集計CSVとsummaryだけでは実行できません。

## 計測器の対照と範囲

全成果物・16列・SQLite・transportの個別の改変は[独立監査のunit対照](S15-sby-artifact-audit.md#計測器の負の対照)を維持します。反復の監査には、回の欠落、scheduleの型違い、版・runner hashの違い、dirty状態、予備/正式の混在、集計CSV・summaryの改変を加えます。native/Pyodideの1組としては一致するが、他の回とは入力が違う場合も拒否します。

これは実SBYを動かす計測器と正式反復の層です。workerの全異常対照とwitness変換の実境界、元回路の反例検査、製品の配布・画面統合、CI全体は別の残件です。Tang Nano実機では本リポジトリで試していません。

## 結果

清浄な`3a5c4b33e2b8181721c9a6e9e837220534f82672`で全7組が成功しました。実行前の基準からの変更や、破棄した正式試行はありません。実行した版でWeb/実WASI 272件・Python 49件が成功した後に、A/A 2回、正式5回を順に実行しました。

[生CSV全84行19列](S15-sby-repeated-3a5c4b3.csv)を、全7組の元の結果・metadata・全1,876成果物・SQLite・transportから独立に作り直して一致を確認しました。CSVのSHA-256は`6a77fb68181a9d87841e58e86cac110fdf0ffa6cceedf4c278a07d6d09478740`です。全12条件の正規化後の全成果物hashは、A/Aと正式5回で一致しています。[全時間統計とhash](S15-sby-repeated-3a5c4b3.json)も保存しました。native/Pyodideのroot・Yosys・SMTBMCのlogを全回調べ、warning・error・traceback・unsupportedの診断は0件でした。期待したSMTBMC phaseのFAILとSBYのUNKNOWN/FAILは、診断0件とは別に全回で検査しています。

### 正式5回の時間

単位はmsで、各欄は最小 / 中央値 / 最大です。表示だけ小数3桁に丸め、元の値は生CSVへ保持しました。これはこの環境の端から端までの時間で、browser UIや実機の値ではありません。

| solver | 条件 | native | Pyodide/WASI |
|---|---|---:|---:|
| Yices2 | bmc-prefix | 198.213 / 227.038 / 247.963 | 4328.462 / 4361.420 / 5819.489 |
| Yices2 | bmc-violation | 194.937 / 233.820 / 257.753 | 4247.525 / 4291.595 / 5718.592 |
| Yices2 | prove-inconclusive | 242.336 / 286.207 / 319.284 | 5537.308 / 5889.712 / 6935.390 |
| Yices2 | prove-invariant | 265.108 / 265.965 / 314.668 | 5726.665 / 5806.493 / 6686.047 |
| Yices2 | cover-reached | 196.383 / 210.484 / 250.264 | 4181.756 / 4331.216 / 4883.367 |
| Yices2 | cover-unreached | 196.395 / 199.921 / 244.944 | 4257.240 / 4325.367 / 4470.819 |
| Z3 | bmc-prefix | 209.049 / 212.856 / 255.962 | 4343.731 / 4515.266 / 4679.846 |
| Z3 | bmc-violation | 209.547 / 218.881 / 291.247 | 4435.604 / 4586.485 / 4644.941 |
| Z3 | prove-inconclusive | 266.730 / 284.890 / 386.587 | 6028.563 / 6152.433 / 6462.076 |
| Z3 | prove-invariant | 268.091 / 279.398 / 445.434 | 6004.242 / 6061.206 / 6267.742 |
| Z3 | cover-reached | 207.394 / 223.851 / 375.138 | 4429.868 / 4435.345 / 4455.161 |
| Z3 | cover-unreached | 206.169 / 219.328 / 395.440 | 4348.477 / 4467.221 / 4565.048 |

OSはLinux 6.8.0-1061-aws x86_64、glibc 2.35、論理CPU数は2、`MemTotal`は8,132,568 kBでした。Node v24.21.0、native Python 3.12.13、Pyodide package 314.0.7です。各回でsource/pin/patch、native/WASI binary、runtime版の全一致を確認しました。個々の環境と引数・元の値は`plan.json`と各回のmetadataに残しています。

### 保全した証拠

各回の目録を、[A/A 1](S15-sby-repeated-aa-1.files.csv)、[A/A 2](S15-sby-repeated-aa-2.files.csv)、[正式1](S15-sby-repeated-run-1.files.csv)、[正式2](S15-sby-repeated-run-2.files.csv)、[正式3](S15-sby-repeated-run-3.files.csv)、[正式4](S15-sby-repeated-run-4.files.csv)、[正式5](S15-sby-repeated-run-5.files.csv)へ分けました。[共通の計測器・資材・log・集計](S15-sby-repeated-common.files.csv)も保持し、1 CSVを1 MB未満にしています。

全7,411ファイルの元のサイズは合計1,021,832,101 byteです。同じbinary等をSHA-256で重複排除し、1,459個のobjectと元の相対path・サイズ・hashの対応表をZIPへ保存しました。native起動用symlinkは含めず、各回の入力binaryの実体は保持しています。ZIP内の`restore.py`が空の出力先へ全pathを復元し、1件ずつサイズとhashを検査します。

```sh
unzip S15-sby-repeated-evidence-3a5c4b3.zip restore.py README.txt
python3 restore.py S15-sby-repeated-evidence-3a5c4b3.zip evidence-restored
python3 evidence-restored/scripts/measure-formal-sby.py \
  --out evidence-restored/build/S15/p3-sby-campaign --audit-only
```

`S15-sby-repeated-evidence-3a5c4b3.zip`は45,452,961 byte、SHA-256は`d8b7f2cdd8b8ac34210e4410bf09aa0e1ac35b22f199b370615ed524ac67585b`です。実際にZIPから全7,411ファイルを別directoryへ復元して全件再hashし、復元した計測器だけで全7組・84行・19列・1,876成果物の独立監査が通りました。ZIPはチャットで渡し、repositoryにはCSV・時間統計・目録と本記録を保存します。

### 採否と残件

事前基準を満たしたため、原本SBYのこの12条件についてprocess境界と成果物回収の接続を採用します。これはBMCのPASSを証明へ昇格させる根拠ではなく、source pinとこの条件集合を超えた全回路の正しさも意味しません。worker異常対照、witnessの実変換、元回路の反例検査、製品の配布・画面統合、CI全体は引き続き残件です。

その後の[worker異常対照](S15-sby-controls.md)と[witness変換](S15-sby-witness.md)では、別の清浄commitで各5回とA/A 2回を完走しました。当時の本記録は保持し、新しい生CSV・証拠・採否をそれぞれの記録へ分けています。元回路の反例検査、製品の配布・画面統合、CI全体は引き続き残件です。
