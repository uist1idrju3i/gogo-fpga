module top(input wire clk, output wire led);
  child u_child(.clk(clk), .led(led));
endmodule
