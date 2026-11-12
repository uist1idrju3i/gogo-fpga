# OSS の FPGA 開発環境と HDL ライブラリーの広域調査（2026-10-26）

<a id="oss-fpga-survey"></a>

fpga-agent が採用したものに限らず、OSS の FPGA 開発環境、ブラウザーで動く HDL ツール、HDL ライブラリーを調べました。ライセンスと版は、各リポジトリーの LICENSE、GitHub・GitLab の API の表示、公開ページで確かめたものだけを書き、確かめていないものは「未確認」とします。

## ブラウザーで動く HDL ツールの先行例

| 名前 | 内容 | WASM 化の方法 | ライセンス | 本リポジトリへの示唆 |
|---|---|---|---|---|
| [YoWASP](https://yowasp.org/) | Yosys・nextpnr・openFPGALoader などを WASM で配布 | Yosys・nextpnr は wasi-sdk。[`@yowasp/openfpgaloader`](https://www.npmjs.com/package/@yowasp/openfpgaloader) は Emscripten で WebUSB 対応（0.13.1-105.120） | パッケージは ISC | 速度・出力の比較基準にする。Yosys の npm 版は `0.70.62-dev.1236` まで公開されている（npm の表示） |
| [VeriSim](https://github.com/senolgulgonul/verisim) | Icarus Verilog をブラウザーで実行 | Emscripten。`ivlpp`・`ivl`・`vvp` を別々の WASM にし、`iverilog` ドライバーの代わりに JavaScript で 3 段を順に呼び、MEMFS でファイルを渡す（`dlopen` と子プロセスがないため） | GPL-2.0 | T4 の Icarus Verilog は、この構成（3 モジュール + JS で順に呼ぶ）を基本にする |
| [DigitalJS](https://github.com/tilk/digitaljs) / [DigitalJS Online](https://digitaljs.tilk.eu/) | Yosys の合成結果を論理回路図としてブラウザーで動かす | Yosys（WASM）+ yosys2digitaljs。Amaranth（WASM）も扱える | BSD-2-Clause（GitHub の表示） | 回路図表示と、学習向けの「合成結果を見る」機能の参考 |
| [8bitworkshop](https://8bitworkshop.com/docs/platforms/verilog/index.html) | ブラウザーの Verilog IDE | Verilog を JavaScript または WASM に変換して実行（文書の記述） | GPL-3.0 | 初心者向け IDE の操作の参考。Verilator の仕組みは未確認 |
| [synth-explorer](https://github.com/cachanova/synth-explorer) | VHDL-2008 → GHDL 合成 → Verilog → Yosys をブラウザーで実行 | GHDL は AdaWebPack + GNAT-LLVM、Yosys は WASI SDK 33 | Apache-2.0 | T3 の GHDL の第一候補 |
| [ghdl-browser](https://github.com/UnsignedChad/ghdl-browser) | ブラウザーで GHDL によるシミュレーション | WAT 出力のバックエンド | GPL-2.0 | 既知の問題（`NUMERIC_STD` で境界外アクセスなど）があり、採用は保留 |
| [Surfer](https://gitlab.com/surfer-project/surfer) | 波形ビューアー。Web 版（https://app.surfer-project.org/）がある | Rust → WASM | EUPL-1.2（GitLab の表示） | T4 の波形表示の候補。README によると Web 版はネイティブ版より遅く、一部機能がない |

## HDL のツール（言語処理、変換、検証、ビルド）

| 名前 | 役割 | ライセンス | ブラウザーでの扱い（案） |
|---|---|---|---|
| [GHDL](https://ghdl.github.io/ghdl/using/Synthesis.html) | VHDL の解析・シミュレーション・合成（`--synth`、`--out=verilog` で Verilog を出力） | GPL-2.0-or-later | T3。plugin を使わず `--synth --out=verilog` で Verilog に変換し、Yosys に渡す |
| [ghdl-yosys-plugin](https://github.com/ghdl/ghdl-yosys-plugin) | Yosys から GHDL を呼ぶ plugin | GPL-3.0（LICENSE）。GHDL の議論では「Yosys に組み込むと Yosys が GPL になる」と書かれている | ブラウザーでは動的読み込みができず組み込みになるため、ISC の Yosys を保つ目的で使わない |
| [NVC](https://github.com/nickg/nvc) | VHDL シミュレーター | GPL-3.0-or-later | T4。`--disable-llvm` で解釈実行にして Emscripten で WASM 化 |
| [Icarus Verilog](https://github.com/steveicarus/iverilog) | Verilog シミュレーター | GPL-2.0 | T4。VeriSim の構成 |
| Verilator | Verilog/SystemVerilog を C++ に変換 | LICENSE は LGPL-3.0 | 生成した C++ をブラウザーで翻訳する手段がないため将来。先行例 [tiny-tpu](https://github.com/deaneeth/tiny-tpu) は、事前にネイティブで変換・Emscripten でビルドした WASM を配る形で、IDE には向かない |
| [sv-elab（旧 yosys-slang）](https://github.com/povik/yosys-slang) | SystemVerilog を Yosys 用のネットリストに展開 | ISC（GitHub の表示、`povik/sv-elab` へ移転済み） | 将来の SystemVerilog 対応の第一候補 |
| [sv2v](https://github.com/zachjs/sv2v) | SystemVerilog → Verilog-2005 変換 | BSD-3-Clause | 将来の候補。Haskell 製のため WASM 化は未確認 |
| [Verible](https://chipsalliance.github.io/verible/license.html) | SystemVerilog の構文解析・整形・lint | Apache-2.0 | Verilog の lint・整形の候補（WASM 化は未確認） |
| [rust_hdl（vhdl_ls）](https://github.com/VHDL-LS/rust_hdl) | VHDL の言語サーバー（Rust、20 万行を 160 ms で解析と README に記載） | MPL-2.0 | エディターでの即時の診断・補完の候補。Rust なので WASM 化しやすいと見込む（仮説） |
| [Amaranth HDL](https://amaranth-lang.org/docs/amaranth/v0.4.5/platform/gowin.html) | Python の HDL。`GowinPlatform` で Apicula を使える | BSD-2-Clause | 将来。Pyodide で動かせる可能性（DigitalJS Online が WASM で扱う） |
| [LiteX](https://github.com/litex-hub/litex-boards/blob/master/litex_boards/targets/sipeed_tang_nano_20k.py) | SoC 生成。Tang Nano 20K の target がある | BSD-2-Clause | 将来。CPU コアを使う SoC の参考 |
| [FuseSoC / Edalize](https://fusesoc.readthedocs.io/en/stable/user/build_system/index.html) | IP コアの管理とツールの呼び分け | BSD-2-Clause（FuseSoC・Edalize とも） | ライブラリーの依存記述（`.core`）の形式を参考にする |
| [VUnit](https://github.com/VUnit/vunit/blob/master/LICENSE.rst) | VHDL のテスト枠組み（Python） | MPL-2.0（OSVVM を同梱） | 将来。Python の実行部は Pyodide 前提 |
| [cocotb](https://www.cocotb.org/) | Python によるテストベンチ | BSD-3-Clause | 将来。シミュレーターと VPI でつなぐ必要があり難度が高い |
| [CIRCT arcilator](https://circt.llvm.org/) | CIRCT のサイクル精度シミュレーター | 未確認 | 調査のみ。LLVM でネイティブコードを作るためブラウザーには向かない（仮説） |

## 形式検証のソルバー

| 名前 | WASM の状況 | ライセンス |
|---|---|---|
| Z3 | 公式の npm [`z3-solver`](https://www.npmjs.com/package/z3-solver)（5.3.2）が WASM を含む | MIT |
| Yices 2 | 非公式の WASM パッケージがある。wasi-libc では `alarm` が未定義になり、`setjmp`/`longjmp` の除去が必要だった報告がある（[wasi-libc#459](https://github.com/WebAssembly/wasi-libc/issues/459)） | GPL-3.0（`SRI-CSL/yices2`） |
| Boolector / Bitwuzla | YoWASP が Boolector を配布（RESEARCH の前節）。Bitwuzla の WASM は未確認 | 未確認 |

Emscripten なら `setjmp`/`longjmp` と `alarm` 相当を用意できるため、Yices 2 は Emscripten のほうが楽だと見込みます（仮説。T6 で確かめる）。

## Gowin 向けの補足（Apicula の README と wiki）

- [Apicula の wiki](https://github.com/YosysHQ/apicula/wiki/Nextpnr%E2%80%90Himbaechel-Gowin) は 4 ボードの device を次のように示しています。1K は `GW1NZ-LV1QN48C6/I5`、4K は `GW1NSR-LV4CQN48PC7/I6`、9K は `GW1NR-LV9QN88PC6/I5`（`--vopt family=GW1N-9C`）、20K は `GW2AR-LV18QN88C8/I7`（`--vopt family=GW2A-18C`）。
- 「C」付きの品種では、nextpnr に `--device` と `--vopt family` の両方を渡し、`gowin_pack -d` には device ではなく family を渡します（Apicula README の注記）。ボード定義にはこの 2 つを別々に持たせます。
- Sipeed の公式サンプル（例：[TangNano-20K-example](https://github.com/sipeed/TangNano-20K-example)、[TangNano-9K-example](https://github.com/sipeed/TangNano-9K-example)）は、ピン割り当ての出典とテンプレートの参考にします。ライセンスは未確認です。

## HDL ライブラリーと CPU コア（fpga-agent 以外）

| 名前 | 言語 | 内容 | ライセンス | 扱い |
|---|---|---|---|---|
| [PoC](https://github.com/VHDL/PoC) | VHDL | 汎用部品（FIFO、算術、通信など） | Apache-2.0 | T5 の候補 |
| [surf](https://github.com/slaclab/surf/) | VHDL | SLAC の大規模ライブラリー | 独自（GitHub の表示は Other） | 条件を読んでから判断 |
| [en_cl_fix](https://github.com/enclustra/en_cl_fix/) | VHDL（Python・MATLAB も） | 固定小数点演算 | MIT | T5 の候補 |
| OSVVM / UVVM | VHDL | 検証用ライブラリー | どちらも Apache-2.0 | シミュレーション用。T4/T5 で検討 |
| [verilog-ethernet](https://github.com/alexforencich/verilog-ethernet) | Verilog | Ethernet 部品 | MIT | Tang Nano には Ethernet がないため優先度は低い |
| [wb2axip](https://github.com/ZipCPU/wb2axip/) | Verilog | バスのブリッジ（形式検証つき） | 未確認 | 形式検証の題材の候補 |
| [common_cells](https://github.com/pulp-platform/common_cells) | SystemVerilog | PULP の基本部品 | 独自（GitHub の表示は Other） | SystemVerilog 対応後 |
| [BaseJump STL](https://github.com/bespoke-silicon-group/basejump_stl) | SystemVerilog | SystemVerilog の部品集 | 独自（GitHub の表示は Other） | SystemVerilog 対応後 |
| [Ibex](https://lowrisc.org/ibex/) | SystemVerilog | RISC-V コア | Apache-2.0 | SystemVerilog 対応後 |

## この調査で計画に反映すること

1. VHDL の合成は ghdl-yosys-plugin を使わず、GHDL の `--synth --out=verilog` で Verilog を作って Yosys に渡す。Yosys の WASM を ISC のまま保ち、GHDL（GPL）は別の WASM に分ける。synth-explorer も同じ分け方をしている。
2. Icarus Verilog は VeriSim と同じく 3 つの WASM と JavaScript による順次実行にする。
3. ボード定義には nextpnr の `device` と `family`、`gowin_pack` に渡す名前を別々に持たせる。
4. 波形表示は Surfer（EUPL-1.2）の Web 版の組み込みを先に調べ、ライセンスと大きさが合わなければ自作の軽い表示にする。
5. エディターでの即時の VHDL 診断に rust_hdl（vhdl_ls）を、Verilog には Verible を候補として、T1 以降で WASM 化を試す。
