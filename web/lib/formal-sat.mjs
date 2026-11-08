import { validatePath } from "./project.mjs";
import { validateFormalProperties } from "./formal-properties.mjs";

const prefix = "__formal/";
const decoder = new TextDecoder("utf-8", { fatal: true });

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Invalid formal ${name}`);
  }
  return value;
}

function sourcePath(value) {
  if (!validatePath(value).ok || value.startsWith(prefix)) throw new Error("Invalid formal input path");
  return value;
}

export function createSatScripts({ sources, includeDirs = [], top, mode = "bmc", depth = 20, timeout = 30, internalCells = false }) {
  if (typeof internalCells !== "boolean") throw new TypeError("Invalid internal formal cell setting");
  if (typeof top !== "string" || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(top)) {
    throw new Error("Invalid formal top identifier");
  }
  if (!["bmc", "prove"].includes(mode)) throw new Error("Unsupported SAT formal mode");
  integer(depth, 1, 1000, "depth");
  integer(timeout, 1, 300, "timeout");
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length) {
    throw new Error("Missing or duplicate formal sources");
  }
  const paths = sources.map((value) => {
    const pathname = sourcePath(value);
    if (!/\.v$/i.test(pathname)) throw new Error("SAT input requires Verilog or lowered VHDL");
    return pathname;
  });
  if (!Array.isArray(includeDirs)) throw new Error("Invalid formal include paths");
  const includes = [...new Set(includeDirs)].map((directory) => {
    if (directory !== ".") {
      if (typeof directory !== "string") throw new Error("Invalid formal include path");
      sourcePath(`${directory}/include.vh`);
    }
    return `-I${directory}`;
  });
  const read = paths.map((pathname) => `read_verilog -formal ${internalCells ? "-icells " : ""}${includes.join(" ")} "${pathname}"`);
  const prepared = `read_rtlil ${prefix}prepared.il; chformal -cover -remove; delete t:$print`;
  const common = `-set-assumes -show-ports -show-regs -timeout ${timeout}`;
  return {
    prepare: [
      ...read, `hierarchy -check -top ${top}`, "proc", "flatten", "async2sync", "chformal -lower",
      `write_json ${prefix}before.json`, `prep -top ${top} -flatten`, "memory_map", "opt_clean", "check -assert",
      `write_json ${prefix}after.json`, `write_rtlil ${prefix}prepared.il`,
    ].join("; "),
    presat: `${prepared}; sat -seq ${depth} ${common}`,
    proof: `${prepared}; sat ${mode === "prove" ? `-seq 1 -tempinduct -maxsteps ${depth}` : `-seq ${depth}`} ${common} -prove-asserts -verify -dump_json ${prefix}witness.json -dump_vcd ${prefix}witness.vcd`,
  };
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return decoder.decode(value);
  throw new TypeError("Missing formal output bytes");
}

function fileText(result, name) {
  if (!(result.files instanceof Map)) throw new TypeError("Missing formal output files");
  return outputText(result.files.get(`${prefix}${name}`));
}

function matches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

export async function runSatFormal({ execute, clock = null, edge = "posedge", ...config }) {
  const scripts = createSatScripts(config);
  const observations = [];
  let phase = "prepare";
  let inventory = null;
  const run = async (name) => {
    phase = name;
    const result = await execute({ phase: name, script: scripts[name] });
    observations.push({ phase: name, ...result });
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0 ||
        typeof result.stdout !== "string" || typeof result.stderr !== "string") {
      throw new Error("Malformed SAT execution result");
    }
    return result;
  };
  try {
    const prepared = await run("prepare");
    if (prepared.exitCode !== 0) throw new Error("Formal preparation failed");
    inventory = validateFormalProperties(
      JSON.parse(fileText(prepared, "before.json")), JSON.parse(fileText(prepared, "after.json")),
      { top: config.top, mode: config.mode ?? "bmc", clock, edge },
    );
    const presat = await run("presat");
    const presatLog = `${presat.stdout}\n${presat.stderr}`;
    if (presat.exitCode !== 0) throw new Error("Formal assumption consistency check failed");
    const hasModel = matches(presatLog, /^SAT solving finished - model found:\s*$/gm);
    const noModel = matches(presatLog, /^SAT solving finished - no model found\.\s*$/gm);
    if (hasModel === 0 && noModel === 1) {
      return { status: "inconsistent-assumptions", inventory, observations };
    }
    if (hasModel !== 1 || noModel !== 0) throw new Error("Missing or ambiguous assumption result");
    const proof = await run("proof");
    const proofLog = `${proof.stdout}\n${proof.stderr}`;
    const bounded = matches(proofLog, /^SAT proof finished - no model found: SUCCESS!\s*$/gm);
    const inductive = matches(proofLog, /^Induction step proven: SUCCESS!\s*$/gm);
    const base = matches(proofLog, /^Base case for induction length \d+ proven\.\s*$/gm);
    const violation = matches(proofLog, /^SAT (?:temporal induction )?proof finished - model found(?: for base case)?: FAIL!\s*$/gm);
    if (violation === 1 && bounded === 0 && inductive === 0 && proof.exitCode !== 0) {
      const vcd = fileText(proof, "witness.vcd");
      const witness = JSON.parse(fileText(proof, "witness.json"));
      if (!/\$enddefinitions\s+\$end/.test(vcd) || !Array.isArray(witness.signal) || !witness.signal.length) {
        throw new Error("Missing or malformed counterexample");
      }
      return { status: "counterexample", replay: "pending", inventory, observations, vcd, witness };
    }
    if (proof.exitCode === 0 && violation === 0) {
      if ((config.mode ?? "bmc") === "bmc" && bounded === 1 && inductive === 0) {
        return { status: "bounded-safe", depth: config.depth ?? 20, inventory, observations };
      }
      if (config.mode === "prove" && inductive === 1 && base > 0 && bounded === 0) {
        return { status: "proved", inventory, observations };
      }
    }
    throw new Error("Unverified or ambiguous SAT proof result");
  } catch (error) {
    return { status: "error", phase, message: String(error.message ?? error), inventory, observations };
  }
}
