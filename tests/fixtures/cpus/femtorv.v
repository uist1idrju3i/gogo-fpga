// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output wire led);
`include "bus.vh"
  wire reading;
  wire [31:0] address;
  assign i_addr = address;
  assign d_addr = address;
  assign i_req = reading && address < 72;
  assign d_req = (reading && address >= 72) || (|d_wstrb);
  FemtoRV32 #(.RESET_ADDR(0), .ADDR_WIDTH(12)) cpu(
    .clk(clk), .reset(resetn), .mem_addr(address), .mem_wdata(d_wdata),
    .mem_wmask(d_wstrb), .mem_rdata(address < 72 ? i_rdata : d_rdata),
    .mem_rstrb(reading), .mem_rbusy(1'b0), .mem_wbusy(1'b0)
  );
endmodule
