# サードパーティーのライセンス

本リポジトリー自体は BSD-3-Clause です。以下に、配布物に含める第三者のライセンスを記録します。

## 形式検証の候補ソース

以下はT6の調査・ビルド候補のソース登録です。形式検証バイナリーはまだ含めません。採用commitはRESEARCHとgitlink、GMPの版とSHA-256はRESEARCHのarchive表を正とします。[固定ソース・依存・配布条件](docs/research/formal-sources.md)に、取得失敗、署名鍵の期限切れ、未採用の補助依存も記録しています。

| ソース | 原本の著作権表示とライセンス | Web ZIPの原文 |
|---|---|---|
| SBY | Claire Xenia Wolf、ISC | `licenses/sby-COPYING` |
| Yices2 | SRI International、GPL-3.0-or-later | `licenses/yices2-LICENSE.txt` |
| Z3 | Microsoft Corporation、MIT | `licenses/z3-LICENSE.txt` |
| Boolector | authors and contributors and their institutional affiliations、MIT | `licenses/boolector-COPYING` |
| Bitwuzla | authors and contributors and their institutional affiliations、MIT | `licenses/bitwuzla-COPYING` |
| Click | Pallets、BSD-3-Clause | `licenses/click-LICENSE.txt` |
| GMP | Free Software Foundation、LGPL-3.0-or-later OR GPL-2.0-or-later。ファイル別の条件も原archiveで保持 | `licenses/gmp-COPYING`、`gmp-COPYINGv2`、`gmp-COPYINGv3`、`gmp-COPYING.LESSERv3`（いずれも同じlicensesディレクトリー） |

ソース6件は各vendorディレクトリー、GMPはsource archive内の `vendor/formal-archives/` に原archiveを収めます。MPFR、SymFPU、libpoly、CUDD、SAT backendは、この段階では追加配布せず、有効化もしません。実際に有効にするprofileごとにソースとライセンスを確認して追加します。

Boolectorの隔離した診断ビルドでは、上流のsetup scriptが固定したCaDiCaLとBTOR2Toolsを取得します。どちらもMITで、著作権表示を含む原licenseとソースarchiveのhashを診断metadataへ記録します。CaDiCaLへのWASI適応patchは本体のSAT判定を変更せず、原licenseを維持します。詳細と製品配布の未確認範囲は [追加ソルバーの記録](docs/experiments/S15-extra-solver-builds.md)を参照してください。

Bitwuzlaの隔離したMeson診断は、上流wrapで固定したCaDiCaL（MIT）とSymFPU（BSD）、GMP・MPFRの原archiveを取得します。原license、ソース・overlay・patchのhashをmetadataに保持します。診断binaryを製品配布へ追加する変更ではありません。[Bitwuzlaの記録](docs/experiments/S15-bitwuzla-build.md)に、依存の分離と非対応なWASI境界を記録しています。[CLIの正式反復と独立監査](docs/experiments/S15-bitwuzla-cli-qualification.md)では、依存元archiveと原license・overlay・静的libraryも照合しています。[追加候補のSMTBMC/SBY独立監査](docs/experiments/S15-extra-formal-audit.md)は同じ診断資材を再利用します。依存・ライセンスや製品配布への変更はなく、証拠ZIPには原licenseとこのNOTICEを含めます。SMTBMC/SBYと製品配布の認定は別に行います。

