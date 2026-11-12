import { sbyCases } from "./formal-sby-cases.mjs";

const counter = sbyCases.find(fixture => fixture.name === "bmc-violation").source;
const reset = `module top(input clk, rst, output reg [3:0] q = 0, output reg started = 0);
  always @(posedge clk) begin started <= 1; if (rst) q <= 0; else q <= q + 1'b1; end
  always @* begin A_RESET: assume (rst == !started); end
  always @* begin P_BOUND: assert (q < 4'd3); end
endmodule
`;

export const smtReplayCases = [
  { name: "depth-n-minus-1", source: counter, depth: 4, status: "PASS", clock: "clk", replay: "rejected" },
  { name: "depth-n", source: counter, depth: 5, clock: "clk" },
  { name: "depth-n-plus-1", source: counter, depth: 6, clock: "clk" },
  { name: "prove-basecase", source: counter, mode: "prove", depth: 6, clock: "clk" },
  { name: "negedge", source: counter.replace("posedge", "negedge"), depth: 6, clock: "clk", edge: "negedge" },
  { name: "nonzero-initial", source: counter.replace("count = 0", "count = 2").replace("count != 3", "count != 5"), depth: 6, clock: "clk" },
  { name: "combinational", source: `module top(input [2:0] a, output [2:0] y);
  assign y = a + 1'b1;
  always @* begin A_INPUT: assume (a == 3); end
  always @* begin P_BOUND: assert (y != 4); end
endmodule
`, depth: 3 },
  { name: "reset", source: reset, depth: 6, clock: "clk" },
  { name: "assumption", source: counter.replace("input clk", "input clk, enable").replace("  reg", "  always @* begin A_ENABLE: assume (enable); end\n  reg"), depth: 6, clock: "clk" },
  { name: "multiple-properties", source: counter.replace("    assert", "    assert(count < 6);\n    assert"), depth: 6, clock: "clk" },
  { name: "hierarchy", source: counter.replace("module top", "module child") + "module top(input clk);\n  child u (.clk(clk));\nendmodule\n", depth: 6, clock: "clk" },
  { name: "arbitrary-initial", source: counter.replace("count = 0", "count"), depth: 6, clock: "clk", replay: "rejected" },
  { name: "unknown-initial", source: counter.replace("count = 0", "count = 3'bxxx"), depth: 6, clock: "clk", replay: "rejected" },
  { name: "memory", source: `module top(input clk, a);
  reg [2:0] mem [0:1];
  initial begin mem[0] = 0; mem[1] = 0; end
  always @(posedge clk) begin
    mem[a] <= mem[a] + 1;
    assert(mem[a] != 3);
  end
endmodule
`, depth: 6, clock: "clk", replay: "rejected" },
  { name: "no-property", source: "module top(input clk, output y);\n  assign y = clk;\nendmodule\n", depth: 3, status: "PASS", clock: "clk", replay: "rejected" },
  { name: "vacuous-assumption", source: `module top(input a, output y);
  assign y = a;
  always @* begin A_EMPTY: assume (1'b0); end
  always @* begin P_BOUND: assert (y); end
endmodule
`, depth: 3, status: "ERROR", replay: "rejected" },
  { name: "combinational-loop", source: `module top(input a, output y);
  assign y = a ^ y;
  always @* begin P_BOUND: assert (y); end
endmodule
`, depth: 3, status: "ERROR", replay: "rejected" },
].map(fixture => ({ mode: "bmc", status: "FAIL", replay: "verified", edge: "posedge", clock: null, ...fixture,
  kind: fixture.status === "ERROR" ? "tool-error" : fixture.status === "PASS" ? "bounded-pass" : "counterexample",
  witness: !["PASS", "ERROR"].includes(fixture.status) }));
