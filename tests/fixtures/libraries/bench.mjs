// SPDX-License-Identifier: BSD-3-Clause
export function libraryBench(id, broken = false) {
  let declarations = "";
  let step;
  let minimum = "";
  let cycles = 1024;
  if (["libfpga", "open-logic"].includes(id)) {
    step = "#1; check(led, (((cycle ^ (cycle >> 1)) & 1) ^ (((cycle - 1) >> 1) & 1)));";
  } else if (id === "colibri") {
    step = "#1; check(led, (cycle % 10) == 9);";
  } else if (id === "verilog-ethernet") {
    declarations = `reg [15:0] crc = 16'hffff;
      reg [7:0] byte_value;
      reg feedback;
      integer bit_index;`;
    step = `byte_value = (cycle - 1) & 255;
      for (bit_index = 7; bit_index >= 0; bit_index = bit_index - 1) begin
        feedback = crc[15] ^ byte_value[bit_index];
        crc = crc << 1;
        if (feedback) crc = crc ^ 16'h1021;
      end
      #1; check(led, crc[0]);`;
  } else if (["verilog-axis", "hdl-modules", "verilog-axi", "verilog-uart"].includes(id)) {
    declarations = "integer sent = 0; integer received = 0;";
    const reset = id === "hdl-modules" ? "1'b0" : "dut.reset";
    const ready = id === "verilog-axi" ? "dut.address_ready" : "dut.ready";
    const value = id === "verilog-axi" ? "dut.address" : "dut.value";
    const valid = id === "verilog-axi" ? "dut.response_valid" : "dut.valid";
    const accept = id === "verilog-uart" ? "1'b1" : id === "hdl-modules" ? "!dut.cycles[2]" : "dut.accept";
    const expected = id === "verilog-axi" ? "(received & 255) ^ 8'ha5" : "received & 255";
    step = `if (!(${reset})) begin
        if (${ready}) begin
          check(${value}, sent & 255);
          sent = sent + 1;
        end
        if (${valid}) begin
          if (received >= sent) $fatal(1, "Unsolicited output");
          check(dut.result, ${expected});
          if (${accept}) received = received + 1;
        end
      end`;
    minimum = 'if (received < 256) $fatal(1, "No progress or incomplete byte range");';
    if (id === "verilog-uart") cycles = 30000;
  } else {
    throw new Error(`No independent scoreboard for ${id}`);
  }
  return `// SPDX-License-Identifier: BSD-3-Clause
    \`timescale 1ns/1ps
    module tb;
      reg clk = 0;
      wire led;
      integer cycle;
      ${declarations}
      top dut(.clk(clk), .led(led));
      always #5 clk = ~clk;
      task check(input [31:0] actual, input [31:0] expected);
        if (actual !== (expected ^ ${broken ? 1 : 0}))
          $fatal(1, "LIBRARY_MISMATCH cycle=%0d actual=%h expected=%h", cycle, actual, expected);
      endtask
      initial begin
        $dumpfile("wave.vcd");
        $dumpvars(1, tb);
        for (cycle = 1; cycle <= ${cycles}; cycle = cycle + 1) begin
          @(posedge clk);
          ${step}
        end
        ${minimum}
        $display("LIBRARY_FUNCTION_OK ${id}");
        $finish;
      end
    endmodule
  `;
}
