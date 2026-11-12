// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output wire led);
  `include "bus.vh"
  wire [31:0] address;
  wire [1:0] transfer;
  wire [2:0] size;
  wire [3:0] protection;
  wire writing;
  reg active = 0, data_access = 0, data_write = 0;
  reg [31:0] data_address = 0;
  reg [3:0] select = 0;
  always @(posedge clk) begin
    active <= resetn && transfer[1];
    data_access <= protection[0];
    data_write <= writing;
    data_address <= address;
    select <= (4'b1111 >> (4 - (1 << size))) << address[1:0];
  end
  assign i_req = active && !data_access;
  assign d_req = active && data_access;
  assign i_addr = data_address;
  assign d_addr = data_address;
  assign d_wstrb = data_write ? select : 4'b0;
  hazard3_cpu_1port #(
    .RESET_VECTOR(0), .MTVEC_INIT(0), .EXTENSION_A(0), .EXTENSION_C(0),
    .EXTENSION_E(1), .EXTENSION_M(0), .DEBUG_SUPPORT(0), .NUM_IRQS(1)
  ) cpu(
    .clk(clk), .clk_always_on(clk), .rst_n(resetn), .pwrup_ack(1'b1), .unblock_in(1'b0),
    .haddr(address), .hwrite(writing), .htrans(transfer), .hsize(size), .hprot(protection),
    .hready(1'b1), .hresp(1'b0), .hexokay(1'b0), .hwdata(d_wdata),
    .hrdata(data_access ? d_rdata : i_rdata), .fence_rdy(1'b1),
    .dbg_req_halt(1'b0), .dbg_req_halt_on_reset(1'b0), .dbg_req_resume(1'b0),
    .dbg_data0_rdata(32'b0), .dbg_instr_data(32'b0), .dbg_instr_data_vld(1'b0),
    .dbg_sbus_addr(32'b0), .dbg_sbus_write(1'b0), .dbg_sbus_size(2'b0), .dbg_sbus_vld(1'b0),
    .dbg_sbus_wdata(32'b0), .mhartid_val(32'b0), .eco_version(4'b0),
    .irq(1'b0), .soft_irq(1'b0), .timer_irq(1'b0)
  );
endmodule
