# 形式検証の原本とブラウザーの制約

[調査の索引](../../RESEARCH.md#7-分割した調査) / [固定ソースと配布条件](formal-sources.md) / [S15の事前基準](../experiments/S15-formal-verification.md)

原本のprocess調査を経て、[SBY全体の仮想process接続](../experiments/S15-sby-runtime.md)を追加しました。初期実装は単一slotのBMC・prove・coverに限定し、Pythonの判定処理は維持します。JsNull、SQLite WAL、作業領域の競合とcommand制限の調査、失敗試行も同記録に保存します。その後の[正式5回・A/A 2回](../experiments/S15-sby-repeated.md)は全84行19列・全成果物が一致しました。[異常対照23条件](../experiments/S15-sby-controls.md)と[原本のwitness変換2形式](../experiments/S15-sby-witness.md)も、別の清浄commitで各5回とA/A 2回を終え、全列を独立監査しました。配布と画面統合は未完了です。

## 結論と確認範囲

T6では upstream の SBY と `yosys-smtbmc` を再利用します。SMT式の生成、BMC、帰納法、モデルとVCDの生成を独自に書き換えません。Yices2とZ3を優先して比較し、BitwuzlaとBoolectorも候補として残します。Yosys内蔵SATは比較経路であり、SMT対応の代わりにはしません。

P0でソースの静的調査と依存確認を行い、S15の事前基準をコミットしました。P1ではYosys内蔵SATと反例の比較経路を追加し、各節に検査範囲を記録しました。P2の[ソルバー予備ビルド](formal-solvers.md)の失敗と調査を経て、[native/WASI正式比較](../experiments/S15-solver-native-wasi.md)の全329行31列を監査しました。ブラウザーの形式検証画面は未完了です。以下の経緯にある「未完了」は各段階の記録として残し、最新の結果と区別します。固定ソースの登録だけで、ソルバーを利用可能にはしません。

## 上流の再利用と輸送層

| 原本 | 確認した処理 | ブラウザーで必要な対応 |
|---|---|---|
| [SBY core](https://github.com/YosysHQ/sby/blob/79fc9eddca5e33a28cc2f2cd19c9825efd9a7255/sbysrc/sby_core.py) | bash、`subprocess.Popen`、fcntl、非同期pipe、process group、signal | `SbyProc` の外部プロセスを仮想processへ接続する。任意のshellを実行しない |
| [Yosys SMT輸送](https://github.com/YosysHQ/yosys/blob/28ba3cb926fe376fa05ebfc1b921747d011d4557/backends/smt2/smtio.py) | ソルバーへのpipe、stdout readerのThreadとQueue、read/write/close | Pyodideでfork・pipe・Threadを使えると仮定せず、輸送だけをadapterへ接続する |
| [yosys-smtbmc](https://github.com/YosysHQ/yosys/blob/28ba3cb926fe376fa05ebfc1b921747d011d4557/backends/smt2/smtbmc.py) | BMC・帰納法・cover、モデルと反例出力 | アルゴリズムと意味を維持し、終了コード・status・witnessを照合する |

最初は1つのソルバーとtaskで縦に接続します。ソルバーのコマンド、作業ディレクトリー、ファイル名は静的な許可リストで制限します。設計、property、SMT入力、ログ、反例をサーバーへ送信しません。実行時のDevinへの依存も設けません。

輸送の比較には、長い入力、複数の `check-sat`、`push/pop`、`get-value`、stdout/stderrの分離、EOF、終了済みprocessへの書込み、timeout、cancel、停止後の遅れた応答を含めます。輸送が通ったことだけを証明器の正しさとは扱いません。

## Z3の公式WASM先例

調査時点の公式 `z3-solver` は5.3.3、Nodeの条件は16以上、npmの `gitHead` は `430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e` です。展開サイズは39,457,489 bytes、25 filesでした。採用ソースのrelease commitと一致していますが、npmパッケージは製品依存には追加していません。

原典は同じcommitの [build-wasm.ts](https://github.com/Z3Prover/z3/blob/430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e/src/api/js/scripts/build-wasm.ts)、[async-fns.ts](https://github.com/Z3Prover/z3/blob/430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e/src/api/js/scripts/async-fns.ts)、[api_parsers.cpp](https://github.com/Z3Prover/z3/blob/430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e/src/api/api_parsers.cpp)、[公開README](https://github.com/Z3Prover/z3/blob/430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e/src/api/js/PUBLISHED_README.md)です。

- 公式buildはEmscriptenのpthreadを使用します。poolの大きさは0、strict設定は0、初期メモリーは2 GiB、stackは20 MiBです。小さいメモリーやWASIで動く証拠ではなく、この設定をそのまま採用しません。
- `Z3_eval_smtlib2_string` はC context内にコマンドcontextを保持します。宣言、push/popなどをZ3自身に解釈させる候補であり、JavaScriptで独自のSMT parserを書く必要を避けられる可能性があります。
- 公開READMEの非同期関数一覧だけでは判断できません。実際の `async-fns.ts` に `Z3_eval_smtlib2_string` が含まれます。npmのJavaScript APIを、Pyodideの同期Pythonからそのまま呼べるとは言えません。
- WASI CLIと双方向pipe、単一threadの同期C API、公式Emscripten経路を隔離して比較します。JSPI・pthreadは、必要性を実験で示した場合だけ候補にします。

上記は本リポジトリでは試していない実行方式です。ソース調査時に参照した別のmaster snapshotと、採用releaseは区別します。

## HDLのproperty保持

通常のSystemVerilog対応と、形式検証専用の限定的なVerilog構文を分けます。`assert`、`assume`、`cover` を解析できることと、意図したpropertyが合成後も残ることは別の検査です。

GHDLでは [synth-flags.ads](https://github.com/ghdl/ghdl/blob/e589c698c351369ac5bcfe7abe1f1152ac5d4727/src/synth/synth-flags.ads) の `Flag_Formal` の初期値がTrueです。当初は [netlists-disp_verilog.adb](https://github.com/ghdl/ghdl/blob/e589c698c351369ac5bcfe7abe1f1152ac5d4727/src/synth/netlists-disp_verilog.adb) に `Id_Assert`、`Id_Assume`、`Id_Cover` があることから、plain assertionの保持候補としました。P1で各出力を読むと、assertは `$fatal`、assumeとcoverはVHDL風の文を出しており、そのままYosysの形式propertyへ渡せる出力ではありません。この点を未確認のまま対応済みにはしません。

PSLコメントの解析は [vhdl-scanner.ads](https://github.com/ghdl/ghdl/blob/e589c698c351369ac5bcfe7abe1f1152ac5d4727/src/vhdl/vhdl-scanner.ads) の `Flag_Psl_Comment` が既定でFalseです。当初のWASM APIにはこれを選ぶ引数がありませんでした。P1では`runGhdlSynth({ formal: true, psl: true })`を追加し、上流[options.adbの`-fpsl`](https://github.com/ghdl/ghdl/blob/e589c698c351369ac5bcfe7abe1f1152ac5d4727/src/options.adb#L250-L252)と同じ`Flag_Psl_Comment`・`Flag_Comment_Keyword`を設定します。前者だけを設定した初回のWASMではPSLが消えたため、失敗記録を残して両方を接続し直しました。PSLだけの選択、非boolean設定、形式設定APIのない旧WASMでの形式出力は拒否します。旧WASMの通常合成は維持します。

GHDLの解析とmonitor生成は変更せず、`patches/ghdl/formal-verilog.patch`で明示した形式出力だけを追加します。`Build_Assert`・`Build_Assume`・`Build_Cover`・`Build_Assert_Cover`のgateを`$assert`・`$assume`・`$cover`へ渡し、activation coverをassertとして数えません。nativeの比較用CLIは`formal-verilog-driver.patch`の`--formal-verilog`、Yosysは明示した`internalCells: true`で`read_verilog -formal -icells`を使います。通常合成と通常のVerilog入力は変えません。

labelは上流GHDLが生成した小文字のinstance名として保持します。sourceは元のファイル名・開始行・列で、完全な原文範囲ではありません。位置がないgateは出力を止めます。上流[synth-vhdl_stmts.adb](https://github.com/ghdl/ghdl/blob/e589c698c351369ac5bcfe7abe1f1152ac5d4727/src/synth/synth-vhdl_stmts.adb#L4835-L4880)はactive stateがあるPSL assertionだけにactivation coverを追加します。単純な`always`へcoverを必須とした検査は誤りでした。期待数を直すとともに、`a = '1' -> next (count < 3)`を別に加え、`p_bound_cover`がcoverとして残ることを確認します。

`tests/synth/formal-vhdl.test.mjs`は、native/WASMのGHDL出力全バイトとproperty一覧、元のlabel・source・種類、N-1/N/N+1、両clock極性、矛盾するassume、PSL無効・不正入力と旧APIの拒否を検査します。manifestのpatch・API source hash、native binary hash、WASMのSHA-256を実ファイルと照合します。結果と失敗は[S15の診断記録](../experiments/S15-vhdl-formal.md)へ保存します。一般の階層・library・memory・X・複数clock、VHDL原文による反例の独立再実行、正式5回反復はこの層では未確認です。

比較にはproperty数とID、0件、途中で消えたassertion、矛盾したassume、clock/reset、初期状態、X、ROM初期化、メモリー、組合せループ、ライブラリーのソース依存を含めます。最初に違反する深さがNの入力で、N-1・N・N+1の境界を調べます。反例は元の回路で独立に再実行し、VCDとpropertyを照合します。複数の正しいモデルがあり得るため、反例の全バイト一致だけを正しさの条件にはしません。

## 元のVHDLを実行する独立した照合

GHDL標準のVPIを使い、元のVHDLを変更せずnative runtimeでSAT反例を再実行します。VHDL/PSL parserやmonitorは自作しません。通常assertionとclocked PSLの評価位相を区別し、全入出力のVPI観測、独立したVCD、上流の`--psl-report`を照合します。coverは既定では標準出力に診断を出さないため、上流JSONの件数と状態を使います。root moduleの取得には`vpi_iterate(vpiModule, NULL)`と`vpi_scan`を使い、全ポートの方向・幅・一覧を確かめます。

native/WASMの合成とSATの4組から得た28反例、実runtimeの負の対照12件、位相・未知値・欠落・改変の検査とCSV全列監査を含む55件が、清浄な同一commitで5回とA/Aの2回成功しました。全280行19列を元ファイルへ結び付けて監査しています。下位化後のVerilog/Icarusとの照合、追加fixtureは未完了です。生CSV、失敗試行、評価時刻、provenanceと制限を[S15の原文再実行記録](../experiments/S15-vhdl-native-replay.md)へ保存します。このnative検査器をブラウザー製品の機能としては扱いません。

## P1のSAT比較経路

SAT経路は、準備、前提の整合性確認、証明を別の実行に分けます。準備前後のflatten済みJSONでpropertyのID・種類・sourceを照合し、1ビットのA/EN接続を検査します。0件のassertion、失われたproperty、未対応の状態セル、明示したclock/edgeと異なるレジスターを拒否します。初期値を一律に0へ固定する `-set-init-zero` は加えません。

前提の確認は、指定した深さで `sat -set-assumes` を実行します。モデルが存在しない場合は前提が矛盾した結果として止め、証明成功にはしません。これは指定深さの整合性確認であり、全ての時刻で前提が整合する証明ではありません。coverは準備時の一覧には保持しますが、この比較経路のSAT対象から明示的に除き、到達性を判定しません。

判定には上流の終了コードと行全体の結果を用います。BMCの反例なしは `bounded-safe` と深さを返し、帰納法は基底部と帰納部を両方確認した場合だけ `proved` を返します。反例はVCDとWaveJSONの両方を要求し、再実行前は `replay: pending` とします。単なる `SUCCESS`、基底部だけの成功、曖昧な結果、異常終了、witness欠落を成功へ変換しません。

検査の入口は `tests/web/formal-properties.test.mjs`、`tests/web/formal-sat.test.mjs` と `tests/synth/formal-sat.test.mjs` です。後者は製品と同じ独自WASI preview1 shimを使い、nativeとWASMのログ・入力・中間JSON・反例とバイナリーのhashを新規の証拠ディレクトリーへ保存します。現段階は実装中の診断試行であり、S15の正式な5回反復、VHDL保持、SMT経路、画面統合は未完了です。

## 元のVerilogによる反例の独立再実行

`web/lib/formal-replay.mjs` は、Yosys SATのWaveJSONからテストベンチを生成し、変換前のVerilogをIcarusで再実行します。SMT式や証明手順は実装しません。状態を強制代入せず、元のHDLにある具体的な初期値と、宣言した単一clockの極性を使います。次の入力は有効edgeのnonblocking代入で与え、回路には直前の入力を取り込ませます。各stepで全出力をモデルと照合し、元のassertionのファイル・行と違反stepを記録します。

対象は既知の0/1のport値、具体的な初期値を持つ`$dff`、異なる行に書かれた即時assert/assumeです。初期値のない状態、inout、未知値、重複したproperty行、未対応のWaveJSON、途中終了、VCD欠落、未確認の診断は検証済みにしません。VCDのscope・header・dumpvars・時刻の順序と最終時刻も要求します。assume違反も反例の検証成功にはしません。イベント駆動の即時assertionを観測した結果であり、独立した証明書検査ではありません。未対応の反例は、SATの反例生成と再実行未検証を分けて扱います。

Icarusの`formal: true`は再実行専用の明示設定です。この場合だけgeneration 2012と`FORMAL=1`を使い、通常のVerilogシミュレーションの設定は変えません。一般的なSystemVerilogやSVAの対応を意味しません。ブラウザーのworker・入力snapshotとの接続、VHDL原文での再実行、vacuity検出は未完了です。

`tests/synth/formal-replay.test.mjs`は、native/WASI Yosysの各反例をnative/WASM Icarusで独立に再実行し、stdout/stderr・違反property・VCD全バイトを照合します。N-1/N/N+1、両clock極性、帰納法の基底部、`FORMAL`内の組合せassertion、reset列を対象にし、壊した出力値とreset列をWASMで拒否させます。build-infoの原版・バイナリーhashと実行したvvpの版も照合します。正式な5回反復ではなく、[S15 P1の診断記録](../experiments/S15-formal-replay.md)として保存します。

## VHDL反例の再実行と比較の経緯

以下はRESEARCH.mdから移した調査時点の原記録です。「未完了」はそれぞれの段階の記録であり、現在の全体の完了を示すものではありません。

元VHDLの独立再実行は、GHDL標準のVPIと`--psl-report`を再利用する限定した検査経路を追加しました。清浄な同一commitで55件×5回とA/Aの2回が成功し、元ファイルとCSV全280行19列を照合しています。通常assertionとclocked PSLの評価位相、coverが既定では標準出力に現れないこと、root moduleのVPI列挙、生CSV・全ファイルのhash・失敗試行と未完了の範囲を[元VHDLによる再実行の実験記録](../experiments/S15-vhdl-native-replay.md)へ保存します。下位化後のVerilog比較、追加fixtureとT6全体は未完了です。

その後、[下位化Verilog比較](../experiments/S15-vhdl-lowered-replay.md)を追加しました。上流YosysでIcarus用モデルを出力し、assertion再実行からだけcoverを除き、元のcoverとPSLレポートを保持します。propertyのkind・A/EN別名と元ソースを対応付け、準備後のstate bit・初期値・clock、全ポートを照合します。通常assertionの診断密度は実行系で異なるため、最初の違反と全違反の包含を比較します。階層・名前付きライブラリーを含む10成功fixtureと5境界fixture、全60行20列の監査が予備検査で通りました。未知の初期値、memory、循環、空虚な条件は成功と区別します。[初回の失敗・process footerの制約](../experiments/S15-vhdl-lowered-failures.md)も保存します。その後、清浄な同一commitで69件を5回とA/Aの2回実行し、CSV420行の全20列とソース・実行系のhashを監査しました。GHDL VCDの日時と所要時間以外は反復間で一致しました。SMTソルバー、worker/UIとT6全体は引き続き未完了です。

## 判定とブラウザー統合

| 結果 | 必ず区別する内容 |
|---|---|
| BMC | 指定深さまで反例なし。無制限の証明ではない |
| prove | 基底部と帰納部。片方だけの成功をprove成功にしない |
| cover | 到達、指定深さで未到達、到達不能の証明 |
| 非成功 | unknown、timeout、cancel、crash、error、unsupported、壊れたstatus、witness欠落、hash不一致 |

schema 4では形式検証設定、propertyファイルと順序、入力snapshotを保持し、schema 1から3の読込み、ZIP/OPFSの往復、旧アプリが新設定を黙って捨てないことを検査します。workerのcancel後は新しく作り直し、古いjobの応答を新しい結果として表示しません。反例は既存Surferの複数VCD選択へ接続する候補です。現時点では未実装です。

資源の提案値は同時job 1、既定30秒・設定上限300秒、solver linear memory 512 MiB、ログ8 MiB、trace64 MiBです。実測値ではありません。静的配信の1資材25 MiB未満、ZIPでのプロジェクト保存、Zstandardでの大きな配信資材、T4/T5回帰も確認対象です。全資材の事前保存によるoffline対応はT6後に扱います。

## 調査から実装への対応

| 段階 | 成果と確認 |
|---|---|
| P0 | 固定ソース・依存・NOTICE・配布ソース・S15の事前基準。この記録の範囲 |
| P1 | Yosys SAT、VHDL/Verilogのproperty保持、境界、負の対照、反例再実行 |
| P2 | Yices2/Z3、native / WASM、ABI・C API・pipe、終了とcancel |
| P3 | upstream SBY / SMTBMCをadapterで接続しBMC・prove・coverを分離 |
| P4 | Bitwuzla・Boolector、cvc4/cvc5、MathSAT、ABC、dummyを含む全選択肢と無効理由 |
| P5 | schema 4、保存、worker、結果画面、Surfer、許可リストと資源制限 |
| P6 | 固定commitとbinaryで各5回、A/A、負の対照、失敗試行、S15と配布・回帰 |

実機のTang Nano、Cloudflare Pages公開、独立した証明書の検査は、この調査で確認した事項には含めません。
