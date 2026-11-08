# 午後のFPGA Web Toolchain 調査記録

## 1. 目的と対象ボード

本リポジトリーは、ブラウザー内で VHDL と Verilog の設計、論理合成、配置配線、ビットストリーム作成、Tang Nano への書き込みを行う Web IDE を目指します。サーバーへ設計データを送らない構成を計画しています。T0 では、午後のFPGA Web Flasher から書き込み部を移植した段階で、IDE の機能はまだありません。

対象は Tang Nano 1K、4K、9K、20K です。FPGA の内蔵 SRAM に構成を書き込めることを、ユーザー指定の選定理由としています。ボード名、FPGA、openFPGALoader のボード名、IDCODE、書き込み先は移植元の調査記録を引き継ぎます。

| ボード | FPGA | openFPGALoader 名 | IDCODE | 書き込み先 | nextpnr device | nextpnr family | `gowin_pack -d` |
|---|---|---|---|---|---|---|---|
| Tang Nano 1K | GW1NZ-1 | `tangnano1k` | `0x0100681B` | SRAM、内蔵フラッシュ | `GW1NZ-LV1QN48C6/I5` | `GW1NZ-1` | `GW1NZ-1` |
| Tang Nano 4K | GW1NSR-4C | `tangnano4k` | `0x0100981B` | SRAM、内蔵フラッシュ | `GW1NSR-LV4CQN48PC7/I6` | `GW1NS-4` | `GW1NS-4` |
| Tang Nano 9K | GW1NR-9C | `tangnano9k` | `0x0100481B`（`0x0100581B` の個体もある） | SRAM、内蔵フラッシュ | `GW1NR-LV9QN88PC6/I5` | `GW1N-9C` | `GW1N-9C` |
| Tang Nano 20K | GW2AR-18C | `tangnano20k` | `0x0000081B` | SRAM、外付け SPI フラッシュ | `GW2AR-LV18QN88C8/I7` | `GW2A-18C` | `GW2A-18C` |

9K の IDCODE `0x0100581B` は、画面（`web/lib/boards.mjs`）の照合には加えていません。`.fs` の IDCODE が `0x0100481B` でないと、書き込みを止めます。upstream の openFPGALoader は、`0x0100581b` を `src/part.hpp` の 443 行目で `GW1NR-9` として、`src/fsparser.cpp` の 233 行目で `GW1N-9(ES)` として扱っています。この IDCODE の個体は、本リポジトリでは試していません。

