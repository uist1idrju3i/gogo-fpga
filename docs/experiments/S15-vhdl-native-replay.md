# S15 P1: 元のVHDLによる反例の独立再実行

## 目的と採否の基準

基準は`2e5e9f28dd359130bc6696ab530bf0af15886273`です。GHDLが生成したVerilogだけでなく、元のVHDLを変更せずにnative GHDLで実行し、SAT反例の入出力とassertion違反を照合します。VHDLとPSLのparser、monitor、runtimeは上流GHDLを再利用します。この検査用nativeプラグインはWeb製品の構成要素ではありません。

上流の`--vpi-compile`と`--vpi-link`で検査用Cプラグインをビルドします。GHDLのVPIで入力とclockを駆動し、全ての非clockポートの幅・方向・値を調べます。runtimeの診断と`--psl-report`のJSONを元のproperty一覧へ結び付け、独立したVCDでも全入力・出力・clock遷移を照合します。ポート一覧の欠落や余剰、unknown、未初期化の状態、欠けたwitness、診断の不一致、前提違反、非正常終了は成功にしません。

正式反復の前に、通常assertion、clocked PSL、両clock極性、深さ境界と帰納法の反例を検査します。出力・入力・初期値・property・VPIプロトコルを壊した負の対照を全て拒否することを条件にします。通常assertionとPSLを一律の1ステップずれで補正せず、最後のPSL評価用edgeで生じた範囲外の通常assertion違反をwitnessの証拠に数えません。正式反復は清浄な同一commitで5回以上とA/Aを行い、CSVの全列と元のファイルを照合してから判定します。

## 評価タイミングと検査方法

最初の状態は0 nsで入力を与え、2 nsで観測します。2状態目からは10 ns間隔でclock edgeを与え、1 ns後に次の入力、2 ns後に入出力を観測します。PSLを有効にした場合だけ、最後にもう一つedgeを与えます。上流runtimeはclocked PSLをedge直前の状態で評価し、通常の並行assertionは状態変更に伴って評価するため、この区別を記録します。

全てのdrive・edge・観測・flush・終了markerを順に照合し、診断の時刻も前後のmarkerの間にあることを確かめます。入力切り替え前の隙間で通常assertionが失敗し、その入力が前後で変わる場合は曖昧として拒否します。これは任意のdelta-cycle挙動の同値性を保証するものではありません。

VCDはscope、変数、幅、時刻、値の変更、終了時刻を読みます。検査時刻ごとに全ポートの期待値を照合し、clockの全遷移も比較します。ファイルの存在や終了markerの検索だけでは合格にしません。

PSLのレポートはGHDLの`grt-psl.adb`が出力したものを読み、ラベル、元ファイルと行、directive、started/finished count、status、summaryを調べます。assert/assumeの違反回数は診断数とも一致する必要があります。明示したassumeとcoverが欠けたレポートを拒否します。合成時にassertionから作られるactivation coverは元の明示的coverと区別します。

## 予備検査と失敗の記録

未コミットの実装で、統合・全列監査15件と検査器単体40件、計55件が成功しました。GHDL native/WASMとYosys native/WASIの4通りから得た28反例を元のVHDLで再実行し、実runtimeを使った12件の負の対照も拒否しました。この予備検査の時点では、提出commitの検証と正式反復は未完了でした。

最初の予備入力では、通常assertionは30 ns、同じ式のclocked PSLは40 nsで違反しました。VPI callbackへ渡す時刻構造体をローカル変数に置くのは安全でないため、継続して使える静的領域に変えています。

最初の統合比較は通常assertionが成功し、PSLが失敗しました。検査器がcoverのfinished countと標準出力の診断数を一致させようとしていたためです。GHDLは既定ではcover到達を標準出力へ出さず、JSONレポートへ記録します。出力を捏造せず、coverは上流レポートの件数と状態で検査し、assert/assumeの違反数との照合は維持しました。その修正後の14件は全て成功しました。

ポート一覧検査の追加後は、top moduleを`vpi_handle_by_name`で取得しようとしたため、14件中7件が停止しました。GHDLの上流実装を確認し、`vpi_iterate(vpiModule, NULL)`と`vpi_scan`でrootを取得する方式へ変えました。各ポートの方向、重複、scope、実ポート数を確認する条件は緩めていません。修正後の焦点を絞った検査と、負の対照を含む50件が成功しています。

