// SPDX-License-Identifier: BSD-3-Clause
module top(input wire clk, output reg led = 0);
  reg [7:0] address = 0;
  reg [7:0] response = 0;
  reg pending = 0;
  reg [3:0] cycles = 0;
  reg [1:0] reset_shift = 2'b11;
  wire reset = |reset_shift;
  wire address_ready, response_ready, response_valid, routed_valid;
  wire [7:0] routed_address;
  wire can_accept = !pending || response_ready;
  wire [7:0] result;
  wire accept = ~cycles[2];
  axil_register_rd #(.DATA_WIDTH(8), .ADDR_WIDTH(8), .AR_REG_TYPE(2), .R_REG_TYPE(2)) pipeline (
    .clk(clk), .rst(reset),
    .s_axil_araddr(address), .s_axil_arprot(3'b0), .s_axil_arvalid(1'b1),
    .s_axil_arready(address_ready), .s_axil_rdata(result),
    .s_axil_rvalid(response_valid), .s_axil_rready(accept),
    .m_axil_araddr(routed_address), .m_axil_arvalid(routed_valid),
    .m_axil_arready(can_accept), .m_axil_rdata(response), .m_axil_rresp(2'b0),
    .m_axil_rvalid(pending), .m_axil_rready(response_ready)
  );
  always @(posedge clk) begin
    cycles <= cycles + 1;
    reset_shift <= {reset_shift[0], 1'b0};
    if (reset) begin
      address <= 0;
      response <= 0;
      pending <= 0;
    end else begin
      if (address_ready) address <= address + 1;
      if (can_accept) begin
        pending <= routed_valid;
        if (routed_valid) response <= routed_address ^ 8'ha5;
      end
      if (response_valid && accept) led <= result[0];
    end
  end
endmodule
