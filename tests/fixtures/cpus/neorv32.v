// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output wire led);
  `include "bus.vh"
  neorv32_bridge cpu(
    .clk(clk), .resetn(resetn),
    .i_addr(i_addr), .i_req(i_req), .i_rdata(i_rdata), .i_ack(i_ack),
    .d_addr(d_addr), .d_wdata(d_wdata), .d_wstrb(d_wstrb), .d_req(d_req),
    .d_rdata(d_rdata), .d_ack(d_ack)
  );
endmodule
