# HDL ライブラリーと CPU コアの調査

調査日: 2026-11-01

T5 では22候補を登録します。現段階の HDL は VHDL と Verilog です。SystemVerilog、Scala の生成環境、VHDL のシミュレーターは持ち込みません。候補の登録と、部品が特定のボードで動くことの確認は別に扱います。

## 固定版と原典

- 取得元と監視する branch は [`.gitmodules`](../../.gitmodules) が正です。
- 固定する commit は `third_party/` の gitlink が正です。`git ls-tree -r HEAD -- third_party/` で確認できます。
- [部品カタログ](../../libraries/catalog.json)は表示名、言語、ライセンス文書、依存を含む部品の定義を持ちます。取得元と commit の固定値は重複して書きません。
- `scripts/build-library-assets.py` は gitlink と一致する checkout を要求し、固定した commit の blob から資材を作ります。作業ツリー上の変更を混入させず、上流のファイルとライセンス本文をそのまま配布します。
- 生成する `dist/libraries/catalog.json` は取得元、commit、各ファイルの元のパス、サイズ、SHA-256 を含みます。ビルドで生成する記録であり、手書きの pin ではありません。

取得は `git submodule update --init --depth 1 -- third_party/` を使います。上流の submodule は再帰的に取得しません。ソースは参照する部品ごとに選び、取得できていない依存を黙って省きません。

## 候補とライセンス

次のライセンスは、各固定版の本文を確認した分類です。部品ごとのソースヘッダーも残します。表の分類だけで、選択したすべてのファイルの条件を置き換えるものではありません。

| 候補 | 用途・言語 | ライセンス | 本文の upstream 内パス |
|---|---|---|---|
| Colibri | ライブラリー・VHDL | 主な RTL は CERN-OHL-W-2.0 | `LICENSES/CERN-OHL-W-2.0.txt`、`LICENSES/Apache-2.0.txt`、`LICENSES/CC-BY-SA-4.0.txt` |
| Open Logic | ライブラリー・VHDL | PSI HDL Library License 1.0 | `License.txt` |
| hdl-modules | ライブラリー・VHDL | BSD-3-Clause | `license.txt` |
| verilog-axis | ライブラリー・Verilog | MIT | `COPYING` |
| verilog-uart | ライブラリー・Verilog | MIT | `COPYING` |
| libfpga | ライブラリー・Verilog | MIT | `LICENSE` |
| verilog-axi | ライブラリー・Verilog | MIT | `COPYING` |
| verilog-ethernet | ライブラリー・Verilog | MIT | `COPYING` |
| SERV | CPU・Verilog | ISC | `LICENSE` |
| PicoRV32 | CPU・Verilog | ISC | `COPYING` |
| NEORV32 | CPU・VHDL | BSD-3-Clause | `LICENSE` |
| Hazard3 | CPU・Verilog | Apache-2.0 | `LICENSE` |
| VexRiscv の生成済みリポジトリー | CPU・Verilog | MIT | `LICENSE` と `pythondata_cpu_vexriscv/verilog/ext/VexRiscv/LICENSE` |
| DarkRISCV | CPU・Verilog | BSD-3-Clause | `LICENSE` |
| learn-fpga の FemtoRV | CPU・Verilog | BSD-3-Clause | `LICENSE` |
| Ibex | CPU・SystemVerilog | Apache-2.0 | `LICENSE`、`NOTICE` |
| CV32E40P | CPU・SystemVerilog | SHL-0.51 または Apache-2.0 | `LICENSE` |
| VexiiRiscv | CPU・Scala | MIT | `LICENSE` |
| OSVVM | 検証用・VHDL | Apache-2.0 | `LICENSE.md` |
| UVVM | 検証用・VHDL | Apache-2.0 | `LICENSE` |
| VUnit | 検証用・VHDL | HDL と Python 等は MPL-2.0 | `LICENSE.rst` とソースヘッダー |
| Taxi | ライブラリー・SystemVerilog | CERN-OHL-S-2.0 | `LICENSE` |

Open Logic の本文は GNU Library GPL v2 以降を基にした PSI HDL Library License 1.0 です。FPGA 等の生成物への例外を含むため、単純な LGPL-2.1 の表示はしません。カタログでは `LicenseRef-PSI-HDL-1.0` として原文へ案内します。

Colibri は RTL、文書、メタデータで条件が異なります。上記3文書を保持し、選択するファイルの SPDX 表記も含めます。VUnit の図版に使うフォントは別の条件です。カタログへ登録しただけで、これらの図版やフォントを配布するわけではありません。

