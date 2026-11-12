import { getBoard } from "./boards.mjs";
import { validateOptions } from "./options.mjs";

function parseByteValue(value, name) {
  const text = String(value).trim();
  const isHex = /^0[xX][0-9a-fA-F]+$/.test(text);
  if (!isHex && !/^[0-9]+$/.test(text)) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  const number = Number(isHex ? BigInt(text) : text);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`${name} must be a safe non-negative integer`);
  }
  return number;
}

function appendCommonOptions(args, options) {
  if (options.frequency !== "default") {
    args.push("--freq", options.frequency);
  }
  if (options.verbosity === "verbose") {
    args.push("-v");
  } else if (options.verbosity === "debug") {
    args.push("--verbose-level", "2");
  }
}

export function buildArgs({ board, options }) {
  if (!getBoard(board)) {
    throw new RangeError(`Unknown board: ${board}`);
  }

  const errors = validateOptions(board, options);
  if (errors.length > 0) {
    throw new RangeError(errors.join(" "));
  }

  const args = ["-b", board];
  appendCommonOptions(args, options);

  if (options.operation === "erase") {
    args.push("--bulk-erase");
    return args;
  }

  if (options.operation === "dump") {
    const size = options.dumpSize === "all"
      ? getBoard(board).flashBytes
      : parseByteValue(options.dumpSizeBytes, "dump size");
    if (board !== "tangnano20k") {
      args.push("--external-flash");
    }
    args.push("--dump-flash", "--file-size", String(size));
    const offset = parseByteValue(options.offset, "offset");
    if (offset > 0) {
      args.push("-o", String(offset));
    }
    args.push("/dump.bin");
    return args;
  }

  if (options.target === "flash") {
    args.push("-f");
    if (options.flashType === "external" && board !== "tangnano20k") {
      args.push("--external-flash");
    }

    const verify = options.verify === "default"
      ? options.flashType === "external"
      : options.verify;
    if (verify) {
      args.push("--verify");
    }

    const offset = parseByteValue(options.offset, "offset");
    if (offset > 0) {
      args.push("-o", String(offset));
    }
    if (options.unprotectFlash) {
      args.push("--unprotect-flash");
    }
    if (options.mcufw) {
      args.push("--mcufw", "/mcufw.bin");
    }
    if (options.userFlash) {
      args.push("--user-flash", "/user-flash.bin");
    }
  }

  if (options.reset) {
    args.push("-r");
  }
  args.push("/input.fs");
  return args;
}
