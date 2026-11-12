export const formalControls = [
  { name: "bounded-pass", fixture: "bmc-prefix", mode: "normal", status: "exited", exitCode: 0, sbyStatus: "PASS" },
  { name: "engine-fail", fixture: "bmc-violation", mode: "normal", status: "exited", exitCode: 2, sbyStatus: "FAIL" },
  { name: "engine-unknown", fixture: "prove-inconclusive", mode: "normal", status: "exited", exitCode: 4, sbyStatus: "UNKNOWN" },
  { name: "cancel", fixture: "bmc-prefix", mode: "cancel", status: "cancelled", event: "solver-stdin-wait" },
  { name: "timeout", fixture: "bmc-prefix", mode: "timeout", status: "timeout", event: "solver-stdin-wait" },
  { name: "crash", fixture: "bmc-prefix", mode: "crash", status: "crashed", event: "root-crash" },
  { name: "protocol", fixture: "bmc-prefix", mode: "protocol", status: "protocol-error", event: "fault-trigger" },
  { name: "corrupt-delta", fixture: "bmc-prefix", mode: "corrupt-delta", status: "runtime-error", event: "delta-corrupted", diagnostic: "Workspace delta hash mismatch:" },
  { name: "conflict-delta", fixture: "bmc-prefix", mode: "conflict-delta", status: "runtime-error", event: "delta-conflict", diagnostic: "Workspace delta conflict:" },
];

export const formalRestrictions = [
  { name: "autotune", args: ["--autotune"], diagnostic: "Browser SBY requires -j 1" },
  { name: "jobs", args: ["-j", "2"], diagnostic: "Browser SBY requires -j 1" },
  { name: "jobserver", args: ["--jobserver-helper"], diagnostic: "Jobserver helpers are not supported in the browser" },
  { name: "temporary", args: ["-t"], diagnostic: "Browser SBY requires -j 1" },
  { name: "links", args: ["--link"], diagnostic: "Browser SBY requires -j 1" },
].map(value => ({ ...value, mode: "normal", status: "runtime-error", fixture: "bmc-prefix", restriction: true }));

export const extraFormalControls = [
  { name: "syntax-error", fixture: "bmc-prefix", mode: "syntax-error", status: "runtime-error", event: "solver-syntax-input" },
  { name: "exit-code", fixture: "bmc-prefix", mode: "exit-code", status: "runtime-error", event: "solver-exit-code" },
];