Taxi の有償ライセンスには別途契約が必要です。MIT の旧ライブラリーを Taxi へ置き換えたり、有償ライセンスを自動で適用したりしません。

## 対応範囲と保守状況

HDL ライブラリー8候補と CPU 7候補は、代表部品、依存の解析、合成、動作を検証する対象です。登録直後の状態は「未検証」です。ボードの容量超過、言語の非対応、未検証は区別します。CPU はプログラムの実行による出力を確認し、定数化された回路だけで合格としません。

その後、[製品用HDLの正式反復](../experiments/S14-production-hdl.md)で8部品の全4ボード、[製品用CPUの正式反復](../experiments/S14-production-cpu.md)で6候補の4K・9K・20Kを、両系の配置配線各5回の一致からconfirmedへ更新しました。CPU6候補の1Kはcapacity-exceeded、FemtoRV Quarkの全ボードはIcarus 13.0の宣言前参照の解析エラーからfrontend-unsupportedとし、選択できない理由を表示します。全CPU構成や実機を確認した結果ではありません。正式反復には生CSV、全列監査、対照、版とhash、再生成手順を保存しました。

実行したfrontendで非対応と確認した候補は、候補全体の状態も `frontend-unsupported` とし、未検証や言語自体が対象外の `unsupported` と分けます。部品とボードの根拠は削除せず保持し、全てのボードが同じfrontend非対応でなければカタログを拒否します。確認済みのボードをこの分類に混在させて選択可能にすることはできません。

Ibex、CV32E40P、Taxi は SystemVerilog、VexiiRiscv は Scala からの生成が必要なため、現段階では非対応です。OSVVM、UVVM、VUnit は VHDL の検証用で、現段階のシミュレーターでは実行できません。この7候補は理由付きで残し、選択できない状態で表示する対象です。

`verilog-axis`、`verilog-uart`、`verilog-axi`、`verilog-ethernet` は、固定版の README が deprecated と明記し、後継に Taxi を案内しています。保守終了の表示を残し、明示的な選択だけで使います。

VHDL の依存にはコンパイル順と library 名を保持します。ソースの文字列置換で名前付き library を `work` へ変更しません。Verilog の include、define、ROM 等のデータも部品の定義に含めます。FuseSoC、LiteX、SpinalHDL の生成環境や C/C++ のツールチェーンをブラウザーへ持ち込みません。

## 更新監視

`.github/scripts/check-pins.py consistency` は、全 `third_party/` とカタログの対応、gitlink、監視用 branch を検査します。取得元と固定版の重複した手書き定義は拒否します。

「固定版の更新確認」の週次実行は、GitHub と GitLab の双方を `.gitmodules` の URL から調べます。branch 先端との差を判定し、安定版のタグがあれば参考値も記録します。タグ付き依存をタグで比べる既存の処理とは分けています。取得できない場合は「最新」ではなく「要確認」にします。

結果は既存の追跡 Issue にまとめます。自動で版を採用せず、更新時に vendor-update の手順で変更履歴、破壊的変更、セキュリティ修正、新機能、ライセンス条件を確認します。

## 初期調査からの訂正

- `RESEARCH.md` 5章の初期転記表が示す Colibri の GitLab.com URL は採用しません。固定版の README と CERN GitLab の API を照合し、取得元を `https://gitlab.cern.ch/colibri/colibri.git` と確認しました。
- Open Logic の初期転記表にあった LGPL-2.1-or-later の分類は訂正します。固定版の `License.txt` は上記の PSI HDL Library License 1.0 です。
- CV32E40P と OSVVM は API のライセンス分類だけで判断せず、固定版の本文を読みました。CV32E40P の Solderpad 本文の版は 0.51 です。

## 配布と検証の境界

Web 配布物には静的カタログ、必要なライセンス本文、登録した部品のソースを含めます。Release のソースアーカイブには `third_party/` の固定版も含めます。実行時に GitHub や GitLab へ設計データを送信する構成ではありません。

ソースアーカイブには、生成した `libraries/source-manifest.json` と各依存の `.gitcommit` も含めます。Git の履歴がなくても、記録したハッシュと原文ファイルを照合して静的資材を再生成できます。Release のパッケージ処理はこの再生成結果を元のカタログと比較します。この照合は破損の検出であり、アーカイブ単体で upstream の真正性を証明するものではありません。

