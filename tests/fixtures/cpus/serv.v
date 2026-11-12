// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output wire led);
`include "bus.vh"
  wire write_enable;
  wire [3:0] select;
  assign d_wstrb = write_enable ? select : 4'b0;
  serv_rf_top #(.WITH_CSR(0), .RESET_PC(0), .COMPRESSED(0), .ALIGN(0), .MDU(0), .W(1)) cpu(
    .clk(clk), .i_rst(!resetn), .i_timer_irq(1'b0),
    .o_ibus_adr(i_addr), .o_ibus_cyc(i_req), .i_ibus_rdt(i_rdata), .i_ibus_ack(i_ack),
    .o_dbus_adr(d_addr), .o_dbus_dat(d_wdata), .o_dbus_sel(select),
    .o_dbus_we(write_enable), .o_dbus_cyc(d_req), .i_dbus_rdt(d_rdata), .i_dbus_ack(d_ack),
    .i_ext_rd(32'b0), .i_ext_ready(1'b0)
  );
endmodule
