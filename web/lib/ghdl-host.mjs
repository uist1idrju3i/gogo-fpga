import { createMemoryTree, createWasiP1ImportObject, setTreeEntry } from "./wasi-p1.mjs";
import { getVhdlLibrary } from "./vhdl-order.mjs";

const decoder = new TextDecoder("latin1");

function latin1Bytes(value) {
  return Uint8Array.from(String(value), (character) => character.charCodeAt(0) & 0xff);
}

function insertFile(tree, pathname, content) {
  const parts = pathname.replace(/^\/+/, "").split("/");
  let directory = tree;
  for (const part of parts.slice(0, -1)) {
    if (!part || part === "." || part === "..") throw new Error(`Invalid GHDL path: ${pathname}`);
    if (!Object.hasOwn(directory, part)) setTreeEntry(directory, part, {});
    if (
      directory[part] === null ||
      typeof directory[part] !== "object" ||
      directory[part] instanceof Uint8Array
    ) {
      throw new Error(`Conflicting GHDL path: ${pathname}`);
    }
    directory = directory[part];
  }
  const name = parts.at(-1);
  if (!name || name === "." || name === ".." || Object.hasOwn(directory, name)) {
    throw new Error(`Duplicate or invalid GHDL path: ${pathname}`);
  }
  setTreeEntry(directory, name, content);
}

