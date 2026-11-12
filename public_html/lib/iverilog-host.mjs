import {
  createMemoryTree,
  runWasiP1,
  setTreeEntry,
  treeToObject,
} from "./wasi-p1.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizePath(path) {
  const parts = String(path).split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === ".." || part.includes("\0"))) {
    throw new TypeError(`Invalid in-memory path: ${path}`);
  }
  return parts;
}

function insertFile(tree, path, content) {
  const parts = normalizePath(path);
  if (!parts.length) throw new TypeError("A file path is required");
  let directory = tree;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(directory, part)) setTreeEntry(directory, part, {});
    if (
      directory[part] === null ||
      typeof directory[part] !== "object" ||
      directory[part] instanceof Uint8Array
    ) {
      throw new TypeError(`Path component is not a directory: ${part}`);
    }
    directory = directory[part];
  }
  const name = parts.at(-1);
  if (Object.hasOwn(directory, name)) throw new TypeError(`Duplicate in-memory path: ${path}`);
  setTreeEntry(directory, name, content);
}

function writeFile(root, path, content) {
  const parts = normalizePath(path);
  if (!parts.length) throw new TypeError("A file path is required");
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    let child = directory.entries.get(part);
    if (!child) {
      child = {
        type: "directory",
        name: part,
        parent: directory,
        entries: new Map(),
      };
      directory.entries.set(part, child);
    }
    if (child.type !== "directory") {
      throw new TypeError(`Path component is not a directory: ${part}`);
    }
    directory = child;
  }
  const name = parts.at(-1);
  directory.entries.set(name, {
    type: "file",
    name,
    parent: directory,
    data: typeof content === "string" ? encoder.encode(content) : new Uint8Array(content),
  });
}

function chunksToBytes(chunks) {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function runStage(module, args, root, libraries, onPollOneoff, projectRoot = false) {
  const stdout = [];
  const stderr = [];
  const result = runWasiP1(module, {
    args,
    env: { TMPDIR: "/tmp", SOURCE_DATE_EPOCH: "0", TZ: "UTC" },
    preopens: projectRoot ? { "/": root.entries.get("work") } : {
      "/": root,
      "/work": root.entries.get("work"),
      "/share": libraries,
      "/tmp": root.entries.get("tmp"),
    },
    onPollOneoff,
    stdout: (bytes) => stdout.push(bytes),
    stderr: (bytes) => stderr.push(bytes),
  });
  return {
    status: result.exitCode,
    stdout: chunksToBytes(stdout),
    stderr: chunksToBytes(stderr),
    memoryBytes: result.memoryBytes,
  };
}

export function runIverilog({
  modules,
  librariesTree = {},
  files,
  sourceFiles = files?.map(({ path }) => path),
  top,
  includeDirs = [],
  defines = {},
  formal = false,
  onPollOneoff = () => {},
}) {
  if (typeof formal !== "boolean") throw new TypeError("Formal replay flag must be boolean");
  if (!modules?.ivlpp || !modules?.ivl || !modules?.vvp) {
    throw new TypeError("ivlpp, ivl, and vvp modules are required");
  }
  if (!Array.isArray(files) || files.length === 0 || !top) {
    throw new TypeError("Verilog files and a top module are required");
  }

  const treeObject = { tmp: {}, work: {} };
  for (const file of files) {
    insertFile(treeObject.work, file.path, file.content);
  }
  const root = createMemoryTree(treeObject);
  const libraries = createMemoryTree(librariesTree);
  const config = [
    "module:system",
    "flag:DLL=vvp.tgt",
    "flag:VVP_EXECUTABLE=vvp",
    "functor:cprop",
    "functor:nodangle",
    `root:${top}`,
    "out:/work/design.vvp",
    `generation:${formal ? "2012" : "2"}`,
  ].join("\n");
  const flags = [
    ...includeDirs.map((directory) => `I:/work/${normalizePath(directory).join("/")}`),
    ...Object.entries(defines).map(([name, value]) => `D:${name}=${value}`),
    ...(formal ? ["D:FORMAL=1"] : []),
  ].join("\n");
  writeFile(root, "/work/ivl.conf", config);
  writeFile(root, "/work/ivlpp.flags", flags);

  const paths = sourceFiles.map((path) => `/work/${normalizePath(path).join("/")}`);
  const preprocessed = runStage(
    modules.ivlpp,
    ["ivlpp", "-F", "work/ivlpp.flags", "-L", ...paths.map((path) => path.slice(1))],
    root,
    libraries,
    onPollOneoff,
  );
  if (preprocessed.status !== 0) {
    return {
      status: preprocessed.status,
      stdout: decoder.decode(preprocessed.stdout),
      stderr: decoder.decode(preprocessed.stderr),
      stages: { ivlpp: preprocessed },
      tree: treeToObject(root),
    };
  }

  writeFile(root, "/work/preprocessed.v", preprocessed.stdout);
  const compiled = runStage(
    modules.ivl,
    ["ivl", "-C", "work/ivl.conf", "work/preprocessed.v"],
    root,
    libraries,
    onPollOneoff,
  );
  if (compiled.status !== 0) {
    return {
      status: compiled.status,
      stdout: decoder.decode(compiled.stdout),
      stderr: decoder.decode(compiled.stderr),
      stages: { ivlpp: preprocessed, ivl: compiled },
      tree: treeToObject(root),
    };
  }

  const simulated = runStage(
    modules.vvp,
    ["vvp", "design.vvp"],
    root,
    libraries,
    onPollOneoff,
    true,
  );
  return {
    status: simulated.status,
    stdout: decoder.decode(simulated.stdout),
    stderr: [
      decoder.decode(preprocessed.stderr),
      decoder.decode(compiled.stderr),
      decoder.decode(simulated.stderr),
    ].filter(Boolean).join("\n"),
    stages: { ivlpp: preprocessed, ivl: compiled, vvp: simulated },
    tree: treeToObject(root),
  };
}
