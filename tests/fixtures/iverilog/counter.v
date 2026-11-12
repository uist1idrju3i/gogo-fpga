module top;
  reg clk = 0;
  reg [3:0] count = 0;
  always #5 clk = ~clk;
  always @(posedge clk) count <= count + 1;
  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, top);
    repeat (4) begin
      @(posedge clk);
      $display("count=%0d", count);
    end
    $finish;
  end
endmodule
