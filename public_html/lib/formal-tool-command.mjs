import { safePath } from "./verified-assets.mjs";

const path = value => typeof value === "string" && safePath(value) && !value.includes("\0") && value.length <= 512;

export function validateFormalToolCommand(args, cwd) {
  if (!path(cwd) || !Array.isArray(args) || args.length < 1 || args.length > 64 ||
      !args.every(arg => typeof arg === "string" && arg.length < 4096 && !arg.includes("\0"))) {
    throw new Error("Invalid formal tool command");
  }
  if (args[0] === "yosys") {
    const prefix = "(?:\\.\\./model/)?(?:design(?:_[a-z0-9]+)?|trace(?:_induct)?[0-9]*)";
    if (args.length !== 4 || args[1] !== "-ql" ||
        !new RegExp(`^${prefix}\\.log$`).test(args[2]) || !new RegExp(`^${prefix}\\.ys$`).test(args[3])) {
      throw new Error("Unsupported formal Yosys command");
    }
    return { runtime: "wasi" };
  }
  if (args[0] === "yosys-smtbmc") {
    if (!/^model\/design_smt2(?:_[a-z0-9]+)*\.smt2$/.test(args.at(-1))) throw new Error("Invalid SMTBMC model path");
    const flags = new Set(["--presat", "--unroll", "--noprogress", "-i", "-c"]);
    const paths = new Set(["--dump-vcd", "--dump-yw", "--dump-vlogtb", "--dump-smtc", "--dump-smt2", "--smtc"]);
    const seen = new Set();
    for (let index = 1; index < args.length - 1; index++) {
      const flag = args[index];
      if (seen.has(flag)) throw new Error("Repeated SMTBMC option");
      seen.add(flag);
      if (flags.has(flag)) continue;
      const value = args[++index];
      if (index >= args.length - 1 || (flag === "-s" ? !["yices", "z3", "boolector", "bitwuzla"].includes(value) :
          ["-t", "--append"].includes(flag) ? !/^\d{1,4}$/.test(value) :
          paths.has(flag) ? !path(value) : true)) throw new Error("Unsupported SMTBMC option");
    }
    if (!seen.has("-s") || !seen.has("-t") || !seen.has("--noprogress")) throw new Error("Missing required SMTBMC option");
    return { runtime: "python", entrypoint: "smtbmc", args: args.slice(1) };
  }
  if (args[0] === "yosys-witness" && args.length === 5 && ["aiw2yw", "wit2yw"].includes(args[1]) && args.slice(2).every(path)) {
    return { runtime: "python", entrypoint: "witness", args: args.slice(1) };
  }
  throw new Error("Unsupported formal executable");
}