IDCODE と書き込み先は、[移植元の RESEARCH.md](https://github.com/gogo-fpga/flasher/blob/dcbeb67/RESEARCH.md) に記録された値です。nextpnr の device / family 名は Apicula の README と wiki で確認しました。C 品種では `gowin_pack -d` に device 名ではなく family 名を渡します。詳細と出典は[広域調査](docs/research/oss-survey.md)を参照してください。実機の Tang Nano では試していません。

## 2. 午後のFPGA Web Flasher から引き継ぐ知見

書き込み部は午後のFPGA Web Flasherを基礎にし、JSPI、pthread、WebUSBを使います。終了コード0でもログの `FAIL` を拒否し、仮想USBの結果を実機確認と扱いません。移植元の知見、S7の既定ビルド選定とhash照合、asyncifyのlink失敗・バイト一致未確認は、[書き込み部の移植とビルド選定](docs/research/flasher-integration.md)に原典とともに保持しました。

vendor submodule の commit は次のとおりです。pin checker がこの表と gitlink の一致を検査します。

| 依存 | 版 | commit | 取得元 |
|---|---|---|---|
| openFPGALoader | v1.2.0 | `befbab4f646207dbaf1daf8b144dd980ad283dd5` | `https://github.com/trabucayre/openFPGALoader.git` |
| libusb | v1.0.30 | `87a55632db62c9bdc58cd31d3ccfa673f1bb017f` | `https://github.com/libusb/libusb.git` |
| libftdi | 1.6rc1 | `92d657bcb543a9622947d984d4a8e725fb680e8c` | `git://developer.intra2net.com/libftdi` |
| zlib | v1.3.2 | `da607da739fa6047df13e66a2af6b8bec7c2a498` | `https://github.com/madler/zlib.git` |
| zstd | v1.5.7 | `f8745da6ff1ad1e7bab384bd1f9d742439278e99` | `https://github.com/facebook/zstd.git` |
| xz-embedded | v20240322 | `62d5603b5114c5aa8bb5f6bb461efbe0e3b51891` | `https://github.com/tukaani-project/xz-embedded.git` |
| emsdk | 6.0.13 | `35659964bc2762fffec0d257997fb61475f765b7` | `https://github.com/emscripten-core/emsdk.git` |
| yomiyasu | 未確認 | `552c12c472ddfb79e2ee7a15219847782686a945` | `https://github.com/nanaism/yomiyasu.git` |
| yosys | v0.70 | `28ba3cb926fe376fa05ebfc1b921747d011d4557` | `https://github.com/YosysHQ/yosys.git` |
| nextpnr | nextpnr-0.11.1 | `62e659ed6748e9f60b2a4aa25dd4fe79a9605881` | `https://github.com/YosysHQ/nextpnr.git` |
| ghdl | v6.0.0 | `e589c698c351369ac5bcfe7abe1f1152ac5d4727` | `https://github.com/ghdl/ghdl.git` |
| iverilog | v13_0 | `dfeee909ed9f20b4870dd93423156c0170c0e1ff` | `https://github.com/steveicarus/iverilog.git` |
| surfer | v0.7.0 | `bd749b1f786c1c62cd67893ca71346cbe6983915` | `https://gitlab.com/surfer-project/surfer.git` |
| sby | snapshot | `79fc9eddca5e33a28cc2f2cd19c9825efd9a7255` | `https://github.com/YosysHQ/sby.git` |
| yices2 | yices-2.7.0 | `85cf17e44eac76b5d14b297c09fc9bfecf47ef65` | `https://github.com/SRI-CSL/yices2.git` |
| z3 | z3-5.3.3 | `430d19e697e2ec9bad79ff210d41b4a7a5fcfa3e` | `https://github.com/Z3Prover/z3.git` |
| boolector | 3.2.4 | `393cdfba3735d334bb4e6525500b8a0280dd41e6` | `https://github.com/Boolector/boolector.git` |
| bitwuzla | 0.9.1 | `8d1eb01093ae54d9b4586456b69c3bf31000a4c2` | `https://github.com/bitwuzla/bitwuzla.git` |
| click | 8.3.1 | `1d038f270701498433cb432f54db89f95f07a845` | `https://github.com/pallets/click.git` |

WASI SDK の固定値は pin checker とビルドスクリプトが読む次の表を正とします。

| 依存 | 版 | SHA-256 | 取得元 |
|---|---|---|---|
| wasi-sdk | 34.0 | `b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4` | `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz` |
| boost | 1.92.0 | `ea7b982002cc9dfbe59b0b217b206f470dc75f3de0bb2973d844118934d82411` | `https://github.com/boostorg/boost/releases/download/boost-1.92.0/boost-1.92.0-b2-nodocs.tar.xz` |
| eigen | 5.0.1 | `e9c326dc8c05cd1e044c71f30f1b2e34a6161a3b6ecf445d56b53ff1669e3dec` | `https://gitlab.com/libeigen/eigen/-/archive/5.0.1/eigen-5.0.1.tar.gz` |
| adawebpack | 24.0.0 | `8edaae8b9987a20aec430d750f30033f12f953ce2b6437afb87fbf8cc1063796` | `https://github.com/godunko/adawebpack/releases/download/24.0.0/adawebpack-24.0.0.tar.gz` |
| gmp | 6.3.0 | `a3c2b80201b89e68616f4ad30bc66aee4927c3ce50e33929ca819d5c43538898` | `https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz` |
| mpfr | 4.2.2 | `b67ba0383ef7e8a8563734e2e889ef5ec3c3b898a01d00fa0a6869ad81c6ce01` | `https://ftp.gnu.org/gnu/mpfr/mpfr-4.2.2.tar.xz` |

Surfer WASM build tools:

| Tool | Version | SHA-256 | URL |
|---|---|---|---|
| rust | 1.99.1 | - | `https://static.rust-lang.org/dist/channel-rust-stable.toml` |
| trunk | 0.21.14 | `f2b4680cd239693a646a2795e4633c625328d7b2a044fbe749fa3a2fe9e7036b` | `https://github.com/trunk-rs/trunk/releases/download/v0.21.14/trunk-x86_64-unknown-linux-gnu.tar.gz` |
| wasm-bindgen-cli | 0.2.118 | `00b519c9fc2d6e087265da1a00f29160bfcc6a823993482bc2e691910287427b` | `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.118/wasm-bindgen-0.2.118-x86_64-unknown-linux-musl.tar.gz` |
| binaryen | version_123 | `e959f2170af4c20c552e9de3a0253704d6a9d2766e8fdb88e4d6ac4bae9388fe` | `https://github.com/WebAssembly/binaryen/releases/download/version_123/binaryen-version_123-x86_64-linux.tar.gz` |

libftdi は `developer.intra2net.com` に Dependabot が接続できないため、`.gitmodules` の URL と branch から upstream 先端を調べ、「固定版の更新確認」ワークフローで監視します。

## 3. ツールの WASM 化方針

T0 では書き込み部だけが実装されています。合成、配置配線、シミュレーション、形式検証は後続段階で、upstream のコードを WASM にビルドして使います。機能を手作業で移植しません。upstream へのパッチが避けられない場合は `patches/` に保管し、理由と範囲を本書に記録します。

| ツール | 主な言語 | ライセンス | 確認した WASM の事例 | 方針と段階 |
|---|---|---|---|---|
| Yosys + ABC | C、C++ | Yosys: ISC。ABC: Berkeley の許諾条件 | [YoWASP](https://yowasp.org/) は Yosys を WASI で提供。[synth-explorer](https://github.com/cachanova/synth-explorer) は WASI SDK 33 で合成用 Yosys を構築 | T2。YoWASP とネイティブ版を比較し、必要な `synth_gowin` を含む upstream ビルドを検証する |
| GHDL | Ada、C | GPL-2.0-or-later | [synth-explorer](https://github.com/cachanova/synth-explorer) は GHDL 5.0.1 で合成し、Verilog を別 Worker の Yosys に渡す | T3。`--synth --out=verilog` で Verilog に変換し、Yosys に渡す。GPL-3.0 の ghdl-yosys-plugin は Yosys WASM に組み込まず、ISC の Yosys を保つ。詳しくは[広域調査](docs/research/oss-survey.md)を参照 |
| nextpnr-himbaechel（Gowin） | C++ | ISC | [YoWASP](https://yowasp.org/) が nextpnr の WASI 版を提供 | T2。必要な Gowin device database のみを含め、4 ボードの配置配線を検証する |
| Apicula / `gowin_pack` | Python | Apicula: MIT。Pyodide: MPL-2.0 | S3 で Node.js/Pyodide の native parity を確認し、配布 wheel を追加する。Worker は S4 | S3。4ボードの `.fs` 一致、実行時間、配布サイズを測定する |
| openFPGALoader | C++ | Apache-2.0 | 移植元で Emscripten と WebUSB による WASM 化を実装 | T0 の書き込み部として移植済み。以降も upstream のソースを使う |
| NVC | C | GPL-3.0-or-later | S11 は Emscripten NVC の link と native standard-library build に成功したが、Node counter testbench が elaboration で trap | 実際の addendum cutoff により T5 へ進む。初回の cutoff 判断は誤適用として訂正し再開した。out-of-scope NVC files は5。詳細は[S11 記録](docs/experiments/S11-nvc-wasm.md) |
| Icarus Verilog (`iverilog` / `vvp`) | C | GPL-2.0-or-later。`tgt-vvp` は LGPL-2.1 | [VeriSim](https://github.com/senolgulgonul/verisim) が Emscripten で `ivlpp`、`ivl`、`vvp` を個別に WASM 化 | T4。3 つの WASM を JavaScript で順番に呼ぶ方式を基礎にする。詳しくは[広域調査](docs/research/oss-survey.md)を参照 |
| Verilator | C++ | LGPL-3.0 | [tiny-tpu](https://github.com/deaneeth/tiny-tpu) は事前ビルドした WASM を配布。ブラウザー内で C++ をコンパイルする例ではない | 将来。生成コードを実行する C++ コンパイラーをブラウザー内で用意する方法が必要。詳しくは[広域調査](docs/research/oss-survey.md)を参照 |
| SymbiYosys / `yosys-smtbmc` | Python | 未確認 | YoWASP の Yosys は確認したが、Python 側の WASM 実行例は未確認 | T6。Yosys と Python 側の実行環境を分けて検証する |
| Yices2 | C | GPL-3.0 | 非公式の WASM パッケージと wasi-libc の制約を報告した issue がある | T6。ライセンスと issue は[広域調査](docs/research/oss-survey.md)を参照し、Emscripten 版を含めビルドと実行を検証する |
| Z3 | C++ | MIT | 公式 npm [`z3-solver`](https://www.npmjs.com/package/z3-solver) 5.3.2 が WASM を含む | T6。公式パッケージの API と solver の実行時間を小さな証明で測る。詳しくは[広域調査](docs/research/oss-survey.md)を参照 |
| Boolector | C | 未確認 | YoWASP が WASI 版を配布 | T6。ライセンスと必要な API、solver の実行時間を確認する。詳しくは[広域調査](docs/research/oss-survey.md)を参照 |
| [sv-elab（旧 yosys-slang）](https://github.com/povik/sv-elab) | C++ | ISC | この調査では WASM 版を確認できていない | 将来。SystemVerilog 対応の段階で調査する。詳しくは[広域調査](docs/research/oss-survey.md)を参照 |

### GHDL v6.0.0

GHDL の WASM 化、Ada API、VHDL 合成、配布とライセンスの調査は、[GHDL WASM の調査と合成の検証](docs/research/ghdl-wasm.md)に分けました。測定値と当時の判断は、分割先に残しています。

T4 の配布前検査では `ivlpp.wasm`、`ivl.wasm`、`vvp.wasm` をビルド元と全バイト照合します。配布先に追加するだけの例外ではなく、各ファイルの欠落・改変と余分なファイルを拒否する負の対照を設けます。波形表示は VCD 選択、状態表示、Surfer の3行に分け、タブを含む下部ペインに必要な高さを確保します。通常幅と390px幅のパネル高420px以上という既存の検査条件は維持します。

[T4の統合回帰](docs/experiments/S12B-simulation-integration.md)では、timescale追加前後のbitstreamが4ボードで全バイト一致し、native / Pyodideも各5回一致しました。通常幅と390px幅の波形8画面を目視し、配布前検査の負の対照も確認しました。初回のfixture未生成による14件の失敗を保持し、固定版で生成した後の `c19c69f` では全体E2E76件が成功しました。S5比較測定4件はskipです。同じcommitのシミュレーションE2Eも3回反復して30件すべて成功しました。

### Yosys v0.70 と WASI SDK

YosysのCMake設定、shareの割当、native/WASI JSONの比較規則は、[合成・配置配線のWASI調査](docs/research/yosys-nextpnr-wasi.md)に分けました。WASI SDKを採用し、判定に関係しない限定したmetadata以外は同一のまま比較する方針を保持します。

### nextpnr-himbaechel（Gowin）と WASI SDK

固定依存、chipdbの共有、例外のlink設定、配置差の対照と測定履歴は、同じ[合成・配置配線のWASI調査](docs/research/yosys-nextpnr-wasi.md)に保持します。比較の差をJSONの正規化で隠さず、未対応と容量超過を成功に昇格しない基準は変更しません。

### S5: WASI ビルドオプション比較

S5 の事前登録基準では LTO を採用します。Chromium の Tang Nano 20K は 2,296.095 ms で B より 10.5% 速く、zstd -19 の合計は 11.6% 小さく、ビルド時間は 1.81 倍でした。
B の nextpnr は upstream の `USE_IPO=ON` で ThinLTO 済みです。Yosys の O2/Os/Oz は `-DNDEBUG` を付けず、B と assert の状態をそろえました。
Os は Node 20K で 2,048.583 ms、zstd 合計 13,235,553 bytes でしたが、Chromium では測定していません。
詳細は [S5 WASI SDK ビルドオプション比較](docs/experiments/S5-wasi-build-options.md) を参照してください。後続の S5B 比較では OsLTO（Yosys と nextpnr は `-Os`、C/C++/linker は `-flto`、nextpnr は `USE_IPO=OFF`）を選定しました（[計測記録 PR #23](https://github.com/gogo-fpga/toolchain/pull/23)）。この条件は [PR #24](https://github.com/gogo-fpga/toolchain/pull/24) で既定にしました。S5 の B は、最適化フラグを明示的に空にし、nextpnr に `WASI_USE_IPO=ON` を指定して再現します。

S5B では Os、LTO、OsLTO を追加比較し、出力同一性、A/A build、連続5回の Node test、peak RSS の安定性条件を3候補すべてが満たしました。凍結した選定規則では、Chromium 20K の中央値が 2,122.105 ms（B より20.563%速い）で、zstd-19 合計も 11,327,113 bytes の OsLTO を選びます。既定の build script は [PR #24](https://github.com/gogo-fpga/toolchain/pull/24) で OsLTO に変更しました。詳細は [S5B 実験記録](docs/experiments/S5B-os-lto-chromium.md) を参照してください。

### S8: CI ビルドの高速化

S8 v2 の warm / Yosys cache-miss 合計時間中央値は 12.233 / 28.183 分でした。R1-R6 で見つかった chipdb 差は Apicula の hash-ordered set 反復が原因で、`PYTHONHASHSEED=0` 固定後の R7 miss / R8 hit は4 chipdb とも local seed-0 hash に一致しました。計測した nextpnr / GHDL build の max RSS は12 GiB以下で、ローカルの corrupted-cache check も成功しました。採用は、ユーザーが測定後の2026-10-30に決定したものです（判断「A」、凍結基準は未達項目あり）。未確認なのは `cache=false` run、cache 合計サイズ、CI での corrupted-cache 検出、output-cache hit run で省略された Yosys build の max RSS の4項目です。GHDL native `.cf` は timestamp が変わる既知の中間物で、WASM staging copy は正規化されます。詳細と raw data は [S8 実験記録](docs/experiments/S8-ci-speed.md) と CSV を参照してください。

### Pyodide 上の Apicula `gowin_pack`

S3 では Apicula 0.35 の Python wheel を配布物に含め、Node.js の Pyodide 314.0.7 から実行します。Pyodide の lock は Python 3.14.2、micropip 0.11.1、NumPy 2.4.6（SHA-256 `a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf`）、msgspec 0.20.0（SHA-256 `2a4075cee8afc2c0424c63ae1a9b0655e727478df7fa2eb78f86f846fc5fb4bd`）を指定します。これらの wheel hash はビルド時に Pyodide の lock から読み、Apicula wheel の hash は `requirements-nextpnr.txt` の固定値を使います。

Pyodide は新規依存として導入し、upstream の 314.0.0〜314.0.7 の変更履歴を確認しました。314.0.0 で Python 3.14.2 と Emscripten 5.0.3 に更新され、`lzma` が標準ライブラリーに含まれます。`pyodide.asm.mjs` への ES module 名変更は Node の実行には影響しませんが、S4 の Worker は module worker を使う必要があります。314.0.1〜314.0.6 の修正・性能改善はこの file-based 実行で使う API を変えません。314.0.7 の `dedent` オプションは既定値が従来動作を保つため採用不要です。`loadPackage` は lock 内の名前を指定し、依存解決を切った `micropip.install` でローカル wheel を入れるため、314.0.6 の requirement-specifier 処理変更にも依存しません。

Apicula 0.35 の wheel は 4,281,385 bytes、SHA-256 `6495d1c7cdc3cf6ac0a74bf7246932e96e5af84e24c17c1fef7296ebe7ed82fe` です。wheel に同梱された chipdb を `importlib.resources` で読み、圧縮データの展開に `lzma` を使います。`lzma` は Pyodide core に含まれることを実行時に検査します。`fastcrc` は Pyodide にないため、Apicula は CRC table fallback を選び、その警告を stderr に残します。Cattrs は使用しません。

Pyodide の NumPy / msgspec は 2.4.6 / 0.20.0 で、native 参照環境の 2.5.4 / 0.22.0 と版が異なります。S3 の比較では、同一の WASI nextpnr routed JSON を使い、全4ボードで native と Pyodide の `.fs` を5回ずつバイト比較し、IDCODE も確認しました。17件の synthesis tests は成功し、壊れた JSON、別 device、wheel hash 不一致、欠落 wheel の4負例を検出しました。Pyodide setup は 4,627.9 ms、pack assets は 21,021,184 bytes、`.fs` は 1K 351,954、4K 1,167,294、9K 2,069,320、20K 4,618,782 bytes でした。native / Pyodide の実行時間と各回の値は `docs/experiments/S3A-pyodide-gowin-pack.md` と CSV に記録しました。ブラウザー Worker での実行は S4 の範囲で、本段階では確認しません。

### ブラウザー内ビルドと静的配信

S4 のビルド時間、圧縮資材の復号、配信量と配信先の比較は、[ブラウザー内ビルドと静的配信の調査](docs/research/browser-build-and-delivery.md)に分けました。測定値と当時の判断は、分割先に残しています。

固定版Yosysの比較では版とcommitを必須にし、上流のタグ情報による版の接尾辞とcompiler名を回路差から分離します。許容する表記、拒否する負の対照、native/WASIの検査範囲も分割先に記録しました。

## 4. Emscripten のオプション

以下は合成・配置配線ツールの比較計画で、測定結果ではありません。書き込み部は移植元で使われていた JSPI と pthread の構成を維持します。合成・配置配線のツールは WebUSB を使わないため、JSPI と pthread は測定で必要性が示されない限り加えません。

| 項目 | 比較候補 | 方針 |
|---|---|---|
| 非同期 | なし / JSPI | 合成系はまずなし。書き込み部は JSPI を維持 |
| スレッド | なし / `-pthread` | 合成系はまずなし。nextpnr の並列化の効果を測る |
| 最適化 | `-O2`、`-O3`、`-Os`、`-flto` の有無 | ビルド可否、実行時間、成果物サイズを比較する |
| 例外 | `-fwasm-exceptions`、`WASM_LEGACY_EXCEPTIONS=0` | Yosys と nextpnr の C++ 例外を確認し、方式を比較する |
| メモリー | `ALLOW_MEMORY_GROWTH`、`MAXIMUM_MEMORY=4GB`、`STACK_SIZE=8MB` | 20K の配置配線で必要量を測る。Memory64 は対応ブラウザーを確認してから検討 |
| メモリー確保 | dlmalloc、emmalloc、mimalloc | 合成時の速度と最大メモリーを比較する |
| SIMD | `-msimd128` | 効果とブラウザー対応を測る |
| 出力形式 | `MODULARIZE`、`EXPORT_ES6`、`ENVIRONMENT=worker,node`、`INVOKE_RUN=0`、`EXIT_RUNTIME=1`、`STRICT` | Worker からの呼び出しや Node テストとの互換性を確認する |

比較時は同じ入力を使い、YoWASP の WASI 版とネイティブ版を基準にします。採否の条件は測定前に決め、繰り返しの値と生データを `docs/experiments/` に残します。手順は [実験記録の README](docs/experiments/README.md) を参照してください。

## 5. HDL ライブラリーと CPU コア

T5の22候補、ライセンス本文、取得元と固定版は、[HDLライブラリーとCPUコアの調査](docs/research/hdl-libraries.md)にまとめました。[検証の経緯](docs/research/hdl-validation-history.md)には、正式反復と全60組の回帰、失敗と修正、配布ソース照合の原記録を保持しています。実機での確認とは区別します。

## 6. ライセンスとソース配布

本リポジトリー自体のライセンスは BSD-3-Clause です。第三者のソフトウェアのライセンスと配布時の表示は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に記録します。

GHDL、NVC、Icarus Verilog など GPL のツールを WASM にビルドして Release に含める場合、対応するソースも配布します。ソースには対象 revision、適用したパッチ、ビルド手順を含め、WASM の生成内容を追跡可能にします。書き込み部から引き継ぐ source archive と再ビルド検査の仕組みを、後続ツールにも拡張する方針です。

配布前に、各ツールと HDL ライブラリーの正確なライセンス、改変の有無、ソース提供方法、著作権表示を確認します。各ツールを導入する際は、そのバージョンのライセンス本文を読み、義務を最終確認します。

## 7. 分割した調査

Z3 WASIのlink失敗とSDK例外library・fork登録の対処は、[ソルバー調査](docs/research/formal-solvers.md)と[S15の診断記録](docs/experiments/S15-z3-wasi-link.md)に保存しました。手動18条件を経てclean buildと[両solverの正式反復](docs/experiments/S15-solver-native-wasi.md)まで実施しました。

T6は上流SBY・SMTBMCの再利用を選び、[S15の事前基準](docs/experiments/S15-formal-verification.md)を登録しました。Yosys SAT、元VerilogのIcarus再実行、GHDLのVHDL・PSL property保持を追加しました。PSLのコメント解析には上流と同じ2フラグが必要で、activation coverはassertと区別します。[GHDLの診断と初回の失敗](docs/experiments/S15-vhdl-formal.md)、当初の未完了項目と後続の実装・反復、依存、GMPの取得失敗と署名鍵の期限切れを以下の主題別記録へ残します。

大きな調査は `docs/research/` に分けて置きます。

| 文書 | 内容 |
|---|---|
| [依存の版の検出と負の対照](docs/research/dependency-version-detection.md) | GHDLの公開安定タグの選択、Rust channel TOMLの構造化読取り、欠落と不正入力の扱い |
| [書き込み部の移植とビルド選定](docs/research/flasher-integration.md) | 移植元の原典、JSPIとWebUSB、S7の選定とhash照合、asyncifyの失敗と未確認範囲 |
| [GHDL WASM の調査と合成の検証](docs/research/ghdl-wasm.md) | Ada API、VHDL の合成、最適化と配布・ライセンスの記録 |
| [ブラウザー内ビルドと静的配信の調査](docs/research/browser-build-and-delivery.md) | S4、圧縮資材の復号、配信量と配信先の比較 |
| [OSS の FPGA 開発環境と HDL ライブラリーの広域調査](docs/research/oss-survey.md) | ブラウザーで動く HDL ツールの先行例、HDL のツール、形式検証のソルバー、HDL ライブラリーと CPU コア（2026-10-26） |
| [エディターと AI 機能の調査](docs/research/editor-and-ai.md) | エディターの候補（CodeMirror 6、Monaco Editor、Ace など）の比較、AI 機能の接続方式（OpenRouter OAuth PKCE など）との相性（2026-10-26） |
| [Actions.lock の調査結果と導入の採否](docs/research/actions-lock.md) | 現行 CI、保護範囲、既存検査との関係、運用負担と再検討条件（2026-11-01） |
| [文書を意味単位で分割する方針](docs/research/document-structure.md) | 目的・読者による分割、サイズの目安、例外、旧リンクと証拠の保持 |
| [HDL ライブラリーと CPU コアの調査](docs/research/hdl-libraries.md) | T5 の22候補、ライセンスの原典、対応範囲、固定版と更新監視（2026-11-01） |
| [HDL ライブラリー候補の初期調査記録](docs/research/hdl-library-survey-history.md) | 初期の11候補、当時の転記、訂正先と原典。現在のカタログとは区別 |
| [形式検証の原本とブラウザーの制約](docs/research/formal-verification.md) | SBY・SMTBMC、Z3のWASM先例、property、輸送と非成功判定 |
| [HDLライブラリーとCPUコアの検証経緯](docs/research/hdl-validation-history.md) | 正式反復と全60組の回帰、失敗と修正、配布ソースの原記録 |
| [合成・配置配線のWASI調査](docs/research/yosys-nextpnr-wasi.md) | Yosysのshare・JSON比較、nextpnrの固定依存・chipdb・例外link・配置差と測定履歴 |
| [形式検証の固定ソース・依存・配布条件](docs/research/formal-sources.md) | 採用releaseと初期snapshot、依存、SQLite、license、GMP、source closure |
| [形式検証ソルバーのビルドと実行方式](docs/research/formal-solvers.md) | WASI CLI・C API・公式WASMの比較候補、GMP・timer・丸め・版表示・native ABIの制約、字句境界、終了0の構文エラーと実応答比較 |
| [追加ソルバーの固定依存と診断](docs/experiments/S15-extra-solver-builds.md) | MPFRの固定archiveと署名、依存license、CaDiCaLのWASI patchと失敗試行。BoolectorのCLI 5条件は一致。[IDとtraceの境界](docs/experiments/S15-solver-portability.md)も正式5回・A/A 2回の全56行21列を監査。後続の追加候補SMTBMC/SBY認定は別記。製品配布は未完了 |
| [BitwuzlaのMeson診断](docs/experiments/S15-bitwuzla-build.md) | 固定依存とWASI境界。[CLI正式5回・A/A 2回](docs/experiments/S15-bitwuzla-cli-qualification.md)の全203行14列を独立監査。後続のSMTBMC/SBY正式認定は別記。製品認定は残件 |
| [追加候補と原本SMTBMC/SBYの接続](docs/experiments/S15-extra-solver-smtbmc.md) | Bitwuzlaの実help取得、Boolectorの終了10/20、native解決先とhash検査。予備比較と失敗の除外を保持。後続の正式結果と製品認定を区別 |
| [追加候補の独立監査と反復](docs/experiments/S15-extra-formal-audit.md) | SMTBMC/SBY全列の明示的solver選択、実parserエラーと未許可code、清浄な同一commitで正式5回・A/A、全420行、改変20件、ZIP全38,413ファイルの復元後監査。製品認定は未完了 |
| [SMT反例の原回路による再実行](docs/experiments/S15-smt-original-replay.md) | 原本の生成testbenchは内部初期値を代入するため無条件で独立検証とはしない。[記録層の独立監査](docs/experiments/S15-smt-trace-audit.md)は正式5回・A/A 2回の全896行19列、改変対照170件、ZIP復元後監査を通過。元Verilog/VHDL再実行・画面接続は未完了 |
| [SMT反例の元Verilog再実行](docs/experiments/S15-smt-verilog-replay.md) | DUTの内部状態を設定せず、入力駆動とport・内部信号・clock・時刻・propertyの独立照合を追加。正式5回・A/A 2回の全1,484行23列、改変対照316件、ZIP全96,592ファイルの復元後監査を通過。元VHDL/PSL、画面統合は未完了 |
| [SMT反例の元VHDL/PSLと下位化Verilog再実行](docs/experiments/S15-smt-vhdl-replay.md) | GHDL+VPIによる元VHDL再実行とIcarus両版による下位化再実行。違反周期・instance path・全port値・VCD・PSL reportの照合を追加。正式5回・A/A 2回の全1,785行27列、改変対照493件、ZIP全74,316ファイルの復元後監査を通過。z3はsmtbmcクラッシュで候補外。画面統合は未完了 |
| [SMT反例再実行の言語横断監査](docs/experiments/S15-smt-replay-coverage-audit.md) | Verilog/VHDL両経路の反例再実行をまとめ、全2,889行でexpected=actual一致を確認。cover・induction・AIGER/BTOR・SAT未反復部分・z3+VHDLを検証済みにしない境界を監査。画面統合とSAT経路の正式反復は残件 |
| [形式検証の候補と有効化条件](docs/research/formal-capabilities.md) | SMT全9選択肢・SBY全6エンジンと内蔵SAT。反復検証と製品資材を分離し、未対応候補は理由付きで無効。追加solverの製品認定は残件 |
| [原本SBY・SMTBMCのprocess境界](docs/experiments/S15-sby-process.md) | Pyodideの制約、SQLite、native SBY12条件、SMTBMC仮想processの16条件・AST照合、Yosys子workerと安全なファイル差分、初期の失敗記録 |
| [SBY全体の仮想process接続](docs/experiments/S15-sby-runtime.md) | SbyPopen・単一slot・子差分・両solver各6条件の比較 |
| [SBY全成果物・16列の独立監査](docs/experiments/S15-sby-artifact-audit.md) | 全268成果物・SQLite・終了・16列の改変拒否 |
| [SBY正式5回・A/A 2回](docs/experiments/S15-sby-repeated.md) | 同一commitで全84行・19列・1,876成果物が一致 |
| [SBY子workerの停止と輸送の対照](docs/experiments/S15-sby-controls.md) | 実stdin待機からの取消・期限・停止・改変拒否と制限の23条件。正式5回・A/A 2回の全161行14列・707 workerを独立監査 |
| [SbyPopenのwitness変換](docs/experiments/S15-sby-witness.md) | 原本のAIGER・BTOR変換2形式でnativeとPyodideの全byteが一致。正式5回・A/A 2回の全14行9列を監査。回路の反例検証とは別 |

元VHDLの独立再実行と下位化Verilog比較、各5回とA/Aの反復、失敗試行と当時の未完了項目は、[形式検証調査の経緯](docs/research/formal-verification.md#vhdl反例の再実行と比較の経緯)へ原記録を移しました。

Actions.lock は今回は導入を見送り、現行の完全長 SHA 固定を維持します。取得元 ID と推移依存の保護という追加価値、導入の制限、未確認の事項は上記の調査に記録しました。

T6 P2では、WASI shimの同期stdin reader、容量を制限した共有buffer、期限・整合性・終了を管理する専用workerを追加しました。予備Yices2 WASMでは5 byteの入力chunkと7 byteのbufferで双方向SMT通信を確認しました。この段階は正式反復ではありません。GMP検索先、cross makeのarch、alarm、SDKとEmscriptenの丸め、C++標準ライブラリー、setjmp/longjmp、版表示の由来を[ソルバー調査](docs/research/formal-solvers.md)と[S15 P2](docs/experiments/S15-solver-build-and-transport.md)に残します。hardware丸めの単独compile後、実Z3 WASIでも非対応要求を明示拒否できました。

両solverのnative/WASIは各5回・A/A 2回で全329行31列と294負の対照を監査しました。[正式比較と圧縮配信の制約](docs/research/formal-solvers.md#正式比較と圧縮配信の制約)へ条件・証拠・未完了の範囲を分けます。

## 8. 未確認の事項

- Tang Nano の IDCODE とフラッシュ情報の個体差。移植元の調査値はありますが、実機での照合はしていません。
- 合成・配置配線 WASM の実行可否、実行時間、メモリー量、成果物サイズ。YoWASP と synth-explorer の記録を本リポジトリーで再現していません。
- WASI SDK 33 での LTO とネイティブ WASM 例外の問題。synth-explorer の報告を確認しただけで、再現していません。
- NVC で `--disable-llvm` を指定したときの interpreter の runtime 完走。S11 では `-sEMULATE_FUNCTION_POINTER_CASTS=1` により analysis/elaboration が進むことを確認しましたが、Node counter simulation は `missing body for (null)` で停止しました。function signature mismatch の原因は特定済みですが、null unit name の根本原因は未確認です。[実験記録](docs/experiments/S11-nvc-wasm.md)を参照してください。
- Apicula と Pyodide の組み合わせ、必要な Python 依存、実行時間、配布サイズ。
- VeriSim の Icarus Verilog 構成を本リポジトリーへ適用した場合の機能範囲と実行時間。
- Verilator 生成 C++ をブラウザー内でコンパイル・実行する方法。
- SymbiYosys / `yosys-smtbmc`、Yices2 / Z3 のWASM統合と実行性能。初期表で未確認だったSBY・BoolectorのlicenseはISC・MITと確認し、上記の形式検証調査に記録しました。
- sv-elab の WASM 対応。
- Chromium 以外のブラウザー、実機 USB、4 ボードでの書き込み。
- GPL ツールおよび HDL ライブラリーを配布する際の、各 revision に固有のソース提供・表示義務。
