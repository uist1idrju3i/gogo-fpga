// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output wire led);
`include "bus.vh"
  wire valid, instruction;
  wire [31:0] address, read_data;
  assign i_req = valid && instruction;
  assign i_addr = address;
  assign d_req = valid && !instruction;
  assign d_addr = address;
  assign read_data = instruction ? i_rdata : d_rdata;
  picorv32 #(
    .ENABLE_COUNTERS(0), .ENABLE_COUNTERS64(0), .ENABLE_REGS_16_31(0),
    .ENABLE_REGS_DUALPORT(0), .PROGADDR_RESET(0), .ENABLE_PCPI(0),
    .ENABLE_MUL(0), .ENABLE_FAST_MUL(0), .ENABLE_DIV(0), .ENABLE_IRQ(0), .ENABLE_TRACE(0)
  ) cpu(
    .clk(clk), .resetn(resetn), .mem_valid(valid), .mem_instr(instruction),
    .mem_ready(i_ack || d_ack), .mem_addr(address), .mem_wdata(d_wdata),
    .mem_wstrb(d_wstrb), .mem_rdata(read_data),
    .pcpi_wr(1'b0), .pcpi_rd(32'b0), .pcpi_wait(1'b0), .pcpi_ready(1'b0), .irq(32'b0)
  );
endmodule
