export const CPU_CASES = [
  { id: "serv", component: "rv32i", language: "verilog", fixture: "serv.v" },
  { id: "picorv32", component: "rv32e", language: "verilog", fixture: "picorv32.v" },
  { id: "neorv32", component: "rv32e", language: "vhdl", fixture: "neorv32.v" },
  { id: "hazard3", component: "rv32e", language: "verilog", fixture: "hazard3.v" },
  { id: "vexriscv", component: "min", language: "verilog", fixture: "vexriscv.v" },
  { id: "darkriscv", component: "rv32i", language: "verilog", fixture: "darkriscv.v" },
  { id: "femtorv", component: "quark", language: "verilog", fixture: "femtorv.v",
    frontendFailure: "Unable to bind wire/reg/memory `instr[" },
];
