// SPDX-License-Identifier: BSD-3-Clause
`timescale 1ns/1ps
module top;
  reg [7:0] value;
  reg [7:0] previous;
  reg [7:0] difference;
  wire [7:0] gray;
  wire [7:0] decoded;
  integer index;

  lfpga_bin2gray #(.WIDTH(8)) encoder (.bin(value), .gray(gray));
  lfpga_gray2bin #(.WIDTH(8)) decoder (.gray(gray), .bin(decoded));

  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, top);
    previous = 8'h80;
    for (index = 0; index < 256; index = index + 1) begin
      value = index;
      #1;
      if (gray !== (value ^ (value >> 1))) $fatal(1, "Gray value mismatch");
      if (decoded !== value) $fatal(1, "Inverse mismatch");
      difference = gray ^ previous;
      if (difference == 0 || (difference & (difference - 1)) != 0)
        $fatal(1, "Adjacent codes must differ by one bit");
      previous = gray;
    end
    $display("GRAY_256_OK");
    $finish;
  end
endmodule
