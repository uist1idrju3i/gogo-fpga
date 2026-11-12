# S15: SMT反例を元Verilogで独立に再実行する

[実験一覧に戻る](README.md)

## 目的と仮説

原本SMTBMCのVCD出力境界で記録した値を、元VerilogのIcarus native/WASMへ渡す。DUTの内部状態を直接設定せず、入力だけを駆動して、ポート・内部信号・clock・時刻・assertの診断を照合する。これにより、solverの値を保存するだけでは見つからない、元回路との不一致を検出できると考える。

状態は元Verilog再実行層の検査完了である。清浄なcommit `98b6b2e` でA/A 2回と正式5回の全1,484行23列を監査し、正式証拠への改変対照316件、証拠ZIPを空の場所へ復元した後の監査も通った。画面統合、元VHDL/PSLと下位化Verilogの比較、T6全体の認定は別工程とする。

## 固定する条件

- 4候補はYices2、Z3、Bitwuzla、Boolectorとする。追加候補の製品での無効状態は変えない。
- 原本のSMT解析・property選択・solverの判定処理は変更しない。
- ソース・モデル・記録JSON・元VCD・生成testbench・再実行出力のhashを残す。
- native/Pyodideの記録有無を比較し、同一runtimeの原本成果物は全byte一致を要求する。
- runtime間の原本testbench比較では、PI宣言と同じ名前への接続の順序だけを正規化する。原本のbyteは残す。
- 深さN-1、N、N+1、proveのbasecase、負エッジ、非ゼロ初期値、組合せ回路、reset、assume、複数assert、階層を含む17ケースを使う。
- 未初期化、未知初期値、memory、assertなし、空虚な前提、組合せループは成功と分類しない。拒否理由と上流のtool errorを区別する。
- 既にビルドした固定版の参照バイナリーを使い回す。測定時に本体のbyteとbuild metadataを照合する。版表示の原文、ホスト、submodule、実行コマンドも保存する。
- 正式測定ではclean checkoutと同一commitを要求する。実行中に計測器を編集しない。

## 事前の採否基準

4候補ごとにA/Aを2回、その後に正式測定を5回行い、1回ごとに候補を交互に実行する。個別CSVは53行21列、全体は1,484行23列とする。全列を独立監査器で生証拠から導出する。受理する再実行、拒否、上流エラーの区分が期待どおりであることを要求する。

全反復でソース・モデル・記録・再実行testbench・診断・波形の意味的hashが一致することを要求する。反復比較で除くのは経過時間とVCDのdate欄だけとし、生VCDは変更せずに残す。各条件の正式5件から経過時間の中央値・最小・最大を出す。これは参照環境とWASMの時間であり、実機FPGAの値ではない。

CSV/JSONの全21列の改変に加え、ソース、モデル、記録値、VCD、testbench、sample欠落、clock edge、子process、再実行出力の改変を拒否することを要求する。ZIPを空の場所へ復元し、保存した監査器でも全列を再監査する。失敗試行は成功した正式測定に混ぜない。

## 再実行コマンド

Python用の固定資材と4候補のprobe manifestは、先行する[SMT記録の正式測定](S15-smt-trace-audit.md)と同じものを使う。出力先が既にあれば停止する。正式測定の出力先は `smt-verilog-replay-formal-02` である（`formal-01` は後述の中断試行）。

```sh
python3 scripts/measure-smt-replay.py \
  --sources build/S15/smt-trace-python-assets-formal-01 \
  --probes build/S15/smt-trace-all-probes.json \
  --out build/S15/smt-verilog-replay-formal-01
python3 scripts/measure-smt-replay.py --audit-only \
  --out build/S15/smt-verilog-replay-formal-01
node --test tests/web/formal-smt-replay.test.mjs tests/web/formal-trace-compare.test.mjs
```

## 予備結果と失敗試行

未コミットの予備実装で、4候補の計212行と全21列の監査が通った。Web単体330件、Python単体148件も通ったが、これは提出commitの検証ではない。Yices2の予備証拠に対する70件の改変対照は全て拒否した。

予備試行では、定数netを元HDLの信号として参照する誤り、階層内のclock別名の扱い、PI順序とPython hash依存の順序差を検出した。定数はliteralで照合し、clock別名は同じRTLIL bitの場合だけ受理する。比較時の正規化はPI順序に限定し、native/Pyodideに同じhash seedを渡す。

改変対照の初回は、保存した再実行ファイルの位置を取り違えて停止した。2回目は資材manifestのキー名の取り違えで停止した。どちらも監査成功に数えず、ログを保持して修正した。nativeの診断を追加監査する際には、ivlppの標準出力が前処理済みソースである点を見落とした。前処理出力と実行出力を区別し、実行出力・各段階の終了code・全stderrを照合するよう訂正した。

