// SPDX-License-Identifier: BSD-3-Clause
export const HDL_LIBRARY_CASES = [
  { id: "libfpga", component: "gray", language: "verilog", fixture: "libfpga-gray.v" },
  { id: "colibri", component: "counter", language: "vhdl", fixture: "colibri-counter.vhd" },
  { id: "open-logic", component: "gray", language: "vhdl", fixture: "open-logic-gray.vhd" },
  { id: "hdl-modules", component: "handshake-pipeline", language: "vhdl", fixture: "hdl-modules-pipeline.vhd" },
  { id: "verilog-axis", component: "register", language: "verilog", fixture: "verilog-axis-register.v" },
  { id: "verilog-uart", component: "uart", language: "verilog", fixture: "verilog-uart-loopback.v" },
  { id: "verilog-axi", component: "read-register", language: "verilog", fixture: "verilog-axi-register.v" },
  { id: "verilog-ethernet", component: "crc", language: "verilog", fixture: "verilog-ethernet-crc.v" },
];