[原本SMTBMC/SBYへの追加候補接続](docs/experiments/S15-extra-solver-smtbmc.md)は、既存の固定buildとPython原本を使い、process別名、help出力、stderr、終了codeの境界だけを変更します。SMTの解析や証明の判定は移植せず、原license・著作権表示を保持します。後続の正式5回・A/Aと証拠復元は[独立監査の記録](docs/experiments/S15-extra-formal-audit.md#清浄commitでの正式結果)を参照してください。証拠ZIPは採用campaignと失敗試行を分け、Bitwuzla・Boolector・GMP・MPFR・CaDiCaL・SymFPU・BTOR2Tools等の原licenseと本NOTICEを同梱しています。この限定認定でも両候補を製品資材には追加しません。製品配布の条件は未確認です。

## 既存の実行資材と開発依存

以下の固定版を使用しています。コミットは `vendor/` の gitlink に記録した値です。

| 部品 | 固定版 / commit | ライセンス | WASM への静的リンク / 開発用 | web zip 内のライセンスファイル |
|---|---|---|---|---|
| openFPGALoader | v1.2.0 / `befbab4f646207dbaf1daf8b144dd980ad283dd5` | Apache-2.0 | WASM に静的リンク | `licenses/openFPGALoader-LICENSE` |
| libusb | v1.0.30 / `87a55632db62c9bdc58cd31d3ccfa673f1bb017f` | LGPL-2.1-or-later | WASM に静的リンク | `licenses/libusb-COPYING` |
| libftdi | 1.6rc1 / `92d657bcb543a9622947d984d4a8e725fb680e8c` | LGPL-2.1（ライブラリ部分） | WASM に静的リンク | `licenses/libftdi-COPYING.LIB` |
| zlib | v1.3.2 / `da607da739fa6047df13e66a2af6b8bec7c2a498` | zlib | WASM に静的リンク | `licenses/zlib-LICENSE` |
| zstd | v1.5.7 / `f8745da6ff1ad1e7bab384bd1f9d742439278e99` | BSD-3-Clause OR GPL-2.0（dual license、BSD を選択） | WASI decoder に静的リンク | `licenses/zstd-LICENSE` |
| xz-embedded | v20240322 / `62d5603b5114c5aa8bb5f6bb461efbe0e3b51891` | 0BSD | WASI decoder に静的リンク | `licenses/xz-embedded-COPYING` |
| Yosys | v0.70 / `28ba3cb926fe376fa05ebfc1b921747d011d4557` | ISC | WASI WASM に静的リンク | `licenses/yosys-COPYING` |
| ABC | `6c5104934c90eb3cdef9ea063318f7588908a185` | Regents of the University of California の許諾条件 | Yosys WASM に静的リンク | `licenses/abc-copyright.txt` |
| cxxopts | `4bf61f08697b110d9e3991864650a405b3dd515d` | MIT | Yosys WASM に静的リンク | `licenses/cxxopts-LICENSE` |
| fmt | `a00f82c6b66dcae15503ba19c1598b2733057dea` | MIT | Yosys WASM に静的リンク | `licenses/fmt-LICENSE` |
| nextpnr-himbaechel | nextpnr-0.11.1 / `62e659ed6748e9f60b2a4aa25dd4fe79a9605881` | ISC | WASI WASM に静的リンク | `licenses/nextpnr-COPYING` |
| Boost | 1.92.0 / SHA-256 `ea7b982002cc9dfbe59b0b217b206f470dc75f3de0bb2973d844118934d82411` | Boost Software License 1.0 | `program_options`、`iostreams` を nextpnr WASM に静的リンク | `licenses/boost-LICENSE_1_0.txt` |
| Eigen | 5.0.1 / SHA-256 `e9c326dc8c05cd1e044c71f30f1b2e34a6161a3b6ecf445d56b53ff1669e3dec` | 主に MPL-2.0。一部に BSD など互換ライセンスのコード | nextpnr WASM のビルドでヘッダーを使用 | `licenses/eigen-*` |
| Apicula / `gowin_pack` | 0.35、`requirements-nextpnr.txt` の wheel SHA-256 で固定 | MIT | Apicula wheel と Python コードを `dist/pack/wheels/` と Release に含む。Pyodide 上で bitstream を生成 | `licenses/apycula-LICENSE` |
| Pyodide / micropip | npm 314.0.7、lock の micropip 0.11.1 | MPL-2.0 | `pyodide.mjs`、WASM、Python 標準ライブラリーと micropip wheel を `dist/pack/` に含む | `licenses/pyodide-MPL-2.0.txt` |
| CPython | Pyodide に含まれる Python 3.14.2 | PSF License Version 2 | Pyodide の `python_stdlib.zip` として `dist/pack/pyodide/` に含む | `licenses/CPython-PSF-License.txt` |
| NumPy / msgspec | Pyodide lock: 2.4.6 / 0.20.0 | NumPy: BSD-3-Clause、msgspec: BSD-3-Clause | Pyodide 用 wheel を `dist/pack/wheels/` に含む。native test 環境にも固定依存を導入 | `licenses/apycula-dependencies/numpy-LICENSE`、`licenses/apycula-dependencies/msgspec-LICENSE` |
| fastcrc | `requirements-nextpnr.txt` で固定 | MIT | native `gowin_pack` の検証依存。Pyodide には含まず、Apicula の CRC table fallback を使う | `licenses/apycula-dependencies/fastcrc-LICENSE` |
| wasi-sdk | 34.0 / `b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4`。ライセンス原文の source commit: `5a0bf653a1a06e1c18867567c5937006d3394a69` | Apache-2.0 | ビルド用 SDK | `licenses/wasi-sdk-LICENSE` |
| LLVM runtime | `895aa2c896ada719451be2e3673c83da8ddf1141` | Apache-2.0 with LLVM Exceptions | libc++、libc++abi、libunwind などを Yosys WASM に静的リンク | `licenses/wasi-sdk-llvm-LICENSE.TXT` |
| wasi-libc | `2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13` | Apache-2.0 with LLVM Exceptions、Apache-2.0、MIT と同梱部品のライセンス | libc を Yosys と GHDL の WASM に静的リンク | `licenses/wasi-libc-LICENSE*` |
| Emscripten のランタイムと libc | 6.0.13 / `35659964bc2762fffec0d257997fb61475f765b7` | MIT、University of Illinois/NCSA、LLVM の Apache-2.0 with LLVM Exceptions | ランタイムと libc の一部を WASM / mjs に含む。emcc はビルド用 | `licenses/emscripten-LICENSE`、`licenses/emscripten-musl-COPYRIGHT`、`licenses/emscripten-libcxx-LICENSE.TXT`、`licenses/emscripten-libcxxabi-LICENSE.TXT`、`licenses/emscripten-llvm-libc-LICENSE.TXT`、`licenses/emscripten-compiler-rt-LICENSE.TXT`、`licenses/emscripten-libunwind-LICENSE.TXT` |
| CodeMirror 6（`codemirror` 6.0.2、`@codemirror/state` 6.7.6、`@codemirror/view` 6.43.15、`@codemirror/language` 6.13.1、`@codemirror/legacy-modes` 6.5.5、`@codemirror/lint` 6.9.7、`@codemirror/autocomplete` 6.20.4、`@codemirror/commands` 6.11.1） | npm 固定版 | MIT | `editor.bundle.mjs` に含む | npm パッケージに同梱 |
| fflate | 0.8.3 | MIT | `project-zip.bundle.mjs` に含む | `licenses/fflate-LICENSE` |
| GHDL | v6.0.0 / `e589c698c351369ac5bcfe7abe1f1152ac5d4727` | GPL-2.0-or-later | GHDL WASM に静的リンク | `licenses/GHDL-COPYING.md` |
| Icarus Verilog | v13_0 / `dfeee909ed9f20b4870dd93423156c0170c0e1ff` | GPL-2.0-or-later | `ivlpp`、`ivl`、`vvp` WASM に静的リンク | `licenses/iverilog-COPYING` |
| Icarus Verilog `tgt-vvp` | v13_0 / `dfeee909ed9f20b4870dd93423156c0170c0e1ff` | LGPL-2.1 | `ivl` WASM に静的リンク | `licenses/iverilog-tgt-vvp-COPYING.lesser` |
| Surfer | v0.7.0 / `bd749b1f786c1c62cd67893ca71346cbe6983915` | EUPL-1.2 | ブラウザー用波形ビューアーとして `dist/surfer/` に配布 | `licenses/surfer-LICENSE-EUPL-1.2.txt`、`dist/surfer/licenses/THIRD_PARTY_NOTICES.md` |
| synth-explorer | `d4dab3def346cb9fdac5bc171d801bd091df72e1` | Apache-2.0 | build script、WASM adapter、3 patches、GHDL WASM tests から一部を採用 | `licenses/synth-explorer-LICENSE` |
| AdaWebPack | 24.0.0 / SHA-256 `8edaae8b9987a20aec430d750f30033f12f953ce2b6437afb87fbf8cc1063796` | BSD-3-Clause | GHDL WASM の開発用 Ada compiler | `licenses/AdaWebPack-LICENSE.BSD3` |
| GCC libgnat | GCC 14.1.0 / commit `ed10445fe222d3973ae13eda9bf211f315c5e3f9` | GPL-3.0-or-later with GCC Runtime Library Exception | GNAT runtime units を GHDL WASM に静的リンク | `licenses/GPL-3.0.txt`、`licenses/GCC-RUNTIME-LIBRARY-EXCEPTION` |

Emscripten SDK の `upstream/emscripten/LICENSE` は Emscripten の MIT と University of Illinois/NCSA のライセンス本文を含む文書です。また、Node.js の一部利用と musl の MIT ライセンスへの案内も記載されています。musl の本文は `system/lib/libc/musl/COPYRIGHT` です。libc++、libc++abi、llvm-libc、compiler-rt、libunwind は SDK 内に個別のライセンスファイルがあるため、上表のとおり別に同梱します。

GHDL 6.0.0 の `COPYING.md` は GPL-2.0-or-later の本文です。synth-explorer の commit `d4dab3def346cb9fdac5bc171d801bd091df72e1` から採用した Apache-2.0 ファイルは次のとおりです。

- `scripts/build-ghdl-wasm.sh`
- `scripts/ghdl-wasm/bug.adb`
- `scripts/ghdl-wasm/grt-stdio.adb`
- `scripts/ghdl-wasm/synth_api.ads`
- `scripts/ghdl-wasm/synth_api.adb`
- `patches/ghdl/blackbox-verilog.patch`
- `patches/ghdl/grt-stdio.patch`
- `patches/ghdl/vhdl-only-synthesis.patch`
- `tests/synth/ghdl-wasm.test.mjs`

`scripts/ghdl-wasm/rts/` の独自 runtime と WASI helper は clean-room 実装で、各ファイルの SPDX 表記に従い GPL-2.0-or-later で提供します。

`ghdl-synth.wasm` は、GPL-2.0-or-later の GHDL と独自 runtime、Apache-2.0 の synth-explorer 由来部分、GPL-3.0-or-later（GCC Runtime Library Exception 付き）の libgnat を結合します。Apache-2.0 は GPL-3.0 と両立し、GPL-2.0 だけとは両立しないため、結合した `ghdl-synth.wasm` は GPL-3.0-or-later として配布します。

AdaWebPack の 24.0.0 release archive にはライセンスファイルがありませんでした。BSD-3-Clause の本文は、同じ 24.0.0 upstream tag の `LICENSE.BSD3` から取得しました。

Yosys と nextpnr の `COPYING` は ISC License の本文です。ABC の `copyright.txt` は University of California, Berkeley の許諾条件を記載したファイルです。Boost と Eigen のライセンス、Apycula と build dependencies のライセンス本文も `licenses/` と配布 zip に含めます。WASI SDK のアーカイブにはライセンス本文が含まれないため、wasi-sdk 34 の source commit と、その commit が参照する LLVM、wasi-libc の各 commit からライセンス文書を取得し、リポジトリーと配布 zip に収録する方針です。wasi-libc の原文には主要ライセンスだけでなく、musl、cloudlibc、musl-fts、wasi-headers の許諾文書も含まれています。

## HDL ライブラリーと CPU コア

`third_party/` の22候補は固定版の shallow submodule として参照します。取得元は [`.gitmodules`](.gitmodules)、固定版は gitlink、ライセンス本文のパスは [部品カタログ](libraries/catalog.json)が正です。候補ごとの用途・条件と訂正履歴は [HDL ライブラリーと CPU コアの調査](docs/research/hdl-libraries.md)に記録しています。

| 部品 | 主なライセンス |
|---|---|
| Colibri | RTL は主に CERN-OHL-W-2.0。Apache-2.0 と CC-BY-SA-4.0 の文書も保持 |
| Open Logic | PSI HDL Library License 1.0（GNU Library GPL v2 以降と、FPGA 等の生成物への例外） |
| hdl-modules、NEORV32、DarkRISCV、learn-fpga の FemtoRV | BSD-3-Clause |
| verilog-axis、verilog-uart、verilog-axi、verilog-ethernet、libfpga、VexRiscv の生成済みリポジトリー、VexiiRiscv | MIT |
| SERV、PicoRV32 | ISC |
| Hazard3、Ibex、OSVVM、UVVM | Apache-2.0 |
| CV32E40P | SHL-0.51 または Apache-2.0 |
| VUnit | HDL と Python 等は MPL-2.0。図版のフォントは別の条件 |
| Taxi | CERN-OHL-S-2.0。有償ライセンスは別途契約が必要 |

静的資材の生成時には、ライセンス文書と登録した部品のソースを固定版から変更せずに取り出します。ファイル内の著作権表示と SPDX 表記も保持します。Web 配布物の `libraries/catalog.json` は、取得元、固定版、元のパス、サイズ、SHA-256 と原文のライセンスへの参照を含みます。Release のソースアーカイブには全 `third_party/` の固定版も含めます。

この表の分類だけで、各ソースの許諾条件を置き換えるものではありません。Colibri の文書とメタデータ、VUnit の図版など、部品の RTL と条件が異なるファイルがあります。配布する部品ごとの原文も確認してください。原文の表示を目的とした登録は、その候補が現在の HDL ツールで使えることや、4ボードで動くことを保証しません。

`verilog-axis`、`verilog-uart`、`verilog-axi`、`verilog-ethernet` は deprecated の表示を保持します。後継の Taxi へ自動で置き換えず、MIT と CERN-OHL-S-2.0 の違いを残します。

## 配布物に含まないもの

- yomiyasu: 文書の推敲に使う開発用ツールです。
- Playwright: E2E テストに使う開発用ツールです。
- esbuild: CodeMirror のバンドルに使うビルド用ツールです。配布物には含めません。

## LGPL ライブラリの再リンク

Pyodide（MPL-2.0）は npm の `pyodide` 314.0.7 を改変せずに同梱します。対応するソースは https://github.com/pyodide/pyodide/tree/314.0.7 で公開されています。

ソース tarball には、使用した固定版の libusb と libftdi の完全なソースを含めます。改変した LGPL ライブラリを使う場合は、tarball 内の `vendor/libusb` または `vendor/libftdi` のソースを置き換え、`scripts/build-wasm.sh` と `scripts/build-web.sh` を実行して再ビルドしてください。生成した WASM を含むアプリを配布する際は、ライブラリの改変に応じて LGPL の条件を満たしてください。
