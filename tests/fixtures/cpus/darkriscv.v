// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output wire led);
  `include "bus.vh"
  wire [3:0] select;
  wire writing;
  reg [31:0] instruction = 0;
  always @(posedge clk) instruction <= i_rdata;
  assign d_wstrb = writing ? select : 4'b0;
  darkriscv #(.CPTR(0)) cpu(
    .CLK(clk), .RES(!resetn), .IRQ(1'b0),
    .IDREQ(i_req), .IADDR(i_addr), .IDATA(instruction), .IDACK(i_ack), .IBERR(1'b0),
    .DDREQ(d_req), .DADDR(d_addr), .DBE(select), .DWR(writing),
    .DATAO(d_wdata), .DATAI(d_rdata), .DDACK(d_ack), .DBERR(1'b0)
  );
endmodule