最初の正式測定は、commit `f92110b` でA/A 1回目のYices2・Z3の個別監査まで通った。その後の点検で、Pythonでは `false == 0`、`true == 1` となり、終了codeや1 sampleの検証値を型違いで代用できる監査器の不備を見つけた。測定を中断して証拠を保全し、実行codeの整数型とplan・検証JSONの型を含む一致を必須化した。旧commitの `replay_result` を負の対照として実行し、2件の見逃しを確認した。中断したA/Aは正式結果に流用せず、修正後の清浄commitから全反復をやり直す。

改変対照は型違い、property診断時刻、native compileの終了・警告、native最終stdoutの改変を加え、79件へ増やした。Yices2の予備証拠では79件すべてを拒否し、原状復帰後の監査も通った。

## 正式結果

測定commitは `98b6b2eca954dccfdc96e68f6e8e10fc9f9ce886` である。清浄なcheckoutで計測器を固定し、A/A 2回の後に正式5回を測った。各回は4候補を交互に実行した。実行中のscriptは変更していない。

hostはLinux `6.8.0-1061-aws`、x64、2 CPU、memory 8,327,749,632 bytes。実版はNode `v24.21.0`、Python `3.12.13`、Pyodide `314.0.7`、Icarus Verilog `13.0 (stable) (v13_0)`、Yosys `0.70 (git sha1 28ba3cb92)` だった。環境変数は `LC_ALL=C`、`TZ=UTC`、`PYTHONDONTWRITEBYTECODE=1`、`PYTHONHASHSEED=0` に固定した。solverは前段で認定したbinaryを再利用し、今回のcommitから再ビルドしたとは扱わない。固定sourceと全8 binaryのSHA-256は[証拠概要](S15-smt-verilog-replay-evidence.json)にある。

| 区分 | 行数 | 内訳 |
|---|---:|---|
| A/A | 424 | 2回 × 4候補 × 53行 |
| 正式 | 1,060 | 5回 × 4候補 × 53行 |
| 合計 | 1,484 | 全行で期待区分と実区分が一致、全列監査が成功 |

[生CSV](S15-smt-verilog-replay-audit.csv)は `series`・`iteration` と個別の21列の計23列で、SHA-256は `b1352a1911ba6658352c925b1fc4100d0077b5a1285d3a657288295e8720a484` である。計測器の集計結果は `status=pass` だった。

各回・各候補の53行は、受理した再実行32行、拒否12行、上流のtool error 1行である。受理は深さN・N+1、proveのbasecase、負エッジ、非ゼロ初期値、組合せ回路、reset、assume、複数assert、階層の10ケースで、それぞれnative/Pyodideの記録をIcarus native/WASMの両方で再実行した。拒否は、深さN-1と空虚な前提（完全な失敗traceがない）、任意の初期状態、未知の初期値、memory（`$memwr_v2`）、assertなしの6ケースである。組合せループは上流Yosysの終了code 16を区別して記録した。拒否とtool errorを成功には数えない。

全反復で、ソース・モデル・記録・再実行testbench・診断・波形の意味的hashが一致した。比較から除いたのは経過時間とVCDのdate欄だけで、生VCDは変更せずに残している。

[時間集計CSV](S15-smt-verilog-replay-timings.csv)には212条件それぞれの正式5回の最小・中央値・最大を保存した。A/Aは時間集計に混ぜていない。条件ごとの中央値の範囲は、Icarus nativeの再実行80条件で19.5〜42.4 ms、WASMの再実行80条件で3.9〜71.2 ms、再実行しない拒否・tool errorの52条件で78.2〜2,121.2 msだった。参照環境とWASMの時間であり、実機FPGAの値ではない。性能の優劣も認定しない。

## 正式証拠への改変対照

4候補それぞれの正式1回目の証拠に、`negative-smt-replay.py` の79件を適用した。計316件をすべて拒否し、原状へ戻した後の監査も成功した。対照はCSV/JSON全21列、ソース、モデル、記録値、sample欠落、clock edge、VCD、testbench、再実行の出力・波形・診断・終了code・検証値、型違い、property診断時刻、native compileの終了・警告、子processの引数・hash・終了code・整合性、欠落/重複行、重複JSON key、非有限値、危険なasset path、予期しない成果物である。

```sh
python3 -B scripts/negative-smt-replay.py \
  build/S15/smt-verilog-replay-formal-02/run-1/"$SOLVER"/replay \
  --out build/S15/smt-verilog-replay-negative-formal-"$SOLVER"-01
```

## ZIPと復元後監査

測定の証拠は、測定を行った作業環境から回収したものである。回収後に、別の作業環境で `measure-smt-replay.py --audit-only` を実行し、同じ1,484行23列とCSV hashを再現した。

