import {
  defaultSimulationSettings,
  PROJECT_VERSION,
  validateProject,
} from "./project.mjs";

export const TEMPLATE_PINS = Object.freeze({
  tangnano1k: Object.freeze({
    clk: Object.freeze({
      pin: 47,
      attrs: "IO_TYPE=LVCMOS33 PULL_MODE=UP",
    }),
    led: Object.freeze({
      pin: 9,
      attrs: "IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8",
    }),
    source:
      "sipeed/TangNano-1K-examples@3402e3c05affacd11c06bf961226f7d7a21f4f48 example_led/led_prj/src/led_prj.cst",
  }),
  tangnano4k: Object.freeze({
    clk: Object.freeze({ pin: 45, attrs: "PULL_MODE=UP" }),
    led: Object.freeze({ pin: 10, attrs: "PULL_MODE=NONE DRIVE=8" }),
    source:
      "sipeed/TangNano-4K-example@317743fd94e22e5ff053dad86359a3561e5a2181 led_test/project/src/led_test.cst",
  }),
  tangnano9k: Object.freeze({
    clk: Object.freeze({
      pin: 52,
      attrs: "IO_TYPE=LVCMOS33 PULL_MODE=UP",
    }),
    led: Object.freeze({ pin: 10, attrs: "PULL_MODE=UP DRIVE=8" }),
    source:
      "sipeed/TangNano-9K-example@c3b795799f23de91982be52db4273a8eea100cdb led/src/9K_LED_project.cst",
  }),
  tangnano20k: Object.freeze({
    clk: Object.freeze({
      pin: 4,
      attrs: "IO_TYPE=LVCMOS33 PULL_MODE=UP",
    }),
    led: Object.freeze({
      pin: 15,
      attrs: "IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8",
    }),
    source:
      "sipeed/TangNano-20K-example@e23949a0a77381b94960cbc4e97a7c5e5ba8d222 led/blink_led/src/blink_led.cst",
  }),
});

export function generateCst(boardId) {
  const pins = TEMPLATE_PINS[boardId];
  if (!pins) {
    throw new Error(`対応していないボードです: ${boardId}`);
  }

  return [
    `// Generated from web/lib/templates.mjs (${pins.source}). Do not edit by hand.`,
    `IO_LOC "clk" ${pins.clk.pin};`,
    `IO_PORT "clk" ${pins.clk.attrs};`,
    `IO_LOC "led" ${pins.led.pin};`,
    `IO_PORT "led" ${pins.led.attrs};`,
    "",
  ].join("\n");
}

function verilogTemplate() {
  return [
    "`timescale 1ns/1ps",
    "module top(input wire clk, output reg led);",
    "  reg [23:0] counter = 24'd0;",
    "",
    "  always @(posedge clk) begin",
    "    if (counter == 24'd13499999) begin",
    "      counter <= 24'd0;",
    "      led <= ~led;",
    "    end else begin",
    "      counter <= counter + 1'b1;",
    "    end",
    "  end",
    "endmodule",
    "",
  ].join("\n");
}

function testbenchTemplate() {
  return [
    "`timescale 1ns/1ps",
    "module top_tb;",
    "  reg clk = 1'b0;",
    "  wire led;",
    "",
    "  top uut (.clk(clk), .led(led));",
    "",
    "  always #5 clk = ~clk;",
    "",
    "  initial begin",
    "    $dumpfile(\"wave.vcd\");",
    "    $dumpvars(0, top_tb);",
    "    #100;",
    "    $finish;",
    "  end",
    "endmodule",
    "",
  ].join("\n");
}

function vhdlTemplate() {
  return [
    "library ieee;",
    "use ieee.std_logic_1164.all;",
    "use ieee.numeric_std.all;",
    "",
    "entity top is",
    "  port (",
    "    clk : in std_logic;",
    "    led : out std_logic",
    "  );",
    "end entity top;",
    "",
    "architecture rtl of top is",
    "  signal counter : unsigned(23 downto 0) := (others => '0');",
    "  signal led_state : std_logic := '0';",
    "begin",
    "  process(clk)",
    "  begin",
    "    if rising_edge(clk) then",
    "      if counter = to_unsigned(13499999, counter'length) then",
    "        counter <= (others => '0');",
    "        led_state <= not led_state;",
    "      else",
    "        counter <= counter + 1;",
    "      end if;",
    "    end if;",
    "  end process;",
    "",
    "  led <= led_state;",
    "end architecture rtl;",
    "",
  ].join("\n");
}

export function createBlinkTemplate(boardId, language) {
  if (!TEMPLATE_PINS[boardId]) {
    throw new Error(`対応していないボードです: ${boardId}`);
  }
  if (language !== "verilog" && language !== "vhdl") {
    throw new Error(`対応していない HDL です: ${language}`);
  }

  const sourcePath = language === "verilog" ? "src/top.v" : "src/top.vhd";
  const testbenchPath = "src/top_tb.v";
  const project = {
    version: PROJECT_VERSION,
    name: "blink",
    board: boardId,
    top: "top",
    vhdlStandard: "2008",
    simulation: defaultSimulationSettings(),
    libraries: [],
    formal: null,
    files: [
      { path: sourcePath },
      ...(language === "verilog" ? [{ path: testbenchPath }] : []),
      { path: `constraints/${boardId}.cst` },
    ],
  };
  const files = new Map([
    [sourcePath, language === "verilog" ? verilogTemplate() : vhdlTemplate()],
    ...(language === "verilog" ? [[testbenchPath, testbenchTemplate()]] : []),
    [`constraints/${boardId}.cst`, generateCst(boardId)],
  ]);
  if (language === "verilog") {
    project.simulation.files = ["src/top.v", testbenchPath];
  }

  const validation = validateProject(project);
  if (!validation.ok) {
    throw new Error(`テンプレートのプロジェクトが不正です: ${validation.errors.join(" ")}`);
  }
  return { project, files };
}
