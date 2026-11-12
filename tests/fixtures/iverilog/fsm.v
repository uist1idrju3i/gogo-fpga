module top;
  reg clk = 0;
  reg [1:0] state = 0;
  always #5 clk = ~clk;
  always @(posedge clk) state <= state + 1;
  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, top);
    repeat (5) @(posedge clk);
    $display("state=%0d", state);
    $finish;
  end
endmodule
