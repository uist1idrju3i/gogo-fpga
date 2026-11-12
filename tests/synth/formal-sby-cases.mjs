const bug = `module top(input clk);
  reg [2:0] count = 0;
  always @(posedge clk) begin
    count <= count + 1;
    assert(count != 3);
  end
endmodule
`;

function boundedCounter(target) {
  return `module top(input clk);
  reg [2:0] count = 0;
  always @(posedge clk) begin
    count <= count == 3 ? 0 : count + 1;
    assert(count < 4);
    cover(count == ${target});
  end
endmodule
`;
}

export const sbyCases = [
  { name: "bmc-prefix", mode: "bmc", depth: 2, status: "PASS", kind: "bounded-pass", source: bug },
  { name: "bmc-violation", mode: "bmc", depth: 6, status: "FAIL", kind: "counterexample", witness: true, source: bug },
  { name: "prove-inconclusive", mode: "prove", depth: 2, status: "UNKNOWN", kind: "unknown", source: bug },
  { name: "prove-invariant", mode: "prove", depth: 6, status: "PASS", kind: "proved", source: boundedCounter(3) },
  { name: "cover-reached", mode: "cover", depth: 6, status: "PASS", kind: "covered", witness: true, source: boundedCounter(3) },
  { name: "cover-unreached", mode: "cover", depth: 6, status: "FAIL", kind: "unreached", source: boundedCounter(6) },
];

export function sbyConfig(fixture, solver) {
  if (typeof solver !== "string") throw new Error("Missing baseline solver");
  selectFormalSolvers(solver);
  return `[options]
mode ${fixture.mode}
depth ${fixture.depth}

[engines]
smtbmc ${solver === "yices2" ? "yices" : solver}

[script]
read -formal ${fixture.vhdl ? "-icells " : ""}top.v
prep -top top

[files]
top.v
`;
}

export function selectFormalSolvers(solver) {
  if (solver === undefined) return ["yices2", "z3"];
  if (!["yices2", "z3", "boolector", "bitwuzla"].includes(solver)) throw new Error("Unsupported diagnostic solver");
  return [solver];
}
