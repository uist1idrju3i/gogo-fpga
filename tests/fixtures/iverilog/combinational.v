module top;
  reg [3:0] a = 4'h3;
  reg [3:0] b = 4'h5;
  wire [4:0] sum = a + b;
  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, top);
    #1 $display("sum=%0d", sum);
    $finish;
  end
endmodule
