# HDL ライブラリー候補の初期調査記録

[調査の索引へ戻る](../../RESEARCH.md#7-分割した調査)

## 現在のカタログとの違い

この文書はRESEARCHの5章にあった初期の転記を保存したものです。現在の候補、URL、固定版、ライセンスを選ぶための一覧ではありません。現在の取得元は [`.gitmodules`](../../.gitmodules)、固定版はgitlink、ライセンス原文は[カタログ](../../libraries/catalog.json)が参照するファイルを正とします。

初期の転記には、Colibriの取得元とOpen Logicのライセンスの誤りがありました。訂正した内容と原典は[HDLライブラリーとCPUコアの調査](hdl-libraries.md)に記録しています。以下は当時の値や説明を改変せずに移した記録です。「T0では取り込んでいない」などの時点も、現在の対応状態を指すものではありません。

## 初期に転記した内容

次の URL と revision は、[fpga-agent の HDL ライブラリー登録](https://github.com/VibeBB/fpga-agent/blob/76560989bf570fca1e0e3b864dd466251c210117/scripts/hdl_libraries.json)から転記しています。すべて T5 の候補で、T0 では取り込んでいません。

| 名前 | HDL | URL | revision | ライセンス |
|---|---|---|---|---|
| Colibri | VHDL | `https://gitlab.com/colibri-cern/colibri.git` | `3fa784121ccea86d9e65b2e0dc08d2a3327f5f2f` | CERN-OHL-W-2.0 |
| Open Logic | VHDL | `https://github.com/open-logic/open-logic.git` | `d9f123aae1c6022288782668067311f9794da0a2` | LGPL-2.1-or-later と PSI HDL exception |
| hdl-modules | VHDL | `https://github.com/hdl-modules/hdl-modules.git` | `8142d3a1d878651811427e609293946e699c5cb7` | BSD-3-Clause |
| verilog-axis | Verilog | `https://github.com/alexforencich/verilog-axis.git` | `48ff7a7e2ef782cf778d47910cf85835c64b1bce` | MIT |
| verilog-uart | Verilog | `https://github.com/alexforencich/verilog-uart.git` | `1b867e53af738e4a8bc7c839ca2f1c07f40382dc` | MIT |
| libfpga | Verilog | `https://github.com/libfpga/libfpga.git` | `a4ef4a3fa4ac1de6aa485baf3efc56f14a6df704` | MIT |
| SERV | Verilog | `https://github.com/olofk/serv.git` | `f200eb2ed7b69ac1c6b8eddd47654522aeee5ce8` | ISC |
| PicoRV32 | Verilog | `https://github.com/YosysHQ/picorv32.git` | `ef203c2b0a3fb793280f5114941416c425c5b461` | ISC |
| NEORV32 | VHDL | `https://github.com/stnolting/neorv32.git` | `84743cdbeefccb531f836d66933c8478f1d9bf71` | BSD-3-Clause |
| Hazard3 | Verilog | `https://github.com/Wren6991/Hazard3.git` | `8af992930f71a69b0e06c38734c1094f41a05ca0` | Apache-2.0 |
| VexRiscv (`pythondata-cpu-vexriscv`) | Verilog | `https://github.com/litex-hub/pythondata-cpu-vexriscv.git` | `642ecfed1c84460555d6d803d660cc60cfc1ecb6` | MIT |

ライセンスは、fpga-agent の [ADR-0004](https://github.com/VibeBB/fpga-agent/blob/76560989bf570fca1e0e3b864dd466251c210117/docs/adr/ADR-0004-external-hdl-libraries-colibri.md)、[ADR-0014](https://github.com/VibeBB/fpga-agent/blob/76560989bf570fca1e0e3b864dd466251c210117/docs/adr/ADR-0014-component-resolution-and-more-hdl-libraries.md)、[ADR-0015](https://github.com/VibeBB/fpga-agent/blob/76560989bf570fca1e0e3b864dd466251c210117/docs/adr/ADR-0015-cpu-core-libraries.md)に記録された値です。取り込み時には各 revision のライセンス本文も確認し、依存の pin とライセンスを checker の対象ファイルに記録します。