function normalizePath(pathname) {
  const absolute = pathname.startsWith("/");
  const parts = [];
  for (const part of pathname.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

function latin1String(bytes) {
  return decoder.decode(bytes);
}

export function runGhdlSynth({
  module,
  librariesTree,
  files,
  top,
  standard = "2008",
  formal = false,
  psl = false,
}) {
  if (typeof formal !== "boolean" || typeof psl !== "boolean" || psl && !formal) {
    throw new TypeError("Invalid GHDL formal or PSL setting");
  }
  const standardCode = standard === "2008" ? 8 : standard === "2019" ? 19 : 0;
  if (!standardCode) throw new TypeError(`Unsupported VHDL standard: ${standard}`);
  const tree = { ghdl: { lib: { ghdl: librariesTree } }, tmp: {} };
  for (const file of files) {
    if (file.role !== "data") getVhdlLibrary(file);
    insertFile(tree, file.path, file.content);
  }
  const filesystem = createMemoryTree(tree);
  const descriptors = new Map();
  let nextDescriptor = 100;
  const chunks = [];
  const stdoutChunks = [];
  let instance;
  let memory;
  const bytes = () => new Uint8Array(memory.buffer);
  const view = () => new DataView(memory.buffer);
  const nodeAt = (pathname) => {
    const normalized = normalizePath(pathname);
    let current = filesystem;
    for (const part of normalized.split("/").filter(Boolean)) {
      if (current.type !== "directory") return null;
      current = current.entries.get(part);
      if (!current) return null;
    }
    return current;
  };
  const open = (pathname) => {
    const node = nodeAt(pathname);
    if (node?.type !== "file") return -1;
    const fd = nextDescriptor++;
    descriptors.set(fd, { data: node.data, position: 0 });
    return fd;
  };
  const read = (fd, destination, length) => {
    const descriptor = descriptors.get(fd);
    if (!descriptor) return -1;
    const count = Math.max(0, Math.min(length, descriptor.data.length - descriptor.position));
    destination.set(descriptor.data.subarray(descriptor.position, descriptor.position + count));
    descriptor.position += count;
    return count;
  };
  const emit = (value, fd = 1) => {
    const content = typeof value === "string" ? latin1Bytes(value) : new Uint8Array(value);
    chunks.push(content);
    if (fd === 1) stdoutChunks.push(content);
  };
  const cString = (pointer) => {
    const content = bytes();
    let end = pointer;
    while (content[end] !== 0) end += 1;
    return latin1String(content.subarray(pointer, end));
  };
  const fatString = (pointer, boundsPointer) => {
    const first = view().getInt32(boundsPointer, true);
    const last = view().getInt32(boundsPointer + 4, true);
    return last < first ? "" : latin1String(bytes().subarray(pointer, pointer + last - first + 1));
  };
  const writeFatString = (dataPointer, boundsPointer, value) => {
    const content = bytes();
    const bounds = view();
    for (let index = 0; index < value.length; index += 1) {
      content[dataPointer + index] = value.charCodeAt(index);
    }
    bounds.setInt32(boundsPointer, 1, true);
    bounds.setInt32(boundsPointer + 4, value.length, true);
  };
  const allocationSize = (pointer) => {
    if (!pointer) return 0;
    const base = pointer - 16;
    return (view().getUint32(base + 4, true) & ~1) - base - 16;
  };
  const env = {
    gnat__directory_operations__get_current_dir: (data, bounds) =>
      writeFatString(data, bounds, "/work"),
    ada__command_line__command_name: (data, bounds) => writeFatString(data, bounds, "ghdl"),
    ada__command_line__argument_count: () => 0,
    ada__command_line__argument: (data, bounds) => writeFatString(data, bounds, ""),
    ada__exceptions__exception_identity: () => 0,
    ada__exceptions__exception_name: () => {},
    ada__exceptions__exception_information: () => {},
    strlen: (pointer) => {
      const content = bytes();
      let length = 0;
      while (content[pointer + length] !== 0) length += 1;
      return length;
    },
    strcmp: (left, right) => {
      const content = bytes();
      for (let index = 0; ; index += 1) {
        const difference = content[left + index] - content[right + index];
        if (difference !== 0) return difference;
        if (content[left + index] === 0) return 0;
      }
    },
    realloc: (pointer, size) => {
      if (!pointer) return instance.exports.malloc(size);
      if (!size) {
        instance.exports.free(pointer);
        return 0;
      }
      const oldSize = allocationSize(pointer);
      const replacement = instance.exports.malloc(size);
      if (!replacement) return 0;
      bytes().copyWithin(replacement, pointer, pointer + Math.min(oldSize, size));
      instance.exports.free(pointer);
      return replacement;
    },
    fopen: (pointer) => open(cString(pointer)),
    fclose: (fd) => {
      descriptors.delete(fd);
      return 0;
    },
    fread: (pointer, size, count, fd) => {
      const result = read(fd, bytes().subarray(pointer, pointer + size * count), size * count);
      return result < 0 ? 0 : Math.floor(result / size);
    },
    fwrite: (pointer, size, count, fd) => {
      emit(bytes().subarray(pointer, pointer + size * count), fd);
      return count;
    },
    fputs: (pointer, fd) => {
      const value = cString(pointer);
      emit(value, fd);
      return value.length;
    },
    fgets: (pointer, size, fd) => {
      let count = 0;
      while (count < size - 1) {
        const value = new Uint8Array(1);
        if (read(fd, value, 1) <= 0) break;
        bytes()[pointer + count++] = value[0];
        if (value[0] === 0x0a) break;
      }
      if (!count) return 0;
      bytes()[pointer + count] = 0;
      return pointer;
    },
    fflush: () => 0,
    feof: (fd) => {
      const descriptor = descriptors.get(fd);
      return !descriptor || descriptor.position >= descriptor.data.length ? 1 : 0;
    },
    ftell: (fd) => descriptors.get(fd)?.position ?? -1,
    getc: (fd) => {
      const value = new Uint8Array(1);
      return read(fd, value, 1) <= 0 ? -1 : value[0];
    },
    putc: (value, fd) => {
      emit(Uint8Array.of(value & 0xff), fd);
      return value;
    },
    ungetc: (value, fd) => {
      const descriptor = descriptors.get(fd);
      if (descriptor?.position > 0) descriptor.position -= 1;
      return value;
    },
    setbuf: () => {},
    isatty: () => 0,
    fprintf: () => 0,
    snprintf: () => 0,
    __ghdl_get_stdout: () => 1,
    __ghdl_get_stderr: () => 2,
    __ghdl_get_stdin: () => 0,
    putc_unlocked: (value, fd) => {
      emit(Uint8Array.of(value & 0xff), fd);
      return value;
    },
    getc_unlocked: (fd) => {
      const value = new Uint8Array(1);
      return read(fd, value, 1) <= 0 ? -1 : value[0];
    },
    feof_unlocked: (fd) => {
      const descriptor = descriptors.get(fd);
      return !descriptor || descriptor.position >= descriptor.data.length ? 1 : 0;
    },
    __ghdl_fprintf_g: (fd, value) => emit(String(value), fd),
    __ghdl_snprintf_fmtf: (pointer, length, _format, value) => {
      const text = String(value).slice(0, length - 1);
      for (let index = 0; index < text.length; index += 1) {
        bytes()[pointer + index] = text.charCodeAt(index);
      }
      bytes()[pointer + text.length] = 0;
    },
    gnat__os_lib__is_regular_file: (pointer, bounds) =>
      (nodeAt(fatString(pointer, bounds))?.type === "file" ? 1 : 0),
    gnat__os_lib__is_absolute_path: (pointer, bounds) =>
      (fatString(pointer, bounds).startsWith("/") ? 1 : 0),
    gnat__os_lib__is_directory: (pointer, bounds) =>
      (nodeAt(fatString(pointer, bounds))?.type === "directory" ? 1 : 0),
    gnat__os_lib__is_executable_file: () => 0,
    gnat__os_lib__delete_file: (_a, _b, _c, ok) => {
      if (ok) view().setInt32(ok, 0, true);
    },
    gnat__os_lib__rename_file: (...args) => {
      const ok = args.at(-1);
      if (ok) view().setInt32(ok, 0, true);
    },
    gnat__os_lib__file_time_stamp: () => 0n,
    gnat__os_lib__open_read__2: (pointer) => open(cString(pointer)),
    gnat__os_lib__close: (fd) => {
      descriptors.delete(fd);
      return 0;
    },
    gnat__os_lib__create_file__2: () => -1,
    gnat__os_lib__file_length: (fd) => descriptors.get(fd)?.data.length ?? -1,
    gnat__os_lib__read: (fd, pointer, length) =>
      read(fd, bytes().subarray(pointer, pointer + length), length),
    gnat__os_lib__write: (fd, pointer, length) => {
      emit(bytes().subarray(pointer, pointer + length), fd);
      return length;
    },
    gnat__os_lib__spawn: () => -1,
    gnat__os_lib__locate_exec_on_path: (data, bounds) => writeFatString(data, bounds, ""),
    ada__calendar__clock: () => 0,
    ada__calendar__time_zones__utc_time_offset: () => 0,
    ada__calendar__Osubtract: () => 0,
    ada__calendar__split: () => {},
    ada__characters__handling__to_lower: (value) => value,
    gnat__sha1__update: () => {},
    gnat__sha1__digest__4: () => {},
    gnat__sha1__digest__5: () => {},
    gnat__heap_sort_a__sort: () => {},
    system__img_lli__impl__image_integer: () => 0,
    system__val_lli__impl__value_integer: () => 0n,
    __gnat_put_exception: (pointer, length, line) => {
      const message = latin1String(bytes().subarray(pointer, pointer + length));
      emit(line ? `Predefined exception raised at ${message}:${line}\n` : `User exception: ${message}\n`);
    },
    __gnat_put_int: (value) => emit(`${value}`),
    __gnat_put_char: (value) => emit(Uint8Array.of(value & 0xff)),
    __gnat_put_string: (pointer, length) => emit(bytes().subarray(pointer, pointer + length)),
    __gnat_grow: (value) => value,
    ceil: Math.ceil,
    floor: Math.floor,
    round: Math.round,
    trunc: Math.trunc,
    fmod: (left, right) => left % right,
    fmin: Math.min,
    fmax: Math.max,
    log10: Math.log10,
    cbrt: Math.cbrt,
    getenv: () => 0,
    exit: (code) => {
      throw Object.assign(new Error(`exit(${code})`), { exitCode: code, isExit: true });
    },
    time: (pointer) => {
      if (pointer) view().setBigInt64(pointer, 0n, true);
      return 0n;
    },
    ctime: () => 0,
    __ghdl_maybe_return_via_longjump: () => {},
    __ghdl_run_through_longjump: (functionPointer, argument) => {
      if (functionPointer) {
        try {
          instance.exports.__indirect_function_table.get(functionPointer)(argument);
        } catch {}
      }
      return 0;
    },
    __ghdl_ELABORATE: () => {},
    grt_dynload_open: () => 0,
    grt_dynload_symbol: () => 0,
    grt_save_backtrace: () => {},
    grt_get_clk_tck: () => 100,
    grt_get_times: () => {},
    backtrace_create_state: () => 0,
    backtrace_pcinfo: () => 0,
    loadVhpiModule: () => 0,
    loadVpiModule: () => 0,
    Increment_p_vpi_vecval: () => {},
    vpi_get_value_vec_helper: () => {},
    fstWriterCreate: () => 0,
    fstWriterClose: () => {},
    fstWriterSetFileType: () => {},
    fstWriterSetPackType: () => {},
    fstWriterSetTimescale: () => {},
    fstWriterSetVersion: () => {},
    fstWriterSetRepackOnClose: () => {},
    fstWriterSetParallelMode: () => {},
    fstWriterCreateVar2: () => 0,
    fstWriterSetSourceStem: () => {},
    fstWriterSetSourceInstantiationStem: () => {},
    fstWriterSetScope: () => {},
    fstWriterSetUpscope: () => {},
    fstWriterEmitValueChange: () => {},
    fstWriterEmitVariableLengthValueChange: () => {},
    fstWriterEmitTimeChange: () => {},
    gzopen: () => 0,
    gzwrite: () => 0,
    gzputc: () => 0,
    gzclose: () => {},
    __multi3: (resultPointer, aLow, aHigh, bLow, bHigh) => {
      const a = (BigInt.asUintN(64, aHigh) << 64n) | BigInt.asUintN(64, aLow);
      const b = (BigInt.asUintN(64, bHigh) << 64n) | BigInt.asUintN(64, bLow);
      const result = BigInt.asUintN(128, a * b);
      view().setBigUint64(resultPointer, result & ((1n << 64n) - 1n), true);
      view().setBigUint64(resultPointer + 8, result >> 64n, true);
    },
  };
  const wasi = createWasiP1ImportObject({
    args: [],
    env: {},
    preopens: { "/": filesystem },
    stdout: emit,
    stderr: (value) => emit(value, 2),
  });
  instance = new WebAssembly.Instance(module, { env, ...wasi.importObject });
  wasi.initialize(instance);
  memory = instance.exports.memory;
  const pagesNeeded = 1024 - Math.ceil(memory.buffer.byteLength / 65536);
  if (pagesNeeded > 0) memory.grow(pagesNeeded);
  if (typeof instance.exports._initialize === "function") instance.exports._initialize();
  else instance.exports.__wasm_call_ctors();

  const exports = instance.exports;
  const memoryBytes = () => memory?.buffer.byteLength ?? 0;
  const pushString = (value) => {
    const content = latin1Bytes(value);
    const pointer = exports.malloc(content.length + 1);
    bytes().set(content, pointer);
    bytes()[pointer + content.length] = 0;
    return [pointer, content.length];
  };
  const log = () => chunks.map(latin1String).join("");
  const started = performance.now();
  let stage = "init";
  if (typeof exports.ghdlwasm_init === "function") exports.ghdlwasm_init();
  if (typeof exports.synth_api__synth_set_std !== "function") {
    return {
      status: -1,
      verilog: "",
      log: "GHDL WASM does not support runtime VHDL standard selection",
      stage,
      durationMs: performance.now() - started,
      memoryBytes: memoryBytes(),
    };
  }
  if (exports.synth_api__synth_set_std(standardCode) !== 0) {
    return {
      status: -1,
      verilog: "",
      log: `GHDL WASM rejected VHDL standard ${standard}`,
      stage,
      durationMs: performance.now() - started,
      memoryBytes: memoryBytes(),
    };
  }
  const initResult = exports.synth_api__synth_init();
  if (initResult !== 0) {
    return {
      status: initResult,
      verilog: "",
      log: log(),
      stage,
      durationMs: performance.now() - started,
      memoryBytes: memoryBytes(),
    };
  }

  if (typeof exports.synth_api__synth_set_formal === "function") {
    if (exports.synth_api__synth_set_formal(Number(formal), Number(psl)) !== 0) {
      return {
        status: -1, verilog: "", log: "GHDL rejected formal or PSL settings", stage,
        durationMs: performance.now() - started, memoryBytes: memoryBytes(),
      };
    }
  } else if (formal || psl) {
    return {
      status: -1, verilog: "", log: "GHDL WASM does not support formal or PSL settings", stage,
      durationMs: performance.now() - started, memoryBytes: memoryBytes(),
    };
  }

  let currentLibrary = "work";
  const selectLibrary = (library) => {
    if (library === currentLibrary) return 0;
    if (typeof exports.synth_api__synth_set_library !== "function") {
      emit("GHDL WASM does not support named VHDL libraries");
      return -1;
    }
    const [pointer, length] = pushString(library);
    let result;
    try {
      result = exports.synth_api__synth_set_library(pointer, length);
    } catch {
      result = 1;
    } finally {
      exports.free(pointer);
    }
    if (result === 0) currentLibrary = library;
    return result;
  };
  const libraryFailure = (status, file) => ({
    status, verilog: "", log: log(), stage: "library", file,
    durationMs: performance.now() - started, memoryBytes: memoryBytes(),
  });
  for (const file of files.filter((file) => file.role !== "data")) {
    chunks.length = 0;
    const selected = selectLibrary(getVhdlLibrary(file));
    if (selected !== 0) return libraryFailure(selected, file.path);
    stage = "analyze";
    chunks.length = 0;
    const [pointer, length] = pushString(file.path);
    let result;
    try {
      result = exports.synth_api__analyze_file(pointer, length);
    } catch {
      result = 1;
    }
    exports.free(pointer);
    if (result !== 0) {
      return {
        status: result || 1,
        verilog: "",
        log: log(),
        stage,
        file: file.path,
        durationMs: performance.now() - started,
        memoryBytes: memoryBytes(),
      };
    }
  }

  chunks.length = 0;
  const selected = selectLibrary("work");
  if (selected !== 0) return libraryFailure(selected);
  stdoutChunks.length = 0;
  stage = "synthesize";
  const [topPointer, topLength] = pushString(top.toLowerCase());
  let result;
  try {
    result = exports.synth_api__synth_top(topPointer, topLength);
  } catch {
    result = 1;
  }
  exports.free(topPointer);
  const output = log();
  return {
    status: result || 0,
    verilog: result === 0 ? stdoutChunks.map(latin1String).join("") : "",
    log: output,
    stage,
    durationMs: performance.now() - started,
    memoryBytes: memoryBytes(),
  };
}