VexRiscv の生成済み RTL パッケージの `LICENSE` は、著作権者の欄が未記入の雛形でした。原文を書き換えずに保持し、同じパッケージが gitlink で固定する入れ子の VexRiscv ソースの `LICENSE` も同梱します。後者には `Copyright (c) 2016 Spinal HDL contributors` とあります。生成済み RTL のヘッダーにある Git hash は、この gitlink と異なります。ヘッダーの値を生成元の固定版として転記せず、生成済みパッケージの revision と入れ子の gitlink を分けて記録します。生成器を動かして同じ RTL を再生成する検証は、今回の範囲に含めません。

資材ごとの `provenance` は、入れ子のパス、親の固定版の `.gitmodules` にある HTTPS URL、親 tree の gitlink revision を保持します。生成器は、入れ子の checkout の revision が gitlink と一致することを要求し、未取得の checkout、別の revision、パス中のシンボリックリンクを拒否します。作業中に変更したファイルや `.gitmodules` から原文や URL を取り込みません。Release のソースアーカイブへは、必要な入れ子の原文ファイルも追加します。

生成器の手元の予備検証では、22候補のカタログと107件の資材記録について、Git を呼べない状態のソースアーカイブから再生成した結果が、元のサイズ、SHA-256、内容と一致しました。これは作業中の生成器の機械的な検証であり、最終 commit の Release 全体や CPU の対応ボードの確認ではありません。

portable ZIP は、選択した依存と原文のライセンスを同梱します。schema 3 の `libraries` は部品、固定版、manifest のハッシュを保持します。旧 schema 1・2 は選択なしで移行し、シミュレーションの設定を保持します。ZIP の全項目は256項目、展開後16 MiB 以下です。ソースだけでなく、ライセンス、データ、manifest、`project.json` も制限に算入します。

manifest とファイルのサイズ・SHA-256 を検査し、同じ部品の異なる版、依存の循環、不足、衝突を拒否します。古い snapshot はその版のまま保持し、現行のカタログへ自動で置き換えません。ZIP 自身に書かれたハッシュの一致だけで、upstream の真正性を確認したとは表示しません。現行の配布カタログとの一致、照合できない場合、不一致を区別します。

依存のソースとデータは合成とシミュレーションで同じ closure を使います。原文のライセンスと manifest はコンパイラーへ渡しません。VHDL のソースは現段階のシミュレーターから除外します。GHDL へ渡すデータも、ソースとは区別して仮想ファイルシステムに配置します。

名前付き VHDL library は、既存の Ada binding から上流の `Libraries.Work_Library_Name` と `Libraries.Load_Work_Library(True)` を使って切り替えます。`work` を含むソースを書き換えず、現在の library を表す VHDL の意味を保ちます。上流の実装も、ファイルの間で `--work=` を切り替えるため、読み込んだ library を保持して再選択できる構造です。合成時には `work` へ戻します。この API を持たない旧 WASM 資材では、名前付き library を明示的に拒否します。

参照元は固定版の `vendor/ghdl/src/libraries.adb` の `Load_Work_Library` と `Get_Library_No_Create` です。本体のソースは変更せず、`scripts/ghdl-wasm/synth_api.ads`・`synth_api.adb` で公開します。依存の順序は library を含む名前で判断し、異なる library の同名単位は区別します。同じ library 内の単位の重複、不足、循環は拒否します。混在合成の入口は `work` の entity に限り、外部 library の同名 entity を入口と取り違えないようにします。

実 WASM の回帰テストでは、VHDL-2008・2019 の双方で、異なる library の同名 package・entity と `work` の参照を native の生成 Verilog と照合します。誤った library の指定、旧 API での名前付き library の利用、ROM データの不足も負の対照にします。ROM を認識した診断が生成 Verilog に混ざらないよう、標準出力と標準エラーを分けます。診断はログに残し、標準出力だけを次の合成工程へ渡します。

選択画面は同一オリジンの静的カタログと資材だけを取得し、リダイレクトを拒否します。ソース等は検証後に保存し、その後でプロジェクトを切り替えます。取得や検証が失敗しても、旧プロジェクトを途中の依存で置き換えません。選択解除はカタログを取得できない場合も使えます。他の選択から参照される依存と原文のライセンスは残します。

資材生成の単体テストと、ブラウザー統合・ボードでの動作確認は別です。ライセンス文書とカタログの生成だけで、4ボードへの対応や CPU の動作を確認した扱いにはしません。実機への書き込みは本リポジトリでは試していない。

## 代表部品の回帰検証

### VHDL の3候補

