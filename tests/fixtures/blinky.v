module blinky (
    input wire clk,
    output wire led
);
    reg [24:0] counter;

    always @(posedge clk)
        counter <= counter + 1'b1;

    assign led = counter[24];
endmodule
