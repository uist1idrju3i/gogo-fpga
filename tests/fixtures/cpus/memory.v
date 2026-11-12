// SPDX-License-Identifier: BSD-3-Clause
module cpu_memory(
  input wire clk, resetn,
  input wire [7:0] sample,
  input wire [31:0] i_addr,
  input wire i_req,
  output wire [31:0] i_rdata,
  output wire i_ack,
  input wire [31:0] d_addr, d_wdata,
  input wire [3:0] d_wstrb,
  input wire d_req,
  output wire [31:0] d_rdata,
  output wire d_ack,
  output reg [31:0] gpio = 0
);
  reg [31:0] rom [0:17];
  reg [31:0] ram [0:7];
  integer lane;
  initial $readmemh("src/program.hex", rom);
  assign i_rdata = i_addr < 72 ? rom[i_addr[6:2]] : 32'h0000006f;
  assign i_ack = i_req && resetn;
  assign d_ack = d_req && resetn;
  assign d_rdata = d_addr == 516 ? {24'b0, sample} :
                   d_addr >= 256 && d_addr < 288 ? ram[d_addr[4:2]] :
                   d_addr < 72 ? rom[d_addr[6:2]] : 32'b0;
  always @(posedge clk) begin
    if (!resetn) gpio <= 0;
    else if (d_req && d_ack) begin
      if (d_addr == 512 && d_wstrb == 4'b1111) gpio <= d_wdata;
      if (d_addr >= 256 && d_addr < 288)
        for (lane = 0; lane < 4; lane = lane + 1)
          if (d_wstrb[lane]) ram[d_addr[4:2]][lane*8 +: 8] <= d_wdata[lane*8 +: 8];
    end
  end
endmodule

module cpu_startup(input wire clk, output wire resetn, output reg [7:0] sample = 0);
  reg [3:0] reset_count = 0;
  assign resetn = &reset_count;
  always @(posedge clk) begin
    if (!resetn) reset_count <= reset_count + 1'b1;
    sample <= sample + 1'b1;
  end
endmodule