| 候補 / 部品 | ソースの library | 代表構成 |
|---|---|---|
| Colibri / counter | `colibri` | 剰余10、幅4のカウンター。`utils` に依存 |
| Open Logic / gray | `olo` | 幅8の Gray 符号変換と逆変換。array・math・logic の package を使用 |
| hdl-modules / handshake-pipeline | `common` | 幅8、full throughput、制御とデータのパイプライン。入力の値を保持し、周期的に出力を停止・再開 |

`tests/fixtures/libraries/` に自作の小さな回路を置き、上流ソースは固定版のカタログから読み込みます。`tests/synth/ghdl-wasm.test.mjs` は、ライセンス付き ZIP の往復後、共通のプロジェクト入力から native GHDL と実 WASM で Verilog を生成し、バイト単位で照合します。名前付き library のメタデータも保持することを検査します。この比較だけで、回路の機能や4ボードへの対応を確認した扱いにはしません。

### libfpga の代表回路

`tests/synth/iverilog-wasm.test.mjs` は、固定した `libfpga/gray` を選択し、依存とライセンスを含む ZIP を往復してから native と WASM で動かします。幅8の全256入力について Gray 符号、逆変換、隣接符号の1ビット差を確認し、標準出力と VCD を照合します。期待値を変えた負の対照と、ZIP 内のソースを改変した場合の拒否も含みます。

### Verilog の残り4候補

| 候補 / 部品 | 代表構成 |
|---|---|
| verilog-axis / register | 幅8、skid buffer。周期的に出力を停止・再開 |
| verilog-uart / uart | 幅8、prescale 1。送信と受信を直結する loopback |
| verilog-axi / read-register | 幅8のアドレスとデータ、AR・R とも skid buffer。受け取ったアドレスに対応する値を応答 |
| verilog-ethernet / crc | 幅16、生成多項式 `0x1021`、Galois 方式。8ビットずつ処理 |

これらは保守終了の候補です。原文の MIT ライセンスと保守状況を残し、Taxi へ自動で置き換えません。UART の3ソースは、送信、受信、接続用の順序を保持します。

### 8候補共通の機能と bitstream の検査

`tests/fixtures/libraries/cases.mjs` は、上記8候補の代表構成を定義します。`tests/synth/library-components.test.mjs` は、それぞれのソースとライセンスを ZIP で往復してから、独立した期待値で機能を検査します。VHDL は実 WASM の GHDL で生成した Verilog を Icarus で実行します。VHDL ソースを直接シミュレーションする検査ではなく、Web 画面の VHDL シミュレーターも追加しません。

Gray 符号と剰余10のカウンターは周期ごとの期待値と照合します。CRC は、上流の並列回路とは別に、1ビットずつ計算する参照式を使います。パイプラインは停止・再開を含む値の順序、AXI Lite は要求したアドレスに対する応答、UART は全256通りの値を通る送受信を確認します。進行しない回路も失敗にします。Icarus の native と WASM で終了状態、標準出力、VCD を照合し、期待値を変える負の対照では双方が失敗することを確認します。ZIP 内のソースを改変した場合は、実行前にハッシュ検査で拒否します。

`tests/synth/gowin-pack.test.mjs` は、同じ8構成を Tang Nano 1K・4K・9K・20K の各プロジェクトへ組み込みます。ZIP の往復後、共通の依存入力から WASI Yosys、WASI nextpnr、Pyodide の pack まで実行します。VHDL の前段には名前付き library を保持する GHDL を使います。同じ配置配線結果を pack した native の `.fs` とバイト単位で一致すること、IDCODE が対象ボードに一致することを検査します。制約ファイルとデータを Verilog の入力に混入させず、状態を持つ回路が残っていることも検査します。失敗した試行の ZIP と工程別の出力は、`build/t5-library-flow-*` に残します。

これは上記の代表構成に対するツールの回帰検証です。ライブラリー全体、すべてのパラメーター、実機の動作を確認したという意味ではありません。実機の Tang Nano は本リポジトリでは試していない状態です。カタログの有効化は、残りの代表部品と測定記録の確認を含む T5 の検証で判断します。

## Web配布物の組立で必要なソース

Web配布物は組立時に22候補の固定ソースとライセンスを読み直します。E2Eジョブも `third_party/` とVexRiscvの入れ子のcheckoutが必要です。ビルド済みWASMだけでは足りず、未取得のcheckoutは固定版不一致として拒否します。この検査は緩めず、E2E実行前の取得手順を回帰テストで保持します。
