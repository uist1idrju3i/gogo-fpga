// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output reg led = 0);
  reg [7:0] value = 0;
  reg [3:0] reset_count = 0;
  wire reset = reset_count < 4;
  wire ready, valid, serial;
  wire [7:0] result;
  uart #(.DATA_WIDTH(8)) loopback (
    .clk(clk), .rst(reset), .s_axis_tdata(value),
    .s_axis_tvalid(!reset), .s_axis_tready(ready),
    .m_axis_tdata(result), .m_axis_tvalid(valid), .m_axis_tready(1'b1),
    .rxd(serial), .txd(serial), .prescale(16'd1)
  );
  always @(posedge clk) begin
    if (reset_count != 15) reset_count <= reset_count + 1;
    if (reset) value <= 0;
    else if (ready) value <= value + 1;
    if (!reset && valid) led <= result[0];
  end
endmodule
