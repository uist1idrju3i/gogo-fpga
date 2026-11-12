# S15 P2 実ソルバーの応答と終了の比較

- 状態: この文書は事前基準と予備検査の履歴。正式反復は[別記録](S15-solver-native-wasi.md)で329行・全31列を監査済み
- 関連: [実験索引](README.md)、[buildと輸送の記録](S15-solver-build-and-transport.md)、[ソルバー調査](../research/formal-solvers.md)

Z3 WASIのlink失敗後、SDKの例外library、fork登録と単一threadのyieldを切り分けた手動診断18条件は成功しました。[link診断とclean buildの再実行](S15-z3-wasi-link.md)へ詳細を残します。これは未コミットのshimと手動linkによる予備結果であり、正式なnative/WASI比較の結果ではありません。

## 目的と仮説

固定sourceからbuildしたYices2とZ3のCLIを、native processと実WASI workerで実行します。JavaScriptへSMT-LIBの意味解析を移植せず、上流の応答を字句framerで区切り、同じsolverの両系で全byteを比較します。Nodeのisolation flagは検査用のfixtureであり、ブラウザーのCOOP/COEPや画面統合の確認ではありません。

## 正式反復前の基準

以下は予備調査を踏まえ、正式反復より前に固定します。正常・異常とも各条件5回以上、A/Aは2回とし、nativeとWASIの順は反復ごとに交互にします。重い実験はCIへ追加しません。

1. bit-vectorとarrayで、sat、値の取得、push後のunsat、pop後のsat、modelを同じprocessで確認する。
2. 32,768 bitの一意な値を取得する。7 byteの通常buffer、3 byteずつの入力に加え、長い値では257 byteのbufferと50 msのconsumer遅延でbackpressureを通す。
3. 通常条件のstdout、stderr、frame列、終了分類と終了コードを、native/WASIとA/Aで完全一致させる。改行や数値表記は正規化しない。
4. 構文エラーはerror応答として検査し、終了コード0でも論理判定の成功にしない。要求した応答がEOFまでに来なければ拒否する。
5. 実応答を受け取った後のtimeout、cancel、古いjob IDの通知、終了通知の欠落、出力上限を別々に検査する。入力待ちの停止とは別に、計算中のtimeoutとcancelも検査する。破損WASM、hash不一致、worker起動時のcrashは、実solverの判定を実行したとは書かない。
6. Yices2のalarmの非対応要求は非ゼロ終了とstderrの明示診断を要求する。Z3のunknownはsat/unsatに置き換えない。hardware丸めはnativeの成功対照とWASIの明示拒否を分け、通常のSMT浮動小数点理論は別条件で両系を比較する。
7. stdout、stderr、frame、終了コード、終了分類、signal、framing errorを一つずつ壊した負の対照で、比較器が全て拒否することを確かめる。
8. 固定source、build script、patch、SDKとGMP archive、binary、stdout、stderr、frameのhashを保存する。nativeの最大RSSとWASMのlinear memoryは異なる指標として記録し、欠測を0で補わない。

失敗したprocessから得た途中のbyte数は、停止のタイミングで異なり得ます。正常応答の完全一致とは混同せず、失敗の分類と、成功を偽装しないことを検査します。時間とメモリーは絶対値と最小・中央値・最大を保存します。正しさの採否を所要時間で緩めません。

## 固定条件と実装

solverの固定版とprofileは[buildの記録](S15-solver-build-and-transport.md)を正とします。予備Yices2は、清浄な`537a140b4ba4e233af6606a78071e80e08ce858b`で作ったnativeとWASIを使います。nativeのSHA-256は`03ed31aadc9fcdb02864fa68785fddfbcfd28051cadd8c509128093403dfa3de`、WASIは`478fcb7fe5b3baa45420d2fb7087ae8508850cdb824a9968d871df13de66f7ad`です。Z3のnativeも同じ清浄なcommitからbuildを完了しました。WASIのbuildは続いており、WASIの成功とは扱いません。

比較器は`tests/synth/solver-protocol-helpers.mjs`と`solver-protocol-cases.mjs`、記録器は`scripts/measure-solver-protocol.mjs`です。metadataでsource pin、清浄なbuild、現行scriptとpatch、artifactのsizeとhashを照合します。通常CIには小さな比較器とmetadataの負の対照だけを追加し、実solverの反復には明示したmanifestを使います。正式記録器は未commitの変更や既存の出力先を拒否します。

### 計算中の停止とZ3の数値計算の境界

