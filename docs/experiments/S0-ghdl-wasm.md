# S0 Phase 1: GHDL WASM 合成のビルドと smoke

## 目的と範囲

GHDL 6.0.0 の VHDL 合成を WASM で実行し、Verilog を出力する。既存の Yosys、nextpnr、gowin_pack の経路で Tang Nano 20K の `.fs` まで進め、native GHDL と比較する。これは S0 Phase 1 の build-and-smoke であり、正式な S0 matrix はレビュー後に行う。

## 固定条件

実験元は `origin/main` の `aff4e61b576b4f18a3cb819069b16c4cc9c1652a`。GHDL の `SOURCE_DATE_EPOCH` は固定 commit の時刻から `1772905660` とした。build と fixture のログおよび生成物は `build/` 以下に保存した。

| 入力 | 固定値 |
|---|---|
| GHDL | v6.0.0、`e589c698c351369ac5bcfe7abe1f1152ac5d4727` |
| ghdl-browser | `e98e5a6c6fd6c48a789705ae9900c6b34b3cb414` |
| GCC libgnat tag object | `ed10445fe222d3973ae13eda9bf211f315c5e3f9` |
| GCC libgnat peeled commit | `cd0059a1976303638cea95f216de129334fc04d1` |
| AdaWebPack | 24.0.0、SHA-256 `8edaae8b9987a20aec430d750f30033f12f953ce2b6437afb87fbf8cc1063796` |
| WASI SDK | 34、clang 23.1.0-wasi-sdk |
| ホスト GCC / GNAT | GCC 15.2.0-16ubuntu1 / GNAT 14.3.0 |
| gprbuild / gprconfig-kb | 2025.0.0-4build2 / 25.0.0-2 |
| AdaWebPack 用 libxml2 / ICU | libxml2 2.9.14+dfsg-1.3ubuntu3.10 / libicu74 74.2-1ubuntu3.1 |
| Node.js | 24.22.1 |

ビルドは Docker と root 権限を使わず、必要な host package を `apt-get download` で取得し、`build/host-tools/` に展開した。AdaWebPack の `llvm-ar` は使わず、WASI SDK 34 の `clang`、`wasm-ld`、`llvm-ar`、`llvm-strip` を使った。AdaWebPack の runtime calendar stub は展開コピー上でのみ変更し、固定 epoch の年 2026 を返すようにした。GHDL v6 の Verilog frontend units と `Synth.Verilog_Insts` への synthesis-path 依存は build copy から除外した。Verilog output emitter は維持した。vendor source は変更していない。

