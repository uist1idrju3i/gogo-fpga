# S14 カタログ昇格後の全候補回帰と配布ソースの照合

[実験の索引](README.md) / [HDLの正式反復](S14-production-hdl.md) / [CPUの正式反復と初回の失敗](S14-production-cpu.md)

本書の前半は9e098b9の記録です。Native Stack整列後の07e2256による再検査は、後半の「整列後の同一revision検証」に分けます。以前の結果と失敗記録は保持します。

## 目的と固定条件

CPUのカタログ昇格後、通常の選択制限を緩めずに全60組を再検査しました。実行したcommitは `9e098b99fa18667a62d5b11b3f29ce74e33fd4ea` です。途中でcheckout、入力、実行スクリプトを変更していません。正式な配置配線5回反復とは別の、ZIP読み戻しから合成・配置配線・packまでを含む最終回帰です。

Node.js v24.21.0、Yosys 0.70（28ba3cb92）、nextpnr 0.11.1、Pyodide 314.0.7、Python 3.14.2、zstd 1.5.7を使用しました。製品用のnative / WASIバイナリーと検証済み資材を再利用しています。新たなコンパイラーのビルド時間を測った試行ではありません。GHDL native参照版は、ホストのglibc不足を避けるため、同じcheckoutをbind mountした固定版の隔離環境で実行しました。

判定はS14の事前基準と `tests/synth/gowin-pack.test.mjs` に従います。成功は生の配置配線JSON、資源、pack後のbitstreamの一致を要求します。容量超過とfrontend非対応を成功したbitstreamに数えません。容量超過には数値で示す資源不足とnative / WASIの実診断、frontend非対応にはnative / WASMの同一解析エラーを要求します。

## 全60組の結果と全列監査

| 対象 | 組数 | 成功 | 容量超過 | frontend非対応 | CSVの行×列 | 空欄を含む全値 | 実測の末端値 |
|---|---:|---:|---:|---:|---:|---:|---:|
| HDL8部品×4ボード | 32 | 32 | 0 | 0 | 32×119 | 3,808 | 3,064 |
| CPU7候補×4ボード | 28 | 18 | 6 | 4 | 28×139 | 3,892 | 2,530 |

Node testの結果はHDLが33件成功、CPUが29件成功です。親のテストを含むため、組数とは1件ずつ異なります。全体の所要時間はHDLが2,030,910 ms、CPUが2,676,309 msでした。両者の並行負荷があり、独立した性能比較ではありません。

生の値は [HDLの全列CSV](S14-final-regression-hdl.csv) と [CPUの全列CSV](S14-final-regression-cpu.csv) に保持します。CSVはCRLFを含む元のbyte列を保持し、Gitで改行を変換しません。元の全measurementを読み、CSVの全フィールドを別のPython読取りでも照合しました。status、通常選択の拒否、catalogのboard state、CPUのlowered netlistでの正常実行とLED固定の負の対照、CPU回路・RAMの保持、資源、終了値、時間・メモリー、ZIP・合成・配置配線・bitstreamのhashを確認しました。存在する全成果物もサイズとSHA-256を採取しています。

通常APIはconfirmedの候補だけを通します。容量超過とfrontend非対応の10組は通常APIの拒否を再確認した後、検査専用の `requireConfirmed: false` 経路だけで測定しました。HDL / CPUとも既存の出力先を指定する負の対照はEEXIST・終了値1となり、sentinelと既存ファイルが変わらないことを確認しました。最終回帰は別の新規出力先で完走しています。

監査を再実行する手順です。生成元のcheckoutと資材、出力一式を保持し、出力先は存在しないファイル名を指定します。監査器はGitの作業状態と入力の差分も検査し、記録したrevisionから検査対象のコードやpinが変わっていれば停止します。

```sh
# 同じ製品用バイナリーを検証してから、未使用の出力先で実行する
PATH="$PWD/vendor/zstd/programs:$PATH" HDL_MATRIX_EVIDENCE=build/t5-final-hdl node --test --test-name-pattern='pinned HDL' tests/synth/gowin-pack.test.mjs
PATH="$PWD/vendor/zstd/programs:$PATH" CPU_MATRIX_EVIDENCE=build/t5-final-cpu node --test --test-name-pattern='pinned CPU' tests/synth/gowin-pack.test.mjs
node scripts/audit-library-matrix.mjs hdl build/t5-final-hdl build/t5-final-hdl-audit.json 9e098b99fa18667a62d5b11b3f29ce74e33fd4ea
node scripts/audit-library-matrix.mjs cpu build/t5-final-cpu build/t5-final-cpu-audit.json 9e098b99fa18667a62d5b11b3f29ce74e33fd4ea
```