## 証拠と再実行

### 固定した環境

実装commitは`8f8e9a562f51bd11eb53d992cd09bd680e5f8c10`です。ホストはUbuntu 22.04.5 LTS、x86_64、Intel Xeon 2論理CPU、メモリー約7.8 GiBで、nativeは上流ABIを満たすUbuntu 26.04.1 LTSの隔離環境で実行しました。Nodeはv24.21.0、GCCの実表示は15.2.0、GHDLは6.0.0・GNAT 14.3.0・mcodeです。GHDL sourceは前層と同じ`e589c698c351369ac5bcfe7abe1f1152ac5d4727`です。合成用native/WASMとYosysは既存の製品用資材を再利用し、各回でVPIプラグインだけを作り直しました。別checkoutではTask40のCPU回帰を実行中であり、これを速度比較の測定とは扱いません。

| 対象 | SHA-256 |
|---|---|
| native GHDL | `ccb93bf7a700b692cff3fe16e833f5ba6b5842393cfd07e8af062c8c441ff6d5` |
| GHDL WASM | `a0bd7fe303e7531d606aac5181ee67bb1ee6ce88fce2360947a7d5e1399c85e8` |
| VPIプラグイン | `91b4a88aa5b672a514fcff2d7d22b18ada6e2bf23cb9364761fd9ea368011bf1` |
| 上流VPIヘッダー | `6ec3e0d8d9fe696fd494b609db9d83d4f61d7d47458b5a19d3bf6de35f3b4d16` |
| 上流VPI共有ライブラリー | `af4bc658f83903d3bc71c994450404c98f46ff3f158278916f8cb4ff03f3e4ec` |

プラグインは上流の`--vpi-compile gcc -Wall -Wextra -Werror -std=c11 -c`と`--vpi-link gcc`でビルドし、上流が返す`-fPIC`、include/library directory、`-lghdlvpi`とrpathを各manifestに保存します。新しいVPIプラグインは本リポジトリで記述したもので、上流のparser、monitor、runtimeをコピーした実装ではありません。

### 実行した検査

`tests/synth/formal-vhdl.test.mjs`が一意な`build/S15/p1-vhdl-<一意名>/`を作り、元VHDL、合成出力、中間JSON、SAT反例、VPI入力、nativeのstdout/stderr、終了状態・所要時間、PSLレポート、VCDと判定を保存します。`native-replay.csv`は40行19列です。`manifest.json`と`native-replay-manifest.json`にはrevision、未コミット差分、GHDLのnative/WASMとCコンパイラーの実表示、VPIヘッダー・共有ライブラリー・プラグイン・検査コードのhash、上流が返すcompile/link flagsを残します。

```sh
GHDL_WASM_BUILD_ROOT=build/S15/vhdl-formal-build4 node --test tests/synth/formal-vhdl.test.mjs tests/synth/ghdl-replay.test.mjs
node --test tests/web/formal-replay.test.mjs
```

前層と同じGHDL build4を使い、runtimeのABIを満たす隔離環境で実行します。ホストでそのABIを満たす場合は隔離を要しません。上記のコマンドはCIの既定出力先なら`GHDL_WASM_BUILD_ROOT=build`で実行します。VPIのヘッダーと共有ライブラリー、GCCが必要で、欠落時にskipしません。

## 清浄な同一commitでの反復結果

上記の実装commitに未コミット差分がない状態で5回反復とA/Aの2回を実行し、7回全てで55件成功、失敗・skipは0でした。各回のCSV全40行19列を元ファイルと再計算した判定へ照合しました。計280行はverified 196・rejected 84で、全て期待する状態と一致しています。[生CSV](S15-vhdl-native-replay-results.csv)は元の19列にsampleを足した20列です。SHA-256は`e766f7e29ba3508fc1351592e447862527b942631956243121c2df2df1de0e91`です。

