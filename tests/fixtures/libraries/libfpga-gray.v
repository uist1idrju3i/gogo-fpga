// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output wire led);
  reg [3:0] value = 0;
  reg [3:0] delayed = 0;
  wire [3:0] gray, decoded;
  lfpga_bin2gray #(.WIDTH(4)) encoder (.bin(value), .gray(gray));
  lfpga_gray2bin #(.WIDTH(4)) decoder (.gray(delayed), .bin(decoded));
  always @(posedge clk) begin
    value <= value + 1;
    delayed <= gray;
  end
  assign led = gray[0] ^ decoded[1];
endmodule