GHDLのnative参照版がホスト上で実行できない環境では、`GHDL_NATIVE_BIN` に同じ固定版を起動する隔離環境のwrapperを指定します。新しいcommitでmatrixを実行した場合は、そのcommitと新規出力先を記録し、上のrevisionの検証と混同しません。

## 診断の監査

全候補の標準出力・標準エラーを読み、成功と期待した失敗を分けました。HDLの警告は重複を除いて253行で、`translate_off` コメントの扱い1種とメモリーのレジスター化252種でした。後者は展開後の関数名が異なる行を含みます。CPUの警告とERROR行は重複を除いて51行で、次のように根拠を確認しました。

| 診断 | 根拠と扱い |
|---|---|
| SERVの `i_raddr` 範囲外 | `third_party/serv/rtl/serv_rf_ram.v` の未適用の既定parameterに対する解析時の警告です。固定fixtureはRF_WIDTH=2です。4ボードとも実際のlowered netlistのアドレスは9bit、regzeroのreduce入力は有効な `[8:4]` だけで、未定義bitを含まないことを照合しました |
| SERV/4KのBRAM幅 | `vendor/yosys/techlibs/gowin/brams_map.v` の汎用幅変換macroが2bitポートの未使用上位bitを参照する警告です。nativeとWASIで同じ12種を出力します。配置配線の一致をBRAMの全設定に対する機能証明とは扱いません |
| VexRiscvの未駆動3信号 | 生成済み `VexRiscv_Min.v` のmtvec mode 2bitとisRvcです。4ボードともlowering後・mapping後のnetnamesに元の信号と伝搬先の別名が残らないことを確認しました。生成元のRTLを編集したり、警告を抑止したりしていません |
| NEORV32のFPU component未結合 | 固定fixtureはRV32Eで、`RISCV_ISA_Zfinx` の既定値はfalseです。未使用のFPUに属するcomponentの警告です。FPUを有効にした構成の確認とは扱いません |
| メモリーのレジスター化、translate_off | 合成による展開として保持し、回路・RAM保持の検査とプログラム実行の結果を別に確認しました |
| 1Kの配置ERROR | CPU6候補の数値上の容量不足に対応する期待した失敗です。終了値、資源不足、出力が未生成であることを照合しました |
| FemtoRVの解析失敗 | native / WASMで同じ実際のIcarus解析失敗です。配置配線やbitstreamの成功として数えません |

この監査は合成後の全セルを含む形式的な等価証明、配置配線後のタイミングシミュレーション、Tang Nano実機の動作確認ではありません。元の警告・失敗ログは保持し、原文を検査に合わせて書き換えていません。

## 同一commitの機能回帰と配布

| 検査 | 結果 |
|---|---|
| Web単体・Icarus | 178件成功 |
| CPU実行・GHDL native / WASM | CPU9件とGHDL19件がそれぞれ成功 |
| Web組立 | zstd 1.5.7とbuild-infoを照合して成功 |
| package-release | ソースtar.gz・Web ZIPとSHA256SUMSの2件を照合して成功 |
| Git情報なしのソース | 22候補の資材を再生成し、Webを組み立て、catalogと全107 source/license assetが元の配布物と全バイト一致 |
| ソースとWeb ZIP | ソース45,220ファイル、Web695ファイルを監査。22gitlinkとgitcommit、README、LICENSE、NOTICE、THIRD_PARTY_NOTICES、rootとSurferのlicense原文、synth・pack・Icarus・Surferの配布byteを照合 |
| 静的配信の制限 | Web ZIPの全ファイルが25 MiB未満、安全なarchive path、重複名なし、ソースにGit管理情報なし |

Git情報なしの再生成では検証済みWASMとnpm依存を再利用しました。配布ソースだけから全コンパイラーを新たにビルドした検証ではありません。初回にホストのglibc不足で停止したCPUテストと、旧zstd設定で停止したWeb組立のログも、隔離環境・固定版設定による成功ログと区別して保持します。

