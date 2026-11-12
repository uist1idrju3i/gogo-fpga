// 正式検証（P6 計測）と P1 回帰テストで共有する Yosys SAT の条件。
// kind が "verdict" の条件だけを 5 回反復の正常系に使い、"error" は負の対照に回す。

const combinational = (property) => `module top(input [3:0] a, output [3:0] y);
  assign y = ~a;
  always @* begin P_ID: assert (${property}); end
endmodule`;

const counter = `module top(input clk, output reg [3:0] q = 0);
  always @(posedge clk) q <= q + 1'b1;
  always @* begin P_BOUND: assert (q < 4'd3); end
endmodule`;

const invariant = `module top(input clk, output reg [3:0] x = 0, output reg [3:0] y = 0);
  always @(posedge clk) begin x <= x + 1'b1; y <= y + 1'b1; end
  always @* begin P_SAME: assert(x == y); end
endmodule`;

export const satFormalCases = [
  { name: "identity", kind: "verdict", source: combinational("(a ^ y) == 4'hf"), expected: "bounded-safe" },
  { name: "broken-identity", kind: "verdict", source: combinational("(a ^ y) == 4'h0"), expected: "counterexample" },
  { name: "depth3", kind: "verdict", source: counter, depth: 3, clock: "clk", expected: "bounded-safe" },
  { name: "depth4", kind: "verdict", source: counter, depth: 4, clock: "clk", expected: "counterexample" },
  { name: "depth5", kind: "verdict", source: counter, depth: 5, clock: "clk", expected: "counterexample" },
  { name: "induction", kind: "verdict", source: invariant, clock: "clk", mode: "prove", expected: "proved" },
  { name: "false-induction", kind: "verdict", source: counter, clock: "clk", mode: "prove", expected: "counterexample" },
  { name: "contradictory-assumes", kind: "verdict", source: `module top(input a); always @* begin
    A: assume(a); B: assume(!a); P: assert(a); end endmodule`, expected: "inconsistent-assumptions" },
  { name: "zero-properties", kind: "error", source: "module top(input a, output y); assign y=a; endmodule", expected: "error" },
  { name: "wrong-clock", kind: "error", source: counter, clock: "missing", expected: "error" },
  { name: "wrong-edge", kind: "error", source: counter, clock: "clk", edge: "negedge", expected: "error" },
  { name: "unsupported-syntax", kind: "error", source: "module top(input clk); assert property (@(posedge clk) 1); endmodule", expected: "error" },
];

export const satVerdictCases = satFormalCases.filter(({ kind }) => kind === "verdict");
export const satErrorCases = satFormalCases.filter(({ kind }) => kind === "error");
