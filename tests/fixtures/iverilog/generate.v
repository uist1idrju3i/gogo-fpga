module top;
  wire [3:0] value;
  genvar index;
  generate
    for (index = 0; index < 4; index = index + 1) begin: bits
      assign value[index] = index[0];
    end
  endgenerate
  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, top);
    #1 $display("generated=%b", value);
    $finish;
  end
endmodule
