// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output wire led);
  `include "bus.vh"
  wire i_cycle, i_strobe, d_cycle, d_strobe, writing;
  wire [29:0] instruction_address, data_address;
  wire [3:0] select;
  assign i_req = i_cycle && i_strobe;
  assign d_req = d_cycle && d_strobe;
  assign i_addr = {instruction_address, 2'b0};
  assign d_addr = {data_address, 2'b0};
  assign d_wstrb = writing ? select : 4'b0;
  VexRiscv cpu(
    .clk(clk), .reset(!resetn), .externalResetVector(32'b0),
    .timerInterrupt(1'b0), .softwareInterrupt(1'b0), .externalInterruptArray(32'b0),
    .iBusWishbone_CYC(i_cycle), .iBusWishbone_STB(i_strobe), .iBusWishbone_ACK(i_ack),
    .iBusWishbone_ADR(instruction_address), .iBusWishbone_DAT_MISO(i_rdata), .iBusWishbone_ERR(1'b0),
    .dBusWishbone_CYC(d_cycle), .dBusWishbone_STB(d_strobe), .dBusWishbone_ACK(d_ack),
    .dBusWishbone_ADR(data_address), .dBusWishbone_DAT_MISO(d_rdata), .dBusWishbone_ERR(1'b0),
    .dBusWishbone_WE(writing), .dBusWishbone_SEL(select), .dBusWishbone_DAT_MOSI(d_wdata)
  );
endmodule