| host package pin | 版 | .deb SHA-256 |
|---|---|---|
| `gprbuild (amd64)` | 2025.0.0-4build2 | `ebf68e78caf320692fbae9c1cb58e8b365d989b66033f703e3224040691db9bb` |
| `gprbuild (amd64v3)` | 2025.0.0-4build2 | `327805b431911427fec34f3e22815e3212c138bb49d6e07f538d139a704404ac` |
| `gprconfig-kb (all)` | 25.0.0-2 | `4f3e254e1cae5c0edbc87f999144202d717ec828f4d07bd5cc0ddb31d01ccac0` |
| `libgnat-14 (amd64)` | 14.3.0-14ubuntu1 | `d58050517bc1e289a879f4433eac71e8718c87143e9c860a5479e8aa92968012` |
| `libgnat-14 (amd64v3)` | 14.3.0-14ubuntu1 | `8c4183d87c63ac3875fd3d5b732ef8fb87c412ad3cac427d1d5336aaa8a05e79` |
| `libgnatprj12 (amd64)` | 2025.0.0-4build2 | `b57ab4d2bd90360966eb245ff464afd2145685802b6e8e56f7ecb806f59bb194` |
| `libgnatprj12 (amd64v3)` | 2025.0.0-4build2 | `575af2e2d2885d2a71f0a27d3bd4c9b355219e7cc57bb29c8f8398674d9e36a9` |
| `libxmlada-dom9 (amd64)` | 25.0.0-4build2 | `7b8773467a50b27bb9071f21e4a10b5c61a8bd0614d2bade32f45e57a91ed075` |
| `libxmlada-dom9 (amd64v3)` | 25.0.0-4build2 | `2b6fa4c516ed90975895663fafc6ef0ba5f263b26acc9a63b639f0bbaaaef6b2` |
| `libxmlada-input8 (amd64)` | 25.0.0-4build2 | `30161cb121ee176ea0c5d37a9db2744dd91056f47f1ce75c2f4d54773d31f69b` |
| `libxmlada-input8 (amd64v3)` | 25.0.0-4build2 | `042c9e7ee29dc9431df41f9b9cd42a1f3ec995f95c754eeb675ac446b34ea833` |
| `libxmlada-sax8 (amd64)` | 25.0.0-4build2 | `aae83ba17f060d82a5c1e32432462470cc0a8bab1dfa45df58a816512d4c3a57` |
| `libxmlada-sax8 (amd64v3)` | 25.0.0-4build2 | `fe643fbe119a24c89ec0732125a6e58958d07c9d60ed05e3157eb5ce76ae6b38` |
| `libxmlada-schema8 (amd64)` | 25.0.0-4build2 | `b01d6d3ed8189a9902da2ba037599fbcb23cba3d553fa5b74d7741f64e299969` |
| `libxmlada-schema8 (amd64v3)` | 25.0.0-4build2 | `e674bc886ee4ae1dd2db213d8f0676e5bf2af443ed48e8c49f70773e37e88328` |
| `libxmlada-unicode8 (amd64)` | 25.0.0-4build2 | `badb5d896cc19507c01996c71e54ff0beb83a8f30472a2c2bf15071f816e56f5` |
| `libxmlada-unicode8 (amd64v3)` | 25.0.0-4build2 | `4b23b9407f95600bfcaf2346b55f5d4ed1b7544f87b037e13245656e1e006556` |
| `libxml2` for AdaWebPack | 2.9.14+dfsg-1.3ubuntu3.10 | `c5a065f85c1e6f605741e365e40cad71c3ceb0e85e2791400bd35b8896e12ad1` |
| `libicu74` for AdaWebPack | 74.2-1ubuntu3.1 | `c9a70989678660eed9a1e904c74fa043da8bec8e2036856fc16e31ced79b04f8` |

`libxml2` は Ubuntu archive の `https://archive.ubuntu.com/ubuntu/pool/main/libx/libxml2/libxml2_2.9.14+dfsg-1.3ubuntu3.10_amd64.deb` から取得した。`libgnat-14` は host に導入済みだったため download を省略した。各 package の版・hash pin はこの表に記録し、build log / manifest には download した package の実値を記録した。

## build と fixture の結果

| 項目 | 結果 |
|---|---|
| WASM | 1,999,778 bytes、SHA-256 `a0eff3c41ccf92b104143174ce6ed735118fb787b0c0200e7b416f4d7feaa273` |
| libraries archive | 455,929 bytes、SHA-256 `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` |
| build wall time | 最終 build 297 秒 |
| artifact を作った GHDL | 6.0.0、commit `e589c698c351369ac5bcfe7abe1f1152ac5d4727` |
| fixture tests | 8/8 成功。6 positive fixture は全て native output と byte-identical |

| Fixture | WASM と native GHDL の Verilog |
|---|---|
| Combinational logic | byte-identical |
| `numeric_std` counter | byte-identical |
| Generic entity | byte-identical |
| FSM | byte-identical |
| Package と依存 entity の2 file | byte-identical |
| Tang Nano 20K LED blink | byte-identical |
| Syntax error | 非0終了、source filename と line の診断 |
| Semantic error | 非0終了、source filename と line の診断 |

詳細な fixture 出力は `build/ghdl-wasm/fixture-tests.log` にある。

## Runtime checks

`synth_api.adb` の adapter-wide `pragma Suppress (All_Checks);` を削除した状態で full build と8 fixture tests が成功した。GHDL units の compile command には `-gnata` があり、`-gnatp` はありません。したがって全体の runtime checks は有効で、個々の upstream unit にある明示的な suppression のみ適用されます。

## Tang Nano 20K `.fs` smoke

