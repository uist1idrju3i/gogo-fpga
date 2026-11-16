# Issue #21の依存更新の確認

[Issue #21](https://github.com/uist1idrju3i/gogo-fpga/issues/21)に載った更新候補を、正式版、branchの先端、誤検出に分けて確認しました。対象は書き込み部、合成、展開器、形式検証のソース、波形表示のビルドツール、外部HDLです。製品で利用できる範囲は、ソースの固定値を更新したかどうかとは分けて扱います。

## 正式版の候補と互換性

| 依存 | 旧版からの候補 | 変更履歴の原典 | 採否に関係する変更と対応 |
|---|---|---|---|
| zlib | 1.3.2 → 1.4 | [ChangeLog](https://github.com/madler/zlib/blob/v1.4/ChangeLog) | 不正入力、境界検査、CVE-2026-85091とCVE-2026-4738の修正を取り込みます。CMakeと書き込み部の静的リンクを検査します。 |
| Emscripten | 6.0.13 → 7.0.0 | [ChangeLog](https://github.com/emscripten-core/emscripten/blob/7.0.0/ChangeLog.md) | libc++/LLVM 23.1.3とヘッダーの間接include変更に対応します。廃止された`EMCC_ONLY_FORCED_STDLIBS`は使っていません。JSPI、pthread、例外の設定は維持します。 |
| Yosys / ABC | 0.70 → 0.71 | [CHANGELOG](https://github.com/YosysHQ/yosys/blob/v0.71/CHANGELOG) | 文字列の内部表現、MCMのHCUB化、大きいcase文のメモリー問題、ABC更新を確認します。既存の合成経路を使い、WASIとnativeで比較します。 |
| xz-embedded | v20240322 → v2024-12-30 | [差分](https://github.com/tukaani-project/xz-embedded/compare/v20240322...v2024-12-30) | SHA-256検査を取り込みます。`xz_sha256.c`と`XZ_USE_SHA256`を追加し、正常な検査値の展開と、検査値だけを壊した入力の拒否を確かめます。 |
| Click | 8.3.1 → 8.5.1 | [CHANGES](https://github.com/pallets/click/blob/8.5.1/CHANGES.md) | 8.3.2以降のdefault、flag、help、入力の隠蔽、テスト時のstream処理を確認します。SBYの既存CLIを検査します。pagerのshell実行廃止も含みます。 |
| Z3 | 5.3.3 → 5.4.1 | [RELEASE_NOTES](https://github.com/Z3Prover/z3/blob/z3-5.4.1/RELEASE_NOTES.md) | 整数・実数の累乗、量化、配列、浮動小数点、最適化の修正を確認します。更新対象は隔離診断の入力ソースです。製品資材への採用は追加認定が必要です。 |
| Bitwuzla | 0.9.1 → 0.10.0 | [NEWS](https://github.com/bitwuzla/bitwuzla/blob/0.10.0/NEWS.md) | ABI、option enum、`--bv-cnf-scope`、量化と定数配列、terminator、CaDiCaL 3.0.1への変更を確認します。製品資材への採用は追加認定が必要です。 |
| Node.js | 24 → 26 | [25系](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V25.md)、[26系](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V26.md) | 26系は2026-10-28からActive LTSです。確認した26.13.1にはHTTP/TLSなどのセキュリティ修正があります。`.nvmrc`とCIのmajorをそろえ、JSPIとWASIの回帰を検査します。 |
| Rust | 1.99.1 → 1.100.0 | [RELEASES](https://github.com/rust-lang/rust/blob/1.100.0/RELEASES.md) | never type、型推論、Cargoの中間生成物配置の変更を確認します。Surferの`Cargo.lock`を保持したWASMビルドを使います。新しいAPIは追加しません。 |
| Trunk | 0.21.14 → 0.22.1 | [差分](https://github.com/trunk-rs/trunk/compare/v0.21.14...v0.22.1) | wasm-bindgen生成物のhash、dist lock、tool downloadの再試行、minifierの変更を確認します。`--verbose`と`--log`の競合を避け、`--log error,trunk=debug`へ統一します。 |
| Binaryen | 123 → 133 | [CHANGELOG](https://github.com/WebAssembly/binaryen/blob/version_133/CHANGELOG.md) | 124から133までを確認します。Surferから使う`wasm-opt`の既存設定で検査します。C/JS APIの破壊的変更、atomic API、i64のBigInt化は製品コードから使っていません。tail callなどの追加設定は有効にしません。 |

Emscripten 7.0.0のlibc++では、libusbのC11 atomicマクロより先にC++のthread・atomic宣言を読み込む必要がありました。`patches/libusb-webusb-cxx-atomics.patch`でWebUSBのinclude順を直し、upstreamのcheckoutを編集せず、ビルド用コピーへ適用します。パッチのSHA-256も書き込み部のmetadataで照合します。openFPGALoaderに同梱されたcxxoptsも間接includeに依存していたため、C++のコンパイルに`-include algorithm`を指定します。JSPI、pthread、例外の既定設定は維持します。

Yosysの新しい`shuffle`、`write_verilog -nodec_attr/-dec_param`、実験的なtarget/family指定は、既存のGowin経路に必要な変更ではありません。回帰を比較するため、この更新では従来のコマンドを保持します。MCMなど、上流の既存処理に入った修正は更新版の実装を使います。

Bitwuzlaのnative releaseではLTOとmimallocの既定値も変わりました。WASIで利用可能と判断する根拠にはしません。実験的な浮動小数点形式の修正、term managerより長生きしたtermのクラッシュ修正、ゼロ除算からの変換拒否も確認対象です。ABI変更後の古いバイナリーを使い回して認定しません。

Bitwuzla 0.10.0で移動した`src/fp/floating_point.cpp`に合わせて、GMPの32-bit limb用パッチを更新します。CaDiCaL 3.0.1のRSS処理ではnativeのmacOS向け分岐を保持します。また、上流のMeson wrapに加わった2件の`diff_files`も、ビルド用コピーに適用してhashを記録します。手動で展開したsubprojectでも、上流が必要とする修正を落とさないためです。

新版のMeson構成は、固定したGMP・MPFRのヘッダーを`-isystem`で参照します。依存検査と独立監査は、同じ固定先への`-I`と`-isystem`だけを許可し、hostのincludeや静的archive以外への切替を拒否します。上流の`diff_files`は本文のhashに加え、適用コマンドとログも監査します。host参照、適用記録の欠落、metadataを書き換えた場合の負の対照も検査します。

BitwuzlaのWASIビルドとNode.js 24でのCLI比較は成立しましたが、Node.js 26は新旧の例外命令が混在するWASMを拒否しました。この資材は製品へ配布しません。Z3もビルドの終了137が残ります。両者を既定solverへ昇格させず、Yices2を維持します。失敗内容と適用範囲は[S17](../experiments/S17-issue21-dependencies.md)へ記録します。

## 誤検出と据置き

| 依存 | Issueの表示 | 判断 |
|---|---|---|
| Yices2 | `2021-02-19` | 日付のタグです。正式版`yices-2.7.0`を保持します。 |
| Boolector | `smtcomp-2018` | 競技用のタグです。正式版`3.2.4`を保持します。 |
| Z3 | `bisim-study-smart-20260926` | 研究用のタグを除外し、正式版`z3-5.4.1`を候補にします。 |
| Bitwuzla | `smtcomp-2021` | 競技用のタグを除外し、正式版`0.10.0`を候補にします。 |
| wasm-bindgen-cli | `0.2.130` | 単独更新を見送ります。固定したSurferの`Cargo.lock`は`wasm-bindgen 0.2.118`を要求し、CLIとの一致が必要です。 |

solverのタグ選択の修正は[PR #30](https://github.com/uist1idrju3i/gogo-fpga/pull/30)で扱っています。競技・日付・研究用タグを除外しても、正式版を製品で使えることが保証されるわけではありません。

Issueで更新なしと報告されたopenFPGALoader、libusb、libftdi、nextpnr、GHDL、Icarus Verilog、Surfer、zstd、SBYは据え置きます。WASI SDK 34.0、Boost 1.92.0、Eigen 5.0.1、AdaWebPack 24.0.0、GMP 6.3.0、MPFR 4.2.2、GCC libgnat、Apycula 0.35、actionlint 1.7.12、GitHub-hosted runnerも更新対象に追加しません。

## 外部HDLのbranch更新

branchの先端は正式なreleaseと同じ意味ではありません。Issueが併記したタグを版として採用せず、実際のgitlinkを固定します。以下は候補の確認結果です。

| 依存 | 旧commit → 候補commit | 確認した変更と利用範囲 |
|---|---|---|
| Colibri | `3fa784121cce` → `98b83819debd` | FIFO、packetizer、reset、CRC、counter検査の変更です。既存のcounterを検査し、新しいFIFOなどの選択項目は追加しません。 |
| Open Logic | `d9f123aae1c6` → `5136eedce163` | AXIのword count、response、狭いaddress幅、固定小数点部品と検査の追加です。既存のGray code部品を検査します。 |
| hdl-modules | `8142d3a1d878` → `2bdb03032345` | AXI-Lite read data安定性、LFSR、上流テストの変更です。既存のhandshake pipelineを検査します。 |
| NEORV32 | `84743cdbeefc` → `87c8c98bc34e` | fence.iとcacheの同期、IRQ/retire、SC要求の安定性、DMA、UART/TWI/SLINKなどの変更です。既存のRV32E構成とROMを検査し、周辺回路の新機能は追加しません。 |
| DarkRISCV | `955511961f13` → `bb6b483cc61a` | SPI busyの解除、registerの説明、UART divisor表示の修正です。既存のRV32I構成を検査します。 |
| Ibex | `f4515520c004` → `3d524f19ee8e` | lockstep比較、debug trigger、Zcmp/CHERIoTのtrapと文書の修正です。SystemVerilogの未対応表示を保持します。 |
| VexiiRiscv | `9f70315deb33` → `22510fc004a6` | Svvptcの定義追加です。Scala生成が必要な未対応表示を保持します。 |
| UVVM | `825072572dbf` → `b38e32d0d285` | AXI AWREADY依存の修正とMDIO VIPの追加です。VHDLシミュレーションの未提供表示を保持します。 |
| VUnit | `6c2f49f0ec4c` → `3fff9e52c7ba` | wheel公開の変更です。既存の未対応表示を保持します。 |

更新なしのverilog-axis、verilog-uart、libfpga、SERV、PicoRV32、Hazard3、VexRiscv、CV32E40P、FemtoRV、OSVVM、verilog-axi、verilog-ethernet、Taxiは据え置きます。新しいSystemVerilog、CPU生成器、VHDLシミュレーターの対応は今回の更新に含めません。

NEORV32のCPU単体では`ifence_o/dfence_o`が`fence_r_o/fence_w_o/fence_x_o`と完了入力`fenced_i`へ変わりました。試験用のbridgeはcacheとwrite queueを持たないため、上流の[`neorv32_core_complex.vhd`](https://github.com/stnolting/neorv32/blob/87c8c98bc34e/rtl/core/neorv32_core_complex.vhd)のcacheなし構成と同じく完了入力を`1`へ接続します。ZIPへ収録する試験ROMの先頭に`fence`と`fence.i`を加え、RAMの書き込み・読み戻しとGPIOの実行まで検査します。cacheを持つ利用者の設計へ、この固定入力を流用する判断はしていません。

## ライセンス

zlib、emsdk、Yosys、ABC、xz-embedded、Click、Z3、Bitwuzlaと更新する外部HDLのライセンス原文を、旧commitと候補commitで照合しました。ライセンスの種類を変更する差分は確認していません。Colibriはrootの`LICENSE`だけで判断せず、`LICENSES/`のCERN-OHL-W-2.0、Apache-2.0、CC-BY-SA-4.0と、配布する各ソースのSPDX表記を確認します。

UVVMの大きいライセンス差分は、追加された`p2l2_vip_mdio/LICENSE.TXT`のApache-2.0本文でした。既存本文の削除や条件変更ではありません。このVIPはWebの選択項目へ追加しません。対応ソース書庫では上流のライセンスを保持します。

外部ソースのcheckoutは直接編集しません。libusbのinclude修正とsolverの互換性パッチを`patches/`で管理し、ビルド用コピーへ適用します。配布物のmetadataでpatchのSHA-256も照合します。ライセンスと対応ソースの配布要件は[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)に従います。

## 検査の範囲

更新前後の測定値、ビルドの再現性、互換性試験、失敗試行と再実行手順は[S17の実験記録](../experiments/S17-issue21-dependencies.md)へ保存します。

版の確認、原文の取得、candidate checkoutだけでは製品認定を完了した扱いにしません。書き込み部の再現ビルド、4ボードの仮想USB、YosysのWASI/native比較、Pyodide pack、ライブラリーの実行と負の対照、配信物の監査、全実装後の画面確認を更新候補の検査対象とします。

Tang Nano実機は本リポジトリでは試していません。仮想USBでの時間は実機の値ではありません。VHDL原文による反例の独立再実行も、今回の依存更新で完了したとは扱いません。