## ハッシュと未確認範囲

| 証拠 | SHA-256 |
|---|---|
| HDL全列CSV | `d8862aefa02c32e765c8467807df9fe8e41ae2026919d0448eefd067a26cea1f` |
| CPU全列CSV | `8a28eba939388a97013b3cb68b22bf3a15664192535b766c88850d2fcd319195` |
| catalog | `2df56365ba336356587bd0e611dab5894bca6dd10fb5bf8861f9efbaa6e2d91c` |
| HDL完走ログ | `bc71801f83542c58447f8e0e0966a7c69f8bd3dba18982a3770497bad871b6f3` |
| CPU完走ログ | `42b817f9a013fbc618cb1dafb66a53657444892bafbff593b31967b92c52d74c` |
| Git情報なしのsource closure監査 | `0670f861e31f3bba766827374bac4abc4f2a5057c7548bdbdc4c73bf87b360da` |
| no-overwrite監査 | `cf61bf3631378ae3f0d5fb4dbb41e5a93165a162ff4b8369a7e797bd34326d0e` |
| ソースtar.gz | `c46a9c88f8146dd25be3825ba930def2841182c4cb1a887a2ebc3e9c089a75bd` |
| Web ZIP | `6e3bafcaaf5a204ec390d091c4522ff0b4e8011d19e3b86de2d2dbeda67fb4cd` |

ここに記録した結果は9e098b9の確認です。Native Stack整列後のrevisionとCIは、その後の回帰結果を読むまで確認済みと扱いません。T6、S5の比較専用4件、S8のcache/RSSなどの残件は別です。手動の画面操作録画とTang Nano実機は本リポジトリでは試していません。Cloudflare Pagesへの公開と設定変更も行っていません。

## 整列後の同一revision検証

Native Stack整列後の `07e2256a1c090abc456af60830f514e36af6085a` を固定し、同じ製品用バイナリーと資材で再検査しました。途中で入力、実行スクリプト、checkoutは変更していません。配布資材の組立が完了してから全60組を実行しました。以後の文書や監査器の追加commitそのものを、この測定済みrevisionと混同しません。

| 対象 | 組数 | 成功 | 容量超過 | frontend非対応 | 全列の値 | 実測の末端値 |
|---|---:|---:|---:|---:|---:|---:|
| HDL | 32 | 32 | 0 | 0 | 32行119列、3,808値 | 3,064 |
| CPU | 28 | 18 | 6 | 4 | 28行139列、3,892値 | 2,530 |

Node testはHDL33件、CPU29件が成功し、失敗とskipは0でした。親testを含みます。所要時間はHDLが1,441,489 ms、CPUが1,909,727 msで、並行負荷があるため性能の比較には使いません。生の [HDL CSV](S14-post-stack-hdl.csv) と [CPU CSV](S14-post-stack-cpu.csv) はCRLFを含めて保持します。JavaScriptの監査器と独立したPythonのCSV読取りで、全7,700値をmeasurementと照合しました。成功18組のPNR JSONとbitstreamはnative / WASIで一致し、CPU24組のlowered netlistで正常実行とLED固定の負の対照を確認しました。FemtoRV4組は同じ実際のfrontend解析失敗であり、bitstreamの成功ではありません。

通常APIの拒否、catalog state、status、全資源、hash、時間・メモリー、出力の欠落と終了値を再監査しました。全ログから重複しない警告・ERRORなどの診断を抽出し、HDL253行、CPU51行を再読しました。別にHDL4種類、CPU3種類のcritical path reportのInfo行も確認しました。上記の「診断の監査」と同じ原因で、新たな未分類の診断はありません。SERVの既定parameter、BRAM幅変換、VexRiscvの未駆動信号、未使用のNEORV32 FPUは上流由来です。容量超過は固定fixtureと1Kの組合せ、FemtoRVは固定版frontendとの組合せに属します。配布組立との競合による初回の資材欠落は検査環境の問題で、候補の容量・言語分類には加えません。

