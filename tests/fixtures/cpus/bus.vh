// SPDX-License-Identifier: BSD-3-Clause
  wire resetn;
  wire [7:0] sample;
  wire [31:0] i_addr, i_rdata, d_addr, d_wdata, d_rdata, gpio;
  wire [3:0] d_wstrb;
  wire i_req, i_ack, d_req, d_ack;
  cpu_startup startup(.clk(clk), .resetn(resetn), .sample(sample));
  cpu_memory memory(
    .clk(clk), .resetn(resetn), .sample(sample),
    .i_addr(i_addr), .i_req(i_req), .i_rdata(i_rdata), .i_ack(i_ack),
    .d_addr(d_addr), .d_wdata(d_wdata), .d_wstrb(d_wstrb), .d_req(d_req),
    .d_rdata(d_rdata), .d_ack(d_ack), .gpio(gpio)
  );
  assign led = gpio[0];
