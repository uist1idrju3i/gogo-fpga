// libfpga :: lfpga_gray — binary <-> Gray code converters (combinational)
// https://github.com/libfpga/libfpga  |  docs & playground: https://libfpga.com
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Antonio Roldao, Ph.D.
//
// Gray order guarantees adjacent codes differ in exactly one bit - the
// property async FIFO pointers rely on. Conversion is pure combinational.

module lfpga_bin2gray #(
    parameter integer WIDTH = 4
) (
    input  wire [WIDTH-1:0] bin,
    output wire [WIDTH-1:0] gray
);
    assign gray = bin ^ (bin >> 1);
endmodule

module lfpga_gray2bin #(
    parameter integer WIDTH = 4
) (
    input  wire [WIDTH-1:0] gray,
    output wire [WIDTH-1:0] bin
);
    genvar i;
    generate
        for (i = 0; i < WIDTH; i = i + 1) begin : g
            assign bin[i] = ^(gray >> i);
        end
    endgenerate
endmodule