| sample | 最小 / 中央値 / 最大 (ms) | 元CSVのSHA-256 |
|---|---|---|
| r1 | 39.091 / 44.909 / 90.697 | `2f051dbd739d0386302749f3a09e698d80cf166e64b46c1aa416174926e8d659` |
| r2 | 37.217 / 47.105 / 92.564 | `2dc9a38e4cc7093c6e49353d70af7df1a059e51c3a6af493eab1cdabd3d41906` |
| r3 | 40.638 / 51.561 / 345.456 | `4ed15aa117b412d4a9b98c52264b133ea6d99e4a73934fa43d4fb9a23d9aabbe` |
| r4 | 37.182 / 44.898 / 90.898 | `07597df0425ef9e395ab89852860092c6c0f9f76c42fbfbd149fc46191c58f36` |
| r5 | 36.230 / 46.182 / 124.411 | `ad732cf5e15d6b3d7d47a24c3ff646fb22e13b5e75a6bd7bc46dfd7313db7ab6` |
| aa1 | 37.432 / 42.656 / 79.510 | `61efc638ba0486eae067cd3037c0e986780308041dfa1d5482dcef3f7a98e57b` |
| aa2 | 37.770 / 41.161 / 87.370 | `b74b73211e0fd3bfe8c7981203cd7a4ea4a606afd903b49ab99dc8120bcb6eb8` |

時間は正常な再実行と意図的な拒否の双方を含む40行の分布で、解析と実行の合計です。速度改善の根拠には使いません。A/Aを含む7回で、所要時間とVCD raw hash以外の17列が全行一致しました。VCDには実行日時が入るため全バイト一致を主張せず、各回のraw hashを保持し、独立したparserで入出力・clockの全観測時刻と値を照合しています。この扱いを配置配線JSONの厳密比較へ転用しません。

実装前後のWeb・SAT・元Verilog再実行の回帰205件も成功しました。作業コピーの初回は配布資材とsubmoduleの欠落、次はemsdkのtag未取得で失敗しました。固定版submoduleと配布資材を用意し、文書どおりemsdkのtagを取得して成功しています。製品のpinや判定条件は変更していません。

結果を記録したcommitの最終検査では、VHDLの55件と全列監査は成功しましたが、同時に未取得のsubmoduleを初期化していたため、終了時の清浄状態の確認が失敗しました。Web回帰も未取得のColibriを検出して212件成功・1件失敗となりました。全22候補と形式検証の6依存を取得した次の試行も、VexRiscvの入れ子の依存の欠落で同じ1件が失敗しました。

入れ子を含む固定版の取得を終えてからやり直し、清浄な同一commitでVHDLの55件・全列監査・Web等の回帰213件が成功しました。途中の成功だけで完了とはせず、失敗ログも上書きせず保持します。

## 全列監査の再実行

`scripts/audit-ghdl-replay.mjs`はCSVの全19列を元ファイル、再計算した判定、実行command・flags・終了状態、SATのproperty一覧と反例へ結び付けます。全40行の組合せ、ソースとbinaryのhash、ポート入力、stdout/stderr、VCD、PSLレポートと所要時間を調べます。CSVの各列の改変、行の欠落・重複、不完全なCSVを拒否する負の対照も統合検査に含めます。元の測定ファイルは変更せず、別ディレクトリーの入力で検査器を試します。`--preliminary`を指定した監査は清浄なcommitの正式結果と区別します。

```sh
node scripts/audit-ghdl-replay.mjs --sample build/S15/p1-vhdl-<一意名> --out build/S15/native-replay-audit
```

[全9,228ファイルのhash目録](S15-vhdl-native-replay-evidence.sha256)と、展開後に元ファイルを照合した証拠ZIPを保存しています。ZIPは7,751,104 bytes、SHA-256は`38a2709c7e922eda21af7c55cfc7b544397524051782f2bfff37578fc8301f0d`です。7回の全入力・中間出力・実行状態・判定・生CSV、検査用ソース、保存済みの失敗ログを含みます。ZIPはGitへ重複登録せず、hash目録と再生成手順を本記録へ残します。

## 未完了の範囲

下位化後のVerilog/Icarusとの照合、reset・X・memory・loop・階層・複数property・名前付きlibrary・vacuityの追加fixtureは残っています。ブラウザーの形式検証結果を独立再実行済みへ変更していません。SMT、SBY、形式検証の画面統合とT6全体も未完了です。文書と生CSVを追加した最終提出commitも、同じ検査で再確認します。

[実験一覧](README.md)と[形式検証の調査](../research/formal-verification.md)へ戻れます。