起動用のsymlinkは、測定環境のcheckout外にある認定native binaryを指していた。リンク先は回収物に含まれていない。そこで、各候補の証拠に保存された `inputs/<solver>-native` を、metadataのcommand SHA-256と一致することを確かめてから元のリンク先へ置いた。対応は証拠ZIP内の `smt-verilog-replay-launcher-reconstruction-01.json` に残した。測定に使ったbinaryそのものではなく、同じbytesの複製である。

ZIPの作成には、packagerのcommit `820cba4fd20d30ab27396430509205e051433bff` を使った。計測器・監査器・改変対照・probeは測定commitから変えていない。packagerには2点を足した。改変対照のclone（`mutated-evidence`）内のlauncherは、cloneの元のlauncherとlink text・SHA-256が一致する場合だけ通常fileへ複製する。manifestの上限は16 MiBから64 MiBへ広げた。

```sh
python3 -B scripts/package-extra-formal.py --stage --output build/S15/smt-verilog-replay-staged-02 \
  --include build/S15/smt-verilog-replay-formal-02 --include ...
python3 -B scripts/package-extra-formal.py \
  --campaign build/S15/smt-verilog-replay-staged-02/build/S15/smt-verilog-replay-formal-02 \
  --include build/S15/smt-verilog-replay-staged-02/staging.json --include ... \
  --output build/S15/smt-verilog-replay-evidence-820cba4-01.zip
python3 -B scripts/package-extra-formal.py --restore \
  --output build/S15/smt-verilog-replay-evidence-820cba4-01.zip \
  --campaign build/S15/smt-verilog-replay-restored-02
```

`--include` には、ZIP内の `smt-verilog-replay-evidence-index-04.json` に列挙した全rootを渡した。分類は正式、正式証拠への改変対照、中断、旧監査器の対照、資材、launcherの復元、回帰log、予備、失敗したZIP作成の各区分である。Pythonのbytecode cache 10件はpackagerが拒否するため除外し、path・SHA-256を `smt-verilog-replay-excluded-bytecode-01.json` に残した。

ZIP `smt-verilog-replay-evidence-820cba4-01.zip` は69,870,106 bytes、96,592 files、重複除去後13,201 objectsである。SHA-256は `256fbabf37d4755533ddf33b2f2a7c62f63966fe14111c0940f85faad661fce1`、manifestのSHA-256は `9df62248e0c47d79932f11883fe3f414343faac8c202b1f903cb59dd7c8055ab` だった。manifestのpath集合は、回収した全90,322 paths（bytecode 10件を除く）と回収後に作った記録の和に一致した。各通常fileのSHA-256は回収時の目録と一致し、94個のlauncherは複製後のbytesがmetadataの値と一致した。

未作成の復元先へ全96,592 filesを戻し、長さとSHA-256を全件照合した。復元したsnapshotの計測器・監査器による再監査でも全1,484行23列が成功した。改変対照316件は終了codeと632個のraw logのhashを照合し、原状へ戻した4組も復元した監査器で別に監査した。

## 提出commitでの回帰

cherry-pick後の `5fe2fbc` では、Web単体313件のうち311件が成功した。失敗した2件（`build-info.test.mjs`、`decompress.test.mjs`）は、この作業環境にdecoderのWASI成果物がないことが原因で、今回の変更とは関係しない。対象の2ファイル `formal-smt-replay.test.mjs`、`formal-trace-compare.test.mjs` は54件すべて成功した。Pythonの `tests/check-solver-protocol` は、packager変更後の `820cba4` で150件が成功した。JIS X 0213、リンク、文書サイズ、pinの一致、`git diff --check` の各検査も通った。

## 正式測定後の失敗

最初のstageは、改変対照のcloneにある12個のlauncherを未検証として拒否した。上記のclone照合を追加した後のstageは、予備証拠2 rootのPython bytecode cacheを拒否した。bytecodeを除いて再実行した後、最初のpackageはmanifestが16 MiBの上限を超えたため検証で停止した。この時のZIP（SHA-256 `250e8fd39e96afb1b1d74de9d0d468e0b9b85446195de6435f69f8f893444756`）は未検証の出力として扱い、提出するZIPには含めていない。また、作業用の照合scriptの誤り（型の取り違え、短縮hashと完全hashの比較）で2回停止した。どれも修正後にやり直し、logを保持している。いずれも証拠の不一致ではない。

## 残件

元VHDL/PSLと下位化Verilogへの接続と反例の照合（task 54）、P5のschema4・ZIP/OPFS・formal worker・result/VCD画面、P6の製品反復・配布closure・T4/T5回帰・CI全体は未完了である。Bitwuzla/Boolectorは有効化しておらず、T6全体の完了とは扱わない。実機のTang Nanoでは試していない。
