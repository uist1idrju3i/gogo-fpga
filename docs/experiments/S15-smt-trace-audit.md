# S15 SMT記録の独立監査と正式反復

状態はこの監査層の検査完了です。元Verilog/VHDLでの反例の独立再実行、P5の画面接続、P6の製品認定とは区別します。[出力境界の実装と事前基準](S15-smt-original-replay.md)から続く記録です。

## 目的と固定条件

比較器の `matched` を信用せず、CSV/JSON全17列をraw evidenceから計算し直します。記録したsignal・clock・sample・終端から上流 `MkVcd` のVCD全bytesを再生成でき、native/Pyodideと記録なし/ありの4経路が一致する、という仮説を調べました。SMT応答の解析・proof semantics・property評価は移植しません。

測定commitは `ac635596c34652af1b01a52d00ed297e496f0425` です。計測器・独立監査器・改変対照を先に固定し、清浄な同じcommitからA/A 2回と正式5回を測りました。実行中のscriptは変更していません。

hostはUbuntu 22.04.5 LTS、Linux `6.8.0-1061-aws`、x64、Intel Xeonの2 CPU、memory 8,327,749,632 bytesです。実版はNode `v24.21.0`、Python `3.12.13`、Pyodide `314.0.7` でした。全submodule状態、source snapshot、command、host、実版、worktree状態は各組のmetadataに保存しています。solver binaryは前段の認定品を再利用し、今回のcommitから再ビルドしたとは扱いません。

| solver | 固定source |
|---|---|
| Yices2 | `85cf17e44eac76b5d14b297c09fc9bfecf47ef65` |
| Z3 | `430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e` |
| Bitwuzla | `8d1eb01093ae54d9b4586456b69c3bf31000a4c2` |
| Boolector | `393cdfba3735d334bb4e6525500b8a0280dd41e6` |

全8 native/WASI binaryのSHA-256は[証拠概要](S15-smt-trace-evidence.json)へ保存しました。監査器は実binary全bytes、native起動名と解決先、native/WASIのsource・build metadata、patch・asset・license/origin情報を照合します。Bitwuzlaのhelp childとSMT childは別に扱い、Boolectorの実終了code 10/20を保持します。両候補の製品catalogは `modes: []` のままです。

## 事前基準と実行