VHDL LED blink について、WASM GHDL と native GHDL の双方が出した Verilog を、native / WASI Yosys、native / WASI nextpnr、native gowin_pack / Pyodide pack に通した。4 経路の `.fs` は全て 4,618,782 bytes、SHA-256 `16f96233dbbc90af33256cae3bdc9a12e245e9afbc480e756af47941abf72e3c` で byte-identical だった。WASM と native GHDL の Verilog は 1,162 bytes で byte-identical だった。実機では試していない。

## A/A 再現性

`GHDL_WASM_BUILD_ROOT=build/ghdl-review-aa1` と `build/ghdl-review-aa2` の2つの空の build root で、build script をそれぞれ最初から最後まで実行した。再梱包はしていない。両方の full build が成功し、WASM は 1,999,778 bytes / SHA-256 `a0eff3c41ccf92b104143174ce6ed735118fb787b0c0200e7b416f4d7feaa273`、libraries archive は 455,929 bytes / SHA-256 `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` で一致した。script は native library tree の staging copy で123個の `.cf` catalog timestamp を `SOURCE_DATE_EPOCH` に基づく `20260307174740.000` に正規化する。ログは `build/ghdl-review-aa1/ghdl-wasm/build.log` と `build/ghdl-review-aa2/ghdl-wasm/build.log`。

| Fresh root | build time | WASM SHA-256 | libraries archive SHA-256 |
|---|---:|---|---|
| `ghdl-review-aa1` | 298 秒 | `a0eff3c41ccf92b104143174ce6ed735118fb787b0c0200e7b416f4d7feaa273` | `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` |
| `ghdl-review-aa2` | 297 秒 | `a0eff3c41ccf92b104143174ce6ed735118fb787b0c0200e7b416f4d7feaa273` | `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` |

生データと比較結果は [S0-ghdl-wasm.csv](S0-ghdl-wasm.csv) に記録した。

## 失敗した試行

全て GHDL 6.0.0 を使った。v5.0.1 への切り替えは行っていない。

| GHDL | 試行 | 失敗内容（抜粋） | 記録 |
|---|---|---|---|
| 6.0.0 | v6 attempt 1 | `Hunk #1 FAILED at 71.` | `build/ghdl-wasm-v6-attempt1-build.log` |
| 6.0.0 | v6 attempt 2 | `Hunk #1 FAILED at 71.` | `build/ghdl-wasm-v6-attempt2-build.log` |
| 6.0.0 | v6 attempt 3 | `env: '.../adawebpack/bin/llvm-ar': No such file or directory` | `build/ghdl-wasm-v6-attempt3-build.log` |
| 6.0.0 | full Verilog frontend | `dyn_htables.ads:75:07: error: unmatched actual "Table_Initial"`; `Assert_Failure predicate failed at gnatllvm-glvalue.adb:84` while compiling `verilog-allocates.adb` | `build/ghdl-wasm-work/ghdl-browser/build/ghdl-wasm-full/gprbuild-gnatd-n.log` |
| 6.0.0 | runtime analysis | `error: unreachable`; `Predefined exception raised at filesystem.adb:93` | `build/ghdl-wasm/runtime-analysis-attempt1.log` |
| 6.0.0 | 初回 A/A archive | SHA-256 が一致せず: main `163154f1…`, aa1 `e20bba6f…`, aa2 `4cde6d25…` | `build/ghdl-wasm-aa-initial-mismatch.log` |
| 6.0.0 | 手動 archive 再梱包 | timestamp `20260308024740.000` での hash は不一致。manifest の値 `20260307174740.000` に合わせて解消 | `build/ghdl-wasm-aa-manual-repack-attempt.log` |

attempt 1/2 は v5.0.1 向け dynamic table patch を v6 の `dyn_htables.ads` に適用した失敗である。full frontend は default flags、`-O0`、`-O0 -gnatd.n` の各条件で再現し、VHDL synthesis に不要な Verilog frontend を build copy から外して解消した。attempt 3 は WASI SDK の `llvm-ar` に切り替えて解消した。runtime failure は AdaWebPack calendar stub が 1970 年を返し、GHDL の `Filesystem.Year_Range` 2000..2099 に反したためで、stub を展開コピー上で固定年に変更した。初回 archive の差は `.cf` catalog の wall-clock timestamp で、staging copy の正規化により解消した。手動再梱包による A/A 証拠は破棄し、上記の直接 full build を最終証拠とした。