計算中の条件では、最初に実solverのsat応答を受け取ります。その後、7 bitの変数80個を79種類の値に制限し、全て異なる値を要求するSMTを送り切ります。100 ms待った後の取消と3秒の期限を別条件とし、2個目の判定が出ていれば失敗にします。これは入力待ちだけの期限検査ではありません。予備検査ではYices2 WASIとZ3 nativeの両方で、計算中の期限切れと取消が成功しました。正式なworker条件はWASIで反復します。

Z3では、SMTの`QF_FP`による32 bitの1.0、IEEE bit-vectorへの変換、最近接丸めでの1.0 + 1.0 = 2.0を検査します。これと、hardware doubleの丸めを使う`subpaving :numeral hwf`を混同しません。後者のnative対照は区間制約を含むgoalを返しましたが、これはsat/unsatの証明ではありません。WASIでは候補patchによるerror診断と非ゼロ終了を要求し、nativeとの出力一致の対象から外します。A/Aでは同じ実行系の出力を比較します。WASIでの両条件は未確認です。

### Z3 nativeの予備結果

Clang 21.1.8、隔離したlibc++ 21、CMake 3.31.10で、明示したABI linkを含むbuildが終了0になりました。build commandは2,082.558秒、binaryは31,589,376 byte、SHA-256は`0ceec28f441342dac24ac23787ad68d126f54775f170686b99da92828fedfc46`です。実binaryの版表示は`Z3 version 5.3.3 - 64 bit`でした。metadataの`compiler`はC compiler、`compiler_cxx`は実際のC++ compilerなので、前者のGCCの版だけでZ3のcompilerを説明しません。

nativeのみでbit-vector、array、長い値、構文エラー、応答の欠落、unknownの6条件が成功しました。構文エラーの終了は1で、Yices2の0とは異なります。続けて通常の浮動小数点、hardware丸めの成功対照、計算中の期限切れと取消もnativeで成功しました。いずれも未commitの比較器のsnapshotを残した予備検査であり、WASIとの正式比較ではありません。

## 予備結果と捨てた試行

| 試行 | 観測と修正 |
|---|---|
| incremental初回 | Yices2ではproduce-modelsをset-logicの後に設定できずerrorになった。上流の順に設定する |
| 条件比較の初回 | arrayの問い合わせ式をbinary表記と誤認し、長い値の改行も予想しなかった。元のstdoutはnative/WASIで一致していたが、検査器は失敗した |
| 構文エラーの初回 | 非ゼロ終了という誤った条件で失敗した。両系ともerror応答と終了0。上流sourceを確認し、errorの検出と終了コードを分離した |
| 構文検査の不備 | 検査器の編集で括弧が一つ余り、NodeのSyntaxErrorで実行前に停止。ソースと診断を保持して修正した |
| 修正後の予備3 | 5条件の両系比較10実行とworker異常系8実行が成功。正式5回反復ではない |
| alarm検査の初回 | SMT要求を送らずに待ったため、遅延初期化されるtimerへ到達せずhost timeout。check-satを送るよう修正した |
| 記録器の予備1 | alarmはstderrの63 byteと終了19を確認。arrayの正常終了では、分割したexitの最後の改行より先にCLIが終了しwriteが拒否された。正常終了はEOFで検査するよう修正した |
| 記録器の予備2 | EOFによる終了に分けた後、5条件の両系10実行、worker異常系8実行、alarm拒否の計19実行が成功した。正式反復ではない |

これらの試行は正式結果と混ぜません。初回のstdout、stderr、ソースのsnapshotを保全しています。[記録器の予備1の生CSV](S15-solver-protocol-preliminary-1.csv)と[予備2の生CSV](S15-solver-protocol-preliminary-2.csv)は、それぞれ19行31列です。binaryは清浄なbuildですが、比較器は未commitの予備版です。CSVのharness commitだけで比較器の版を示したとは扱わず、snapshotのhashも照合します。正式反復と全列監査の完了後に、正式CSV、ログのhash目録と集計をここへ追加します。

### 清浄なcommitでの監査器の予備検査

実装を`6776c620773cd87597af373b684d0f6808ec13d3`へ固定し、Yices2の各条件1回とA/A 2回、計63実行を行いました。[生CSV](S15-solver-protocol-audit-preliminary.csv)の全63行31列、63個の負の対照、rawのbuild logとmetadataの監査が成功しました。保存した14個のsource snapshotも、そのcommitのGit objectと全byte一致しました。12件の監査器単体と、Web・既存実WASIの計248件も同じ清浄なcommitで成功しています。これは監査器の予備確認であり、両solverの正式5回反復ではありません。

