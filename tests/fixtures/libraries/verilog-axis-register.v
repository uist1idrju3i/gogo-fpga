// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output reg led = 0);
  reg [7:0] value = 0;
  reg [3:0] cycles = 0;
  reg [1:0] reset_shift = 2'b11;
  wire ready, valid;
  wire [7:0] result;
  wire accept = ~cycles[2];
  wire reset = |reset_shift;
  axis_register #(.DATA_WIDTH(8), .REG_TYPE(2)) pipeline (
    .clk(clk), .rst(reset),
    .s_axis_tdata(value), .s_axis_tvalid(1'b1), .s_axis_tready(ready),
    .s_axis_tkeep(1'b1), .s_axis_tlast(value[2]), .s_axis_tid(8'b0),
    .s_axis_tdest(8'b0), .s_axis_tuser(1'b0),
    .m_axis_tdata(result), .m_axis_tvalid(valid), .m_axis_tready(accept)
  );
  always @(posedge clk) begin
    cycles <= cycles + 1;
    reset_shift <= {reset_shift[0], 1'b0};
    if (reset) value <= 0;
    else if (ready) value <= value + 1;
    if (!reset && valid && accept) led <= result[0];
  end
endmodule
