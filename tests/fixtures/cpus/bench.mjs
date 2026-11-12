// SPDX-License-Identifier: BSD-3-Clause
export function cpuBench({ resetHeld = false, wrongExpected = false, sampleHeld = false, ledHeld = false } = {}) {
  return `\`timescale 1ns/1ps
module tb;
  reg clk = 0;
  wire led;
  top dut(.clk(clk), .led(led));
  integer cycles = 0, writes = 0, stores = 0, reads = 0, fetches = 0;
  integer index = 0, seed = 0, samples = 0;
  reg [31:0] expected, last_gpio = 0;
  always #5 clk = ~clk;
  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, clk, led, writes, stores, reads, fetches, seed);
    ${resetHeld ? "force dut.resetn = 1'b0;" : ""}
    ${sampleHeld ? "force dut.sample = 8'd53;" : ""}
    ${ledHeld ? "force led = 1'b0;" : ""}
  end
  always @(posedge clk) begin
    cycles = cycles + 1;
    if (cycles == 100000) $fatal(1, "CPU_TIMEOUT");
    if (dut.resetn) begin
      if (dut.i_req && dut.i_ack) fetches = fetches + 1;
      if (dut.d_req && dut.d_ack) begin
        if (dut.d_addr == 516 && dut.d_wstrb == 0) begin
          if (samples != 0 && seed === dut.d_rdata) $fatal(1, "CPU_SAMPLE_STATIC");
          seed = dut.d_rdata;
          samples = samples + 1;
          index = 0;
        end
        expected = (seed ^ 85) + index;
        if (dut.d_addr >= 256 && dut.d_addr < 288) begin
          if (samples == 0 || dut.d_addr !== 256 + index * 4)
            $fatal(1, "CPU_MEMORY_ADDRESS");
          if (dut.d_wstrb == 15) begin
            if (dut.d_wdata !== expected) $fatal(1, "CPU_MEMORY_WRITE");
            stores = stores + 1;
          end else if (dut.d_wstrb == 0) begin
            if (dut.d_rdata !== expected) $fatal(1, "CPU_MEMORY_READ");
            reads = reads + 1;
          end else $fatal(1, "CPU_BYTE_ENABLE");
        end
        if (dut.d_addr == 512 && dut.d_wstrb != 0) begin
          if (dut.d_wstrb != 15 || dut.d_wdata !== expected + ${wrongExpected ? 1 : 0})
            $fatal(1, "CPU_GPIO_MISMATCH");
          writes = writes + 1;
          last_gpio = dut.d_wdata;
          index = index + 1;
          if (writes == 16) begin
            if (stores != 16 || reads != 16 || samples != 2 || fetches < 100)
              $fatal(1, "CPU_EXECUTION_EVIDENCE");
          end
        end
      end
    end
  end
  always @(negedge clk) begin
    if (writes != 0 && led !== last_gpio[0]) $fatal(1, "CPU_GPIO_OUTPUT");
    if (writes == 16) begin
      $display("CPU_FUNCTION_OK writes=%0d stores=%0d reads=%0d samples=%0d", writes, stores, reads, samples);
      $finish;
    end
  end
endmodule
`;
}