事前基準は、[元記録の受入れ表](S15-smt-original-replay.md#結果を見る前の受入れ基準)と[独立監査の基準](S15-smt-original-replay.md#独立監査と反復の基準)です。各solverの8条件についてnative/Pyodideと `smtbmc`/`formal_trace` を揃え、元model・VCD・YW・testbench・stdout/stderr・実終了code・記録JSONを照合します。stdoutは上流の経過時刻だけを除いて比較し、raw streamとそのhashも残します。

```sh
python3 -B scripts/measure-formal-trace.py \
  --sources build/S15/smt-trace-python-assets-formal-01 \
  --probes build/S15/smt-trace-all-probes.json --out build/S15/smt-trace-formal-02
python3 -B scripts/measure-formal-trace.py --audit-only --out build/S15/smt-trace-formal-02
python3 -B scripts/negative-formal-trace.py build/S15/smt-trace-formal-02/run-1/default/trace \
  --out build/S15/smt-trace-negative-formal-default-01
```

追加候補は最後のcommandのgroupと出力先を別にし、`--solver bitwuzla` または `--solver boolector` を明示します。probe一覧・元Python資材の作成方法は元記録を参照してください。既存の出力先は上書きしません。

## 正式結果

| group | A/A行 | 正式行 | 合計 | 全列監査 |
|---|---:|---:|---:|---|
| Yices2/Z3 | 128 | 320 | 448 | 成功 |
| Bitwuzla | 64 | 160 | 224 | 成功 |
| Boolector | 64 | 160 | 224 | 成功 |
| 合計 | 256 | 640 | 896 | 成功 |

[生CSV](S15-smt-trace-audit.csv)は `series`・`iteration` と元17列の計19列です。SHA-256は `4642a7c5597d404a4ab8139bcc0b59775ee27c0cb54d2e3c43077c96ef804a9f` でした。全896行が `matched`、errorなしで、反復間のsource・binary・runtime identityと意味的なbytesも一致しました。記録した値から再生成したVCDが元VCDと一致することも各行で監査しています。ただし元回路での独立replayではありません。

[時間集計CSV](S15-smt-trace-timings.csv)には128条件それぞれの正式5回の最小・中央値・最大を保存しました。全cellを元の行から再計算しています。A/Aは時間集計に混ぜず、両方の組で意味的hashが一致することを確認しました。性能の優劣や製品の応答時間を認定する測定ではありません。

正式証拠への改変対照は、既定2候補56件、Bitwuzla 57件、Boolector 57件の計170件を拒否し、原状へ戻した後の監査も成功しました。CSV/JSON全17列、childの引数・hash・実終了code・policy・identity・stream分離、輸送整合性、欠落/重複行、重複JSON key・非有限値、危険なasset path、VCDと記録値を変えています。Bitwuzlaのchild順序とBoolectorのSAT/UNSAT終了codeも別に変えました。symlink root/経路要素とcapture schemaの境界はPython単体で検査しています。

## ZIPと復元後監査

測定commitとは別に、packagerのcommit `cdcaae6d5730bb3833245e87b17959f0092531c4` でZIPを作りました。計測器・独立監査器・probe・記録器は測定commitから変更していません。

起動用のsymlinkはcheckout外の認定native binaryを指すため、`--stage` でmetadataのcommand path・SHA-256が一致したものだけを通常fileへ複製しました。元証拠は変更せず、検査用の起動先を移したとも扱いません。元pathとhashの対応を `staging.json` へ残しました。未知のlink、親のlink、既存の出力先、重なる入力は拒否し、archiveの外部path拒否は維持しています。

```sh
python3 -B scripts/package-extra-formal.py --stage --output build/S15/smt-trace-staged-01 \
  --include build/S15/smt-trace-formal-02
python3 -B scripts/package-extra-formal.py \
  --campaign build/S15/smt-trace-staged-01/build/S15/smt-trace-formal-02 \
  --include build/S15/smt-trace-staged-01/staging.json \
  --output build/S15/smt-trace-evidence.zip
python3 -B scripts/package-extra-formal.py --restore --output build/S15/smt-trace-evidence.zip \
  --campaign build/S15/smt-trace-restored-new
```

この例は正式campaignだけを保存する最小commandです。実際の `smt-trace-evidence-ac63559-02.zip` には改変対照、予備証拠、失敗試行、実行log、分類目録とpackager原本も加えました。全入力のstage commandはZIP内の `smt-trace-staging-command-01.json`、選択した追加対象はmanifestで確認できます。復元先は未作成の名前を指定し、復元器が空のdirectoryを作ります。

ZIPは33,453,906 bytes、18,753 files、2,828個の重複除去後objectです。SHA-256は `f646a45d4d84245bdb941d2508e36a1b826e6df0f139f6cf07a38465b9fe48c4`、manifestのSHA-256は `429037ee1e7605d7f323846d4c1767840ef06458342f0a2bb07998a1182e3b62` でした。

新しい復元先 `smt-trace-restored-03` へ全fileを戻し、長さとSHA-256を全件照合しました。復元したsnapshot内の計測器・監査器・上流 `MkVcd` による再監査でも全896行19列が成功しました。計測器が保存した監査closureは現在の固定sourceとも一致します。改変対照は終了codeとraw logのhashを再確認し、原状復帰した3組も復元した監査器で別に監査しています。

## 失敗と予備証拠の分離

元記録の予備128行と測定前の改変対照170件は正式結果へ混ぜません。ZIPの `smt-trace-evidence-index-01.json` で正式成功、正式証拠への改変対照、予備、失敗を分類しました。

初回正式試行 `smt-trace-formal-01` はcommit `4ec0983e4a4476e56538f37c8fff7200040ab697` の64行を生成後、監査器が起動名 `yices-smt2` と本体名 `yices_smt2` を同一視して停止しました。修正前の失敗証拠として全体を保存し、成功行数へ含めません。修正commitから全反復をやり直した結果が今回の896行です。

ZIPの初回commandは追加対象の相対path処理で停止し、logを保存しました。相対pathを絶対pathへ揃える修正と単体を追加して再実行しました。最初の復元呼出しでは既存の空directoryを指定して拒否され、未作成の名前でやり直しています。改変対照の追加再監査ではcloneのfolder名を誤指定して停止し、実際の `mutated-evidence` を指定して再実行しました。これらを成功監査とは扱いません。

## 残件

task 53/54の元Verilog、元VHDL/PSL、下位化Verilogへの接続と反例の独立再実行、SAT/SMT/witness種別、N-1/N/N+1、clock/reset/初期値、property/assumption保持は後続です。P5のschema4・ZIP/OPFS・formal worker・result/VCD画面、P6の製品反復・配布closure・T4/T5回帰・CI全体も未完了です。Bitwuzla/Boolectorは有効化せず、T6全体の完了とは扱いません。
