# 午後のFPGA Web Toolchain

Web ブラウザーだけで VHDL と Verilog の編集、論理合成、配置配線、ビットストリームの作成、Tang Nano への書き込みまで行う FPGA 開発環境を目指します。設計データをサーバーへ送らない構成にします。

対象は Sipeed Tang Nano 1K、4K、9K、20K です。各ボードの FPGA が内蔵 SRAM へ構成できることを選定理由としています。HDL は VHDL と Verilog を最初から対象とし、SystemVerilog は将来の段階で扱います。

## 開発状況

T0 から T3 の編集・保存・合成・配置配線・ビットストリーム作成に加え、T4 の Verilog シミュレーションと波形表示を実装しています。合成には Yosys + ABC と GHDL、配置配線には nextpnr-himbaechel、ビットストリームの作成には Apicula を使います。書き込み部は、[午後のFPGA Web Flasher](https://github.com/gogo-fpga/flasher) から移植したものです。T5 は22候補の固定版カタログ、依存解決、選択画面、ZIPへの同梱と名前付きVHDLライブラリーに対応しています。[HDL8部品の全4ボード](docs/experiments/S14-production-hdl.md)と[CPU6候補の4K・9K・20K](docs/experiments/S14-production-cpu.md)は、代表回路のnative / WASI配置配線を各5回照合しました。CPU6候補の1Kは容量超過、FemtoRVはIcarus frontend非対応として選択を制限します。これは固定構成の仮想検証です。[昇格後の最終回帰と配布ソースの照合](docs/experiments/S14-final-regression.md)に、全60組の分類、全列CSV、警告の根拠、Git情報なしの再生成と未確認範囲を記録しています。形式検証（T6）は未対応です。

形式検証は、[固定ソース・依存・ライセンスの調査](docs/research/formal-sources.md)と[S15の事前基準](docs/experiments/S15-formal-verification.md)を登録しています。[Yosys SATの比較とIcarusによる反例の独立再実行](docs/research/formal-verification.md)、[GHDLのVHDL・PSL property保持](docs/experiments/S15-vhdl-formal.md)、[元のVHDLをGHDLで独立に再実行する検査](docs/experiments/S15-vhdl-native-replay.md)は限定した検査経路として実装中です。通常合成の出力は変えず、形式出力を明示した場合だけGHDLからYosysへ性質を渡します。SBY・Yices2・Z3などのソースを配布対象へ加えていますが、ブラウザーからのVHDL反例再実行、SMTソルバーのWASM実行・形式検証画面はまだ提供していません。

[下位化Verilogとの比較](docs/experiments/S15-vhdl-lowered-replay.md)には、階層・名前付きライブラリー・初期値・reset・複数propertyを加え、元VHDLとIcarus native/WASMで値と最初の違反を照合します。X・未初期化・memory・組合せループは検査経路での未対応理由を記録し、空虚な有界結果を証明にしません。同一commitで69件を5回とA/Aの2回実行し、生CSV420行の全20列を監査しました。

書き込み部は Chromium 系ブラウザーの WebUSB を使います。実機の Tang Nano では試していません。

[Yices2・Z3のnative/WASI正式比較](docs/experiments/S15-solver-native-wasi.md)は、各5回とA/A 2回、全329行31列・294負の対照の監査を実施しました。bit-vector・array・長い応答とworker異常系を実CLIで検査し、構文エラーの終了0やunknownを証明成功へ読み替えません。これはNodeの検査経路であり、製品用のSBY worker・配布・形式検証画面への統合を含むT6全体は未完了です。

[原本SMTBMCのPyodide接続](docs/experiments/S15-sby-process.md)は、process・pipe・待機だけを仮想化し、両solverのBMC・basecase・induction・coverをnativeと比較しています。予備16条件ではログ・VCD・YW・testbenchが一致し、13列CSVの独立監査も通りました。

[SBY全体の仮想process接続](docs/experiments/S15-sby-runtime.md)も追加しました。BMCの有界PASS、proveのUNKNOWN、coverの到達・未到達を区別し、初期実装は`-j 1`に限ります。[全268成果物・16列の独立監査](docs/experiments/S15-sby-artifact-audit.md)に加え、[清浄な同一commitの正式5回・A/A 2回](docs/experiments/S15-sby-repeated.md)で両solver各6条件が一致し、生CSV全84行19列と反復間の全成果物hashを照合しました。[worker異常対照](docs/experiments/S15-sby-controls.md)の23条件と[原本のwitness変換](docs/experiments/S15-sby-witness.md)の2形式も、正式5回・A/A 2回を終え、全列と全workerの終了を独立監査しました。witnessは形式変換の境界の試験であり、元回路による反例検証、配布・画面統合は残っています。

[形式検証の候補一覧と無効理由](docs/research/formal-capabilities.md)のデータを追加しています。上流のSMT全9選択肢・SBY全6エンジンと内蔵SATを残し、検査経路での動作と製品資材の準備を区別します。[追加ソルバーの診断](docs/experiments/S15-extra-solver-builds.md)ではBoolectorのnative/WASIビルドとCLIの5条件が一致しました。[ID幅とtraceの境界](docs/experiments/S15-solver-portability.md)は修正後の正式5回・A/A 2回と全列監査が通りました。後続のSMTBMC/SBY認定とは別の段階で、製品では無効のままです。[BitwuzlaのMeson診断](docs/experiments/S15-bitwuzla-build.md)は固定依存だけの清浄ビルドとCLI予備29実行が通りました。[CLI正式5回・A/A 2回](docs/experiments/S15-bitwuzla-cli-qualification.md)も全203行14列の独立監査が通りました。後続のSMTBMC/SBY正式認定は下記へ記録し、製品では両候補とも無効を維持します。候補の画面表示とT6全体も未完了です。

[追加候補と原本SMTBMC/SBYの接続](docs/experiments/S15-extra-solver-smtbmc.md)では、Bitwuzlaの実help取得とBoolectorの終了code 10/20をprocess境界へ接続しています。両候補の予備比較と、固定外のnative起動を除外した経緯を保持し、後続の正式結果や製品での有効化とは区別します。

[追加候補の独立監査と反復](docs/experiments/S15-extra-formal-audit.md)では、清浄な同一commitで正式5回・A/A 2回の全420行を全列監査しました。実構文エラー・未許可code・実行中停止に加え、改変対照20件、証拠ZIP全38,413ファイルの復元後監査も通りました。製品資材・依存の配布条件・製品認定は未完了で、両候補は無効のままです。

[SMT反例の原回路による再実行](docs/experiments/S15-smt-original-replay.md)は、まず原本SMTBMCのVCD出力境界から値を記録する明示的な検査経路を追加しています。[記録の全17列独立監査](docs/experiments/S15-smt-trace-audit.md)は4候補の正式5回・A/A 2回、全896行19列と改変対照170件、証拠ZIPの復元後監査まで通りました。SMT解析・判定は変更せず、記録できたことだけを反例の独立検証済みとは扱いません。[元VerilogのIcarus再実行](docs/experiments/S15-smt-verilog-replay.md)は、4候補の正式5回・A/A 2回の全1,484行23列、改変対照316件、証拠ZIPの復元後監査まで通りました。元VHDL/PSLによる再実行と画面接続は残っています。

## IDE 画面

IDE は、左にプロジェクトのファイル一覧、中央に HDL エディターとログ・問題・成果物・波形、右にボード情報と書き込み設定を表示します。プロジェクトと設計ファイルはブラウザー内の OPFS に保存し、ZIP で書き出し・読み込みができます。設計データをサーバーへ送信せず、合成・配置配線・ビットストリーム作成をブラウザー内で実行します。

画面幅が 900 ピクセル未満の場合、ファイル一覧と書き込み設定は切り替えボタンから開きます。`.fs` は手元のファイル、またはプロジェクト内のファイルを選んで書き込みます。

### シミュレーションと波形

Icarus Verilog で Verilog の testbench を実行し、出力された VCD を Surfer で表示します。testbench の top、対象ファイル、実行時間の上限（1 から 120 秒）を設定できます。実行中は停止ボタンで Worker を終了できます。WASM 資材の読み込み時間とシミュレーションの実行時間は別に制限します。

4 ボードの Verilog テンプレートには `src/top_tb.v` が含まれます。自作の testbench では `$dumpfile` と `$dumpvars` を指定してください。VCD が出力されなければ失敗として表示します。複数の VCD が出力されたときは、表示・保存するファイルを選べます。Surfer の表示には WebGL が必要ですが、表示できない場合も VCD は保存できます。

VHDL だけのプロジェクトではシミュレーションを無効にし、理由を表示します。Verilog と VHDL が混在する場合、VHDL ファイルはシミュレーションの対象から除外します。VHDL の回路をインスタンス化した Verilog を、そのままシミュレーションできるわけではありません。VHDL シミュレーションを提供しない理由は [NVC の調査記録](docs/experiments/S11-nvc-wasm.md) を参照してください。

4 ボードのシミュレーション、複数 VCD の選択と保存、停止・再実行などはブラウザーの E2E で確認しました。検査条件と成功・失敗・未実施の範囲は [T4 の統合回帰記録](docs/experiments/S12B-simulation-integration.md)を参照してください。

### HDL ライブラリーと CPU

ファイル一覧の「HDL ライブラリー・CPU」で22候補を表示します。言語、原文のライセンス、固定版、保守状況と4ボードの状態を確認できます。未検証、容量超過、言語の非対応は理由付きで表示し、確認できていない部品は選択できません。保守終了の部品は、自動で後継へ置き換えず、追加時に確認を求めます。[候補とライセンスの調査](docs/research/hdl-libraries.md)に範囲を記録しています。

部品を追加すると、選択した部品と依存先のソース、データ、原文のライセンス、検証用 manifest をプロジェクト内へ保存します。これらは読み取り専用で表示します。パラメーターは HDL のインスタンス側で指定します。選択を変更すると、実行中の処理を停止し、古いビルド成果物と波形を破棄します。

プロジェクト形式は schema 3 です。schema 1・2 は、ライブラリー選択なしの形式へ移行します。ZIP は選択した依存を同梱し、不要な部品は含めません。`project.json`、ソース、データ、ライセンス、manifest を合わせて256項目、展開後16 MiB が上限です。自己申告のハッシュだけで upstream の真正性を確認したとは表示しません。古い ZIP の固定版は保持し、現在のカタログへ自動で置き換えません。

資材の取得先は配布物と同じオリジンの静的ファイルに限ります。設計データを送信する API は使いません。シミュレーション内で ROM を読む場合、`$readmemh("src/data.hex", memory)` のようにプロジェクトのルートを基準に指定します。

現在、アプリのオフライン起動は未対応です。全資材を事前保存するオフライン対応は T6 の後に実装します。サーバーの役割は静的ファイルの配信に限り、サーバー側で設計を処理する機能は追加しません。

## 開発段階

| 段階 | 内容 | 完了条件 |
|---|---|---|
| T0 | リポジトリーの土台、書き込み部、文書、スキル、CI、依存関係の監視を整える | CI、リンク検査、JIS X 0213 検査が通る |
| T1 | 画面の骨組み、ボード選択、プロジェクト保存、書き込み機能の統合 | 仮想 USB で `.fs` を SRAM に書き込む E2E が通る |
| T2 | Verilog 用の Yosys + ABC、nextpnr-himbaechel、Apicula を WASM 化 | 4 ボードで `.fs` を作り、ネイティブ版との比較を記録する |
| T3 | GHDL の合成部を WASM 化し、VHDL から `.fs` までつなぐ | 4 ボードのテンプレートで合成と仮想書き込みを実行できる |
| T4 | Icarus Verilog による Verilog シミュレーションと Surfer の波形表示 | Verilog テンプレートをブラウザーで実行できる。VHDL シミュレーションは NVC の cutoff により未対応（[S11 記録](docs/experiments/S11-nvc-wasm.md)） |
| T5 | HDL ライブラリーと CPU コアの取り込み、依存解決 | 各ライブラリーの代表回路が 4 ボードで合成できる |
| T6 | SymbiYosys、yosys-smtbmc、Yices2、Z3、Boolector による形式検証 | 小さな性質の証明がブラウザーで通る |
| T6 の後 | Service Worker と全資材の事前保存によるオフライン対応 | 通信を遮断して編集・ビルド・シミュレーションを実行できる |
| 将来 | SystemVerilog と Verilator | C++ コンパイラーを含む実行方式を調査する |

## ビルドとテスト

```sh
git clone https://github.com/gogo-fpga/toolchain.git
cd toolchain
git submodule update --init --depth 1
git -C third_party/vexriscv submodule update --init --depth 1 -- pythondata_cpu_vexriscv/verilog/ext/VexRiscv
git -C vendor/emsdk fetch --depth=1 --tags origin  # build-wasm.sh に必要な emsdk のタグを取得。CI の build.yml と同じ
npm ci
scripts/build-wasm.sh
scripts/build-decoders.sh
scripts/build-synth-wasm.sh
scripts/build-pnr-wasm.sh
scripts/build-ghdl-wasm.sh
scripts/build-pack-assets.sh
scripts/build-iverilog-wasm.sh
scripts/build-surfer.sh
scripts/build-web.sh
tests/fixtures/build-fs.sh
node --test tests/web/*.test.mjs
WASM_BUILD_ROOT=build node --test --test-concurrency=1 tests/sim/*.test.mjs
npx playwright install --with-deps chromium
npx playwright test
python3 dist/serve.py --port 8000
```

書き込み部は Emscripten、合成・配置配線と Icarus Verilog は WASI SDK、GHDL の合成部は AdaWebPack と WASI SDK、Surfer は Rust で WASM にします。Apicula は Pyodide で動かします。`scripts/build-web.sh` が Web 画面と各ツールの資材・ライセンスを `dist/` にまとめます。

ビルドには Autotools、CMake 3.28 以上、rustup などが必要です。`scripts/build-wasm.sh` は `vendor/emsdk` を使います。ツールの固定版と取得元は [RESEARCH.md](RESEARCH.md) を参照してください。

ネイティブ版は比較テストの参照用で、製品として配布するものではありません。比較には Yosys、nextpnr、Icarus Verilog の `--native` ビルドも必要です。

nextpnrのheap placerは、Eigenのベクトル化と浮動小数点演算の縮約を無効にしてビルドします。[SERV / 20Kの固定条件の比較](docs/experiments/S14A-pnr-fp-contract.md)に根拠と制約を記録しました。native / WASIの配置JSONは、キー順やcreatorを置き換えずに比較します。[修正後の全60組回帰](docs/experiments/S14A-final-regression.md)はHDL32組成功、CPU18組成功・6組容量超過・4組frontend非対応で、全列監査と証拠を保存しました。これは手元の固定版の確認で、CI全体や実機の成功を意味しません。

```sh
scripts/build-synth-wasm.sh --native
scripts/build-pnr-wasm.sh --native
scripts/build-iverilog-wasm.sh --native
node --test tests/synth/*.test.mjs
```

自動検証はブラウザーと仮想 USB で行います。実機の Tang Nano では試していません。

## ライセンス

本リポジトリー自体は BSD-3-Clause です。配布物に含める第三者のソフトウェアとライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

EUPL-1.2 の Surfer v0.7.0 と WASM 実行時依存のライセンス一覧も配布物に含まれます。