`include "constants.vh"
module top;
  reg [3:0] value = `START_VALUE;
  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, top);
    #1 $display("value=%0d", value);
    $finish;
  end
endmodule