## GHDL v6.0.0 の変更履歴の確認

比較範囲は GHDL v5.1.1..v6.0.0 の **665 commits** である。upstream の URL は `.gitmodules` の `vendor/ghdl` から、比較対象の v6.0.0 は `git ls-tree` の gitlink `e589c698c351369ac5bcfe7abe1f1152ac5d4727` から確認した。[GitHub compare](https://github.com/ghdl/ghdl/compare/v5.1.1...e589c698c351369ac5bcfe7abe1f1152ac5d4727) と `vendor/ghdl/NEWS.md` の 2026-03-07 の 6.0 項目を参照した。全 commit subject は [ghdl6-subjects.tsv](S0/ghdl6-subjects.tsv) に原文で記録した。

この範囲には VHDL 合成の修正と Verilog 出力の修正が含まれる。たとえば `smin` / `smax` の出力 template、dynamic insert の幅、single-user-driver 判定が修正され、VHDL の attribute（`keep` など）が Verilog に出力されるようになった。subprogram instantiation、matching case、external name、`numeric_bit` 演算、算術シフトなどの合成対応も増え、解析・合成エラー後の crash を避ける修正も含まれる。NEWS は VHDL-2019 の `--std=19` を初期サポートとして記載している。

回帰時は、attribute と port の出力、式の幅や演算、初期値を含む memory、エラー入力後の処理を重点的に見る。既存の S0 は v6.0.0 の WASM と native の一致を確認するが、v5.1.1 との出力比較ではないため、v5 系からの機能・出力差は本リポジトリでは試していない。

T3 の UI 統合候補は、まず VHDL の `keep` attribute が Verilog と Yosys の合成結果に届くことを fixture で確認すること、次に v6.0.0 で増えた演算・構文の合成 fixture を追加することである。VHDL-2019 は後から選択肢として提供し、既定は VHDL-2008 に保つ。理由は、現時点の対応が初期段階で本リポジトリでは合成範囲を試していないこと、2019 用 IEEE library を含めると配布資材が増えること、言語版を選ぶ UI がまだないことである。

## T3: ghdl-browser 依存除去と最小 runtime

基準は `origin/main` の `50b8367`、GHDL は pinned commit `e589c698c351369ac5bcfe7abe1f1152ac5d4727`、GCC libgnat は tag object `ed10445fe222d3973ae13eda9bf211f315c5e3f9`（peeled commit `cd0059a1976303638cea95f216de129334fc04d1`）、AdaWebPack は 24.0.0 である。frontend の unit 一覧は既存 build の `.ali` ファイルから取り、ソースは `vendor/ghdl/src` の原本だけから構成する。既存 WASM に残っていた v5.0.1 ベースの `vhdl-sem.adb`、`vhdl-sem_names.adb`、`vhdl-sem_lib.adb`、`files_map.adb`、`dyn_tables.adb` は GHDL 6.0.0 の原本に置き換えた。

GCC の OS・Calendar unit を追加した試行は AdaWebPack の制約に反したため、`s-os_lib.adb`、`s-os_primitives`、`s-strings` は採用しなかった。代わりに `scripts/ghdl-wasm/rts/` に GHDL 6.0.0 と `synth_api` が参照する最小 runtime を実装した。C/WASI libc の file/path 操作を使い、`Ada.Command_Line` は空、`Ada.Calendar.Clock` は GHDL pin の commit timestamp から作る `SOURCE_DATE_EPOCH` 固定値、Time_Zones の offset は 0 とする。依存のない Ada.Strings.Unbounded など、制約下でコンパイルできた pure-Ada 単位は GCC libgnat 14.1.0 の原文を使う。

`JOBS=2 GHDL_WASM_BUILD_ROOT=build/ghdl-no-browser-runtime8 scripts/build-ghdl-wasm.sh` は成功した（403 秒、WASM 約 2.0 MiB、libraries archive 約 448 KiB）。当初の WASM test は `/work/<fixture>` の絶対パスを開けなかった。root preopen だけでは直らず、fixture を sandbox 内に書いた上で解析 API へ相対ファイル名を渡す形に変更すると、`tests/synth/ghdl-wasm.test.mjs` は 8/8 成功した。実行した Node WASI module の imports は WASI Preview 1 の file/path 操作と少数の `env` callback だけで、旧 GNAT VFS file callbacks は含まれていない。ログは `build/ghdl-no-browser-runtime8.log`、`build/ghdl-wasm-runtime8-imports.txt`、`build/ghdl-wasm-runtime8-final-tests.log` にある。

二つの clean build root、5回連続の GHDL fixture/native 比較と4 board parity、old/new WASM の fixture 出力比較を確認した。結果を以下に追記する。

### T3 追記: WASI open flags と stdout buffering

`std` library が見つからない原因は、`Is_Regular_File` の構造体 layout や mode 判定ではなかった。C の `stat` predicate は成功し、失敗していたのは catalog に対する `open` だった。Ada runtime が read 用 flags に 0 を渡していたが、WASI SDK の `O_RDONLY` は `0x04000000` である。`wasi.c` の open helper が WASI SDK の `O_RDONLY` / `O_WRONLY` macro を使うようにすると、trace に catalog と source file の `path_open`、`fd_read` が現れ、GHDL test は `std` を読み込めた。証拠は `build/ghdl-no-browser-wasi-open-flag-trace.log` と `build/ghdl-no-browser-wasi-trace-c-helper.log` にある。

Verilog の native/WASM 差は、stdout の C stdio buffer が WASM host に戻る前に flush されないことが原因だった。GHDL の `Outputs.Close` は stdout を close しないため、`__ghdl_get_stdout` が `setvbuf` で stdout を unbuffered にする。`tests/synth/ghdl-wasm.test.mjs` は native/WASM 出力の byte equality を assert する。clean build A は 401 秒で成功し、WASM SHA-256 は `aa851b370a40ce4bf8bce6143a0293840c31ee13c5161e6597fedc8d4538400d`、`libraries.tar.gz` は `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513` だった。build log は `build/ghdl-no-browser-flush-clean-a.log` にある。Node.js 24.22.1 の fixture test は 5 回連続で 8/8 成功し、6 つの positive fixture 全てで Verilog が byte-identical だった。記録は `build/ghdl-no-browser-5x-parity.log` にある。

PR #29 の既存 WASM（`build/ghdl-review-aa1`）は 1,999,778 bytes、SHA-256 `a0eff3c41ccf92b104143174ce6ed735118fb787b0c0200e7b416f4d7feaa273`、新しい clean build A は 2,066,717 bytes、SHA-256 `aa851b370a40ce4bf8bce6143a0293840c31ee13c5161e6597fedc8d4538400d` だった。WASM hash は変わったが、fixture Verilog 6 件は全て同一だった。

| Fixture | PR #29 / 新 build の共通 SHA-256 |
|---|---|
| combinational | `b1299d9fa412674b4d9b5d4365abd376a68c1af0cf0d2164e88f1c09de8e5f25` |
| numeric_std counter | `a4296a146cc133e0807d4f1e4b864cbea302924295c89527c01e21e753d571ed` |
| generic entity | `9b7a04a4ac79354a5f9e10873e66a6a5b0eef65a473f76a2eba2c62aa97f9c16` |
| FSM | `3ea0b0c8b21ad7486ab5aacf339e54a6662122ff264929c590f0722bf98a2bd9` |
| package and entity in dependency order | `9edb5abe0ac62fbdb7cfda89bd4a00e4afc76040a0a90b6393d98b64cd7f8bde` |
| Tang Nano 20K LED blink | `9cb10ac78a877fce1c5cc028e01990c9435d96de663b18ed925a1fd420bcb91b` |

Ada 側の flush call を試した手動 GPR 再ビルドでは、`llvm-gnat1` の `Add_Function_To_Module` assertion が起きた。再利用した work directory に原因があるかは未確定だが、fresh root の full build は成功した。

### clean build B と4 board parity

clean build B は404秒で成功し、build A と `ghdl-synth.wasm`（2,066,717 bytes、SHA-256 `aa851b370a40ce4bf8bce6143a0293840c31ee13c5161e6597fedc8d4538400d`）および `libraries.tar.gz`（448 KiB、SHA-256 `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513`）が byte-identical だった。build B log は `build/ghdl-no-browser-flush-clean-b.log` にある。old/new WASM 比較と6 fixture の共通 Verilog hash は上記に記録した。

`tangnano20k_led_blink.vhd` から WASM GHDL が出力した Verilog を入力として、native Yosys / native nextpnr / native `gowin_pack` と WASI Yosys / WASI nextpnr / Pyodide pack の `.fs` を比較した。native GHDL と WASM GHDL の Verilog は同じであり、4 board 全ての `.fs` は5回連続で byte-identical だった。初回の診断 script は P&R JSON 内の `src` path（native の絶対パスと WASI の `/share` path）も一致させようとして失敗したため、その比較を除き、最終成果物の bytes を比較した。

| Board | `.fs` bytes | SHA-256 |
|---|---:|---|
| Tang Nano 1K | 351,954 | `751a5f3d266c7172723cf043adb02d47c7bc9d5304924459e032c79fc08e46f7` |
| Tang Nano 4K | 1,167,294 | `769cf0ee2d2fa5f91b0095ff68cc80442b6954e3155b6c14e3a17d25a51a54a7` |
| Tang Nano 9K | 2,069,320 | `12f29894546d06b3e3510060d2688b820ccde7dbc5463b58459bb88bc20f9933` |
| Tang Nano 20K | 4,618,782 | `16f96233dbbc90af33256cae3bdc9a12e245e9afbc480e756af47941abf72e3c` |

4 board parity のログは `build/ghdl-vhdl-four-board-parity-5x.log` にある。

### ライセンスと source archive の検証

`CHECK_GHDL_LICENSES_ONLY=1 scripts/package-release.sh` は成功した。負例として `licenses/GPL-3.0.txt` を一時的に隠すと、`Required GHDL license file is missing or empty` で失敗した。記録は `build/ghdl-license-negative-control.log` にある。

初回の release package 検証は、既存 `dist/build-info.json` の `build_script_sha256` が現在の `scripts/build-wasm.sh` と一致せず失敗した。古い `build/jspi-pthread` を使う `scripts/build-web.sh` も build metadata の不一致で停止したため、`JOBS=2 mise exec -- scripts/build-wasm.sh --variant=C` で現在の script から再ビルドし、`python3 scripts/build-info.py check-artifacts --root "$PWD" --artifacts build/C` で出力 metadata を検証した。その artifacts と build-info を `dist/` に反映してから `mise exec -- scripts/package-release.sh v0.0.0-test` を実行すると、web zip と source tar.gz の両方を生成できた。ビルド記録は `build/ghdl-release-refresh-wasm.log`、package 記録は `build/ghdl-release-package-test.log` にある。

source archive を展開せずに内容を調べ、`vendor/ghdl/.gitcommit` が pinned commit `e589c698c351369ac5bcfe7abe1f1152ac5d4727` と一致すること、`vendor/ghdl/src/vhdl/vhdl-sem.adb`、`patches/ghdl/`、`scripts/build-ghdl-wasm.sh`、`scripts/ghdl-wasm/` と全 runtime file が含まれることを確認した。web zip には GHDL、GPL-3.0、synth-explorer、AdaWebPack、GCC Runtime Library Exception の5つのライセンス本文がある。ライセンス負例と source archive の検査は成功した。

## T3-2: ブラウザー IDE への統合

T3-2 では GHDL 6.0.0 の WASM host を `web/lib/ghdl-host.mjs` に分離し、`runGhdlSynth` を実装した。host は WASI Preview 1 の memory tree を使い、呼び出しごとに新しい instance を作る。Node.js API には依存しない。`tests/synth/ghdl-wasm.test.mjs` はこの host を使い、9件すべて成功した。VHDL-2019 fixture は GHDL 6 NEWS にある初期対応構文 `return identifier` を使い、native GHDL と WASM GHDL の Verilog は byte-identical だった。

`synth_api` は `Synth_Set_Std` で VHDL-2008 / 2019 を選び、`Synth_Init` より前に標準を設定する。未指定時は VHDL-2008 である。v08 と v19 の IEEE library はこの変更より前から `libraries.tar.gz` に含まれていたため、standard selector のための追加 library は不要だった。VHDL の構文・意味エラーは project-relative な file path と行番号を返し、IDE の問題一覧に表示する。

`web/lib/vhdl-order.mjs` は entity、package、context、package body、architecture、configuration の依存を追い、source file を小文字化比較で安定して並べる。未解決の `work` reference と file-level cycle は file path と行番号付きで報告する。Playwright は未解決 package の表示も確認した。VHDL top が Verilog child を instantiate する方向では、GHDL の patched output に `child` の blackbox declaration が含まれ、Verilog source と合わせて一度に `read_verilog` すると Yosys が `Re-definition of module \child` で失敗した。元の Verilog source を先に読み、generated VHDL files を `read_verilog -nooverwrite` で読み込むようにすると Verilog implementation が残り、この方向も合成できる。反対方向の Verilog top と VHDL child も、root VHDL entity ごとの出力を使って成功した。

VHDL `keep` fixture では Yosys JSON の `modules.top.netnames` に `keep` attribute が残り、attribute のない negative control には `keep` がない。ブラウザー test は VHDL-2019、両方の mixed direction、構文・意味診断、ordering error、GHDL asset の欠落・圧縮 hash 不一致・破損 Cache Storage entry の削除と再取得も確認した。`PLAYWRIGHT_PORT=8123 GHDL_WASM_BUILD_ROOT=build/T3-2 BUILD_ROOT=build/T3-2 mise exec -- npx playwright test tests/e2e/ide.spec.mjs tests/e2e/synthesis.spec.mjs tests/e2e/vhdl.spec.mjs` は 37/37 passed で、log は `build/T3-2/playwright-e2e.log` に保存した。

`GHDL_WASM_BUILD_ROOT=build/T3-2 scripts/build-ghdl-wasm.sh` で作った WASM は 2,001,408 bytes、SHA-256 `5c8df2a9102f9bdd577df7e250739876cc29642f8dd7fa0c9844799b0a817c80`。`libraries.tar.gz` は 455,929 bytes、SHA-256 `32c3586a64b5adc62d55a45aab127b18aeb2f45a8205da089d5618c6c9e10513`。browser asset は zstd 形式で配る。GHDL WASM の圧縮後サイズは 510,684 bytes、圧縮 SHA-256 `c8ae685b272138f1e1d2b52516d3471be02b14a20413cddab2deb3fecaf026ec`。deterministic ustar `libraries.tar` は 3,901,440 bytes、SHA-256 `5f08af4dd4ecb42959faf2286b1dba0055ae0b6642c906e60e3688b7ecd04e07`、zstd は 218,323 bytes、圧縮 SHA-256 `a8f99b0cf038d01bcc37078188eef86739b59f10f0999527ad07a7098b898f76`。`build/T3-2/synth/manifest.json` は展開後と圧縮後のサイズ、SHA-256 を記録する。Worker はこれらを検証し、Cache Storage の破損 entry を捨てて再取得する。

四つの board すべてで VHDL template の browser `.fs` が native GHDL → native Yosys → native nextpnr → native `gowin_pack` の期待値と byte-identical だった。Playwright の `tests/e2e/synthesis-setup.mjs` が期待値を作り、`tests/e2e/vhdl.spec.mjs` が比較する。生成物のサイズと SHA-256 は次のとおり。

| Board | `.fs` bytes | SHA-256 |
|---|---:|---|
| Tang Nano 1K | 351,954 | `751a5f3d266c7172723cf043adb02d47c7bc9d5304924459e032c79fc08e46f7` |
| Tang Nano 4K | 1,167,294 | `769cf0ee2d2fa5f91b0095ff68cc80442b6954e3155b6c14e3a17d25a51a54a7` |
| Tang Nano 9K | 2,069,320 | `12f29894546d06b3e3510060d2688b820ccde7dbc5463b58459bb88bc20f9933` |
| Tang Nano 20K | 4,618,782 | `16f96233dbbc90af33256cae3bdc9a12e245e9afbc480e756af47941abf72e3c` |

成功時の desktop / 390px screenshot は各 board の `build/T3-2/screenshots/<board>-vhdl-success-{desktop,390}.png`、診断表示は `vhdl-error-diagnostics-{desktop,390}.png`、VHDL-2019 selector は `vhdl-2019-selector-{desktop,390}.png` にある。Chromium の性能計測と実機試験は本タスクでは行っていない。実機の動作は本リポジトリでは試していない。
