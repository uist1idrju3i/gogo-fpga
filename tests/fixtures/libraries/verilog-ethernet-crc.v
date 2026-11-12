// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output wire led);
  reg [7:0] value = 0;
  reg [15:0] state = 16'hffff;
  wire [15:0] next_state;
  lfsr #(
    .LFSR_WIDTH(16), .LFSR_POLY(16'h1021), .LFSR_CONFIG("GALOIS"),
    .LFSR_FEED_FORWARD(0), .REVERSE(0), .DATA_WIDTH(8), .STYLE("LOOP")
  ) crc (.data_in(value), .state_in(state), .state_out(next_state));
  always @(posedge clk) begin
    value <= value + 1;
    state <= next_state;
  end
  assign led = state[0];
endmodule