再実行時には、前掲のmatrixコマンドの出力先を `build/t5-post-stack-07e2256-hdl` と `build/t5-post-stack-07e2256-cpu-attempt2`、監査のrevisionを上記の完全長SHAへ置き換えます。既存出力先の負の対照は、別のsentinel付きディレクトリーをHDL / CPUへそれぞれ指定しました。どちらもEEXIST・終了値1となり、before / afterの全ファイル名とSHA-256は一致しました。

### 配布ソースと失敗した試行

[E2Eの失敗試行と修正後876c2a8の結果](S14-post-stack-e2e.md)へ、4段落の本文を変えずに移しました。全60組と07e2256の配布ソース照合は本書に保持します。

同じ07e2256でWeb組立、package-release、SHA256SUMSの2件、GHDL19件、CPU実行9件、Web・Icarusなどの回帰192件が成功しました。Git情報のない配布ソースから全22候補を再生成し、全107資材を照合しました。rootの457追跡ファイルとsymlink、直接の35gitlink、source TAR内の45,227ファイル、Web ZIPの695ファイル、NOTICE・ライセンス原文、全distファイルを照合しています。Webの全ファイルは25 MiB未満です。検証済みWASMとnpm依存を再利用した組立で、全コンパイラーを配布ソースから新規ビルドした確認ではありません。

配布ソースの照合は `scripts/audit-release-closure.py` へ移し、合成fixtureと改変・欠落・危険なpath・重複ZIP・no-overwriteの負の対照を9件追加しました。出力先は未使用のJSONを指定します。入力の相対pathは次の例に対応させます。

```sh
python3 scripts/audit-release-closure.py --root . \
  --source build/t5-source-closure-07e2256/toolchain-source-v0.1.0-t5.07e2256 \
  --generated-libraries build/t5-source-closure-07e2256/generated-libraries \
  --version v0.1.0-t5.07e2256 --revision 07e2256a1c090abc456af60830f514e36af6085a \
  --output build/t5-source-closure-audit-new.json
python3 -m unittest discover -s tests/check-release-closure -p 'test_*.py' -v
```

初回CPU matrixは、共用のbuild/packをWeb組立が再生成し、Apicula wheelが欠けて候補の実行前に停止しました。ログを保持し、資材生成後の新しい出力先で完走しました。Git情報なしのWeb組立でSDKとzstdの実行環境が不足した試行も、成功のログと分けて保持します。監査器の予備試行ではvendor/emsdkに存在しない.gitcommitを要求して停止しました。ソースを書き換えず、既存のRELEASE-SOURCE.jsonと、markerのない依存には指定commitのGit archiveを照合するよう検査器を修正しました。

| 証拠 | SHA-256 |
|---|---|
| 整列後HDL CSV | `051b2f61324c9fb251b88dfc5054c6bca69cdd324de9b0eb43b94f7a9f872310` |
| 整列後CPU CSV | `7e8b6012a36bd5a4b616c9bc29a46f2dee9d02e5e03a2f6458ab58b65edb67cd` |
| HDL全列監査JSON | `dd288f0ea2cc89a19a4707043da85d7c8c999e3eec9fbfd6fab4e9488090dce8` |
| CPU全列監査JSON | `f974d93a961acf48a39f1688abbce94436e8cdb04588b70b910eed5b02fddfc5` |
| source closure監査JSON | `094fd4d1106ace114eefc2bc29af757ab058593e30028b02ed94119c63a9bf57` |
| no-overwrite監査JSON | `a80a537412eaac52a5e92e690709c99634189ac16dcc6a173db093d0f5fbabbe` |
| HDL完走ログ | `760ff60ea27cf1f8cd7cb133a8e66b3266e398b359bb9eac8cde051beb3c734f` |
| CPU初回の資材競合ログ | `b9c7ae9ffc21e133e272a8d86b44faadc62f55fc44fb6e6099f5f22bb8a15a31` |
| CPU再実行の完走ログ | `b93bf5be95a0f79222cc5fab94dcf4edb625b842a32fbf61d8f61d8411213322` |
| ソースtar.gz | `a68c5a52f2f7d5d79dc7982195efd822558ff13d8179946325304c7eda5e10e3` |
| Web ZIP | `f55960351c7897a07f01e793f4be2006e7a8666e930892f5fed6df24e948b9e2` |

CI、T6、S5の比較専用4件、S8の残件は別途確認します。手動操作の録画、Tang Nano実機、Cloudflare Pages公開は未実施です。
