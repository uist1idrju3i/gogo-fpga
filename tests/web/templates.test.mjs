import assert from "node:assert/strict";
import test from "node:test";
import { validateProject } from "../../web/lib/project.mjs";
import {
  createBlinkTemplate,
  generateCst,
  TEMPLATE_PINS,
} from "../../web/lib/templates.mjs";

const expectedPins = {
  tangnano1k: {
    clk: { pin: 47, attrs: "IO_TYPE=LVCMOS33 PULL_MODE=UP" },
    led: { pin: 9, attrs: "IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8" },
    source:
      "sipeed/TangNano-1K-examples@3402e3c05affacd11c06bf961226f7d7a21f4f48 example_led/led_prj/src/led_prj.cst",
  },
  tangnano4k: {
    clk: { pin: 45, attrs: "PULL_MODE=UP" },
    led: { pin: 10, attrs: "PULL_MODE=NONE DRIVE=8" },
    source:
      "sipeed/TangNano-4K-example@317743fd94e22e5ff053dad86359a3561e5a2181 led_test/project/src/led_test.cst",
  },
  tangnano9k: {
    clk: { pin: 52, attrs: "IO_TYPE=LVCMOS33 PULL_MODE=UP" },
    led: { pin: 10, attrs: "PULL_MODE=UP DRIVE=8" },
    source:
      "sipeed/TangNano-9K-example@c3b795799f23de91982be52db4273a8eea100cdb led/src/9K_LED_project.cst",
  },
  tangnano20k: {
    clk: { pin: 4, attrs: "IO_TYPE=LVCMOS33 PULL_MODE=UP" },
    led: { pin: 15, attrs: "IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8" },
    source:
      "sipeed/TangNano-20K-example@e23949a0a77381b94960cbc4e97a7c5e5ba8d222 led/blink_led/src/blink_led.cst",
  },
};

test("template pins match the settled board table", () => {
  assert.deepEqual(TEMPLATE_PINS, expectedPins);
});

test("generated CST contains the exact source and pin assignment lines", () => {
  for (const [boardId, pins] of Object.entries(expectedPins)) {
    assert.equal(
      generateCst(boardId),
      [
        `// Generated from web/lib/templates.mjs (${pins.source}). Do not edit by hand.`,
        `IO_LOC "clk" ${pins.clk.pin};`,
        `IO_PORT "clk" ${pins.clk.attrs};`,
        `IO_LOC "led" ${pins.led.pin};`,
        `IO_PORT "led" ${pins.led.attrs};`,
        "",
      ].join("\n"),
    );
  }
});

test("Verilog and VHDL blink projects pass project validation", () => {
  for (const language of ["verilog", "vhdl"]) {
    for (const boardId of Object.keys(expectedPins)) {
      const { project, files } = createBlinkTemplate(boardId, language);
      assert.equal(validateProject(project).ok, true);
      assert.equal(project.name, "blink");
      assert.equal(project.board, boardId);
      assert.equal(project.top, "top");
      assert.deepEqual(project.simulation, {
        top: "top_tb",
        files: language === "verilog" ? ["src/top.v", "src/top_tb.v"] : null,
        timeLimitSeconds: 10,
      });
      assert.equal(files.size, language === "verilog" ? 3 : 2);
      assert.equal(
        project.files[0].path,
        language === "verilog" ? "src/top.v" : "src/top.vhd",
      );
      assert.match(files.get(project.files[0].path), /13(?:_)?500_?000|13499999/);
      if (language === "verilog") {
        assert.match(files.get("src/top.v"), /^`timescale 1ns\/1ps/m);
        const testbench = files.get("src/top_tb.v");
        assert.match(testbench, /^`timescale 1ns\/1ps/m);
        assert.match(testbench, /\$dumpfile\("wave\.vcd"\)/);
        assert.match(testbench, /\$dumpvars\(0, top_tb\)/);
        assert.match(testbench, /\$finish/);
      }
    }
  }
});

test("unknown boards and HDL languages are rejected", () => {
  assert.throws(() => generateCst("unknown"), /ボード/);
  assert.throws(() => createBlinkTemplate("unknown", "verilog"), /ボード/);
  assert.throws(() => createBlinkTemplate("tangnano1k", "systemverilog"), /HDL/);
});
