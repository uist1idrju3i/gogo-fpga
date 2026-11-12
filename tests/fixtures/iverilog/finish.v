module top;
  reg value = 0;
  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, top);
    #2 value = 1;
    #3 $finish;
  end
endmodule