```sh
node scripts/measure-solver-protocol.mjs \
  --probes build/S15/p2-yices-probes.json \
  --out build/S15/p2-yices-protocol-driver-preliminary-5 \
  --repeats 1 --aa 2 --preliminary
python3 scripts/audit-solver-protocol.py \
  --directory build/S15/p2-yices-protocol-driver-preliminary-5 \
  --out build/S15/p2-yices-protocol-driver-preliminary-5/audit.json --preliminary
```

予備のmanifestは前述の同じnative/WASI buildを指します。再実行時は配置先へ合わせ、正常・失敗を含む既存の出力先を上書きしません。初期の失敗、Z3 nativeの予備結果、build metadataと生log、比較器のsnapshotを含む[1,118ファイルの目録](S15-solver-protocol-audit-preliminary-files.csv)を保存しました。証拠ZIPは`S15-solver-protocol-audit-preliminary-evidence-v1.zip`、1,261,962 byte、SHA-256は`42c9cbc4d9239f7b87f897e660ccd475d78c9af3a63cd16668dc645e8d3db493`です。ZIPを開き直し、目録の全項目のbyte数とhashを照合しました。実行中のZ3 WASIのlogは含めていません。

## 再実行の入口

buildの記録に従って同じ固定版とprofileを生成し、出力先の`metadata.json`があるdirectoryをmanifestへ指定します。相対パスは実行時の作業directoryを基準にします。次はYices2の予備比較の例です。この予備時点ではZ3の実buildと確認が残っていましたが、その後は両solverの[正式なnative/WASI比較](S15-solver-native-wasi.md)を実施しました。

```json
{
  "yices2": {
    "native": "build/S15/yices2-native",
    "wasi": "build/S15/yices2-wasi"
  }
}
```

```sh
node scripts/measure-solver-protocol.mjs \
  --probes build/S15/probes.json --out build/S15/protocol-preliminary \
  --preliminary --repeats 1 --aa 0
```

正式反復は清浄なcommitで`--preliminary`を外し、`--repeats 5 --aa 2`で実行します。出力先の親directoryは先に用意し、既存の出力は上書きしません。記録器は各実行のstdout、stderr、frame列、結果JSON、native RSSと、生CSVを保存します。開始前と終了後のmetadata、実行時のソース、版の出力、負の対照の結果も同じdirectoryへ保存します。

## 全列監査と資源の集計

記録器のformat 2では、rawのbuild metadataと各commandのlogもコピーし、終了0とhashを照合します。build script・patch・worker・shim・比較器・監査器のsnapshotを保存します。旧format 1の予備CSVや失敗記録は書き換えません。

独立したPythonの`scripts/audit-solver-protocol.py`は、CSVの全31列を各JSONとraw logへ照合します。欠落・重複・順序、native/WASIの全byte一致、A/A、失敗分類、binaryとbuildの由来、負の対照も検査します。正式modeは両solver、各5回以上、A/A 2回以上、清浄なcommitを必須とし、保存ソースをそのGit objectと比較します。これは証拠の整合性検査であり、署名や第三者の承認を証明するものではありません。

```sh
python3 scripts/audit-solver-protocol.py \
  --directory build/S15/protocol-formal --out build/S15/protocol-formal/audit.json
python3 -m unittest discover -s tests/check-solver-protocol
```

予備modeでは記録器と監査器の両方に`--preliminary`が必要です。両方とも既存の出力を上書きしません。監査器は、正常系と異常系、A/Aと本反復を別のgroupとして、時間・native最大RSS・WASM linear memoryの件数、欠測数、最小・中央値・最大を出します。両メモリー量を同じ指標として比較せず、欠測はnullのまま残します。失敗までの時間を正常応答の速度として集計しません。

Yices2の計算中停止を含む予備21実行は、全31列と7種類ずつ計21個の負の対照まで監査できました。通常CIへ加えたのは合成した証拠を使う小さな単体テストだけです。全列の改変、行の欠落・重複、記録とCSVを同時に変えた誤分類、欠測の0への置換、build logの改変と失敗の隠蔽を拒否します。正式反復の完了ではありません。

## 未確認の点

その後、Z3 WASIのclean buildと両solverの各5回・A/A 2回、全329行31列と294負の対照の監査を実施しました。条件・生CSV・資源・失敗の保持と証拠は[正式反復の記録](S15-solver-native-wasi.md)へ分けます。上流yosys-smtbmc/SBYとの接続、配布と画面統合は未完了です。Tang Nanoの実機とブラウザー画面は、この記録では試していません。
