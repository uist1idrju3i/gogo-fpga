import { getBoard, gowinSynthesisCommand } from "./lib/boards.mjs";
import { releaseDecoders } from "./lib/decompress.mjs";
import { createVerifiedAssetLoader, safePath } from "./lib/verified-assets.mjs";
import { createMemoryTree, runWasiP1, setTreeEntry } from "./lib/wasi-p1.mjs";
import { readUstar } from "./lib/ustar.mjs";
import { runGhdlSynth } from "./lib/ghdl-host.mjs";
import { analyzeVhdlDesign, getVhdlLibrary, orderVhdlFiles } from "./lib/vhdl-order.mjs";
import { validateCompileOptions, verilogReadCommand } from "./lib/libraries.mjs";

const synthURL = new URL("./synth/", import.meta.url);
const synthCacheName = "gogo-fpga-synth-v1";
const synthAssets = createVerifiedAssetLoader({
  baseURL: synthURL,
  cacheName: synthCacheName,
  label: "Synthesis asset",
});
const requiredAssetPaths = [
  "yosys.wasm",
  "nextpnr-himbaechel-gowin.wasm",
  "yosys-share.tar",
];

function insertFile(tree, path, content) {
  if (!safePath(path)) throw new Error(`Invalid project file path: ${path}`);
  const parts = path.split("/");
  let directory = tree;
  for (const part of parts.slice(0, -1)) {
    const current = Object.hasOwn(directory, part) ? directory[part] : undefined;
    if (current === undefined) setTreeEntry(directory, part, {});
    else if (
      current === null ||
      typeof current !== "object" ||
      current instanceof Uint8Array
    ) {
      throw new Error(`Conflicting project file path: ${path}`);
    }
    directory = directory[part];
  }
  const name = parts.at(-1);
  if (Object.hasOwn(directory, name)) throw new Error(`Duplicate project file path: ${path}`);
  if (typeof content === "string") setTreeEntry(directory, name, content);
  else if (content instanceof Uint8Array) setTreeEntry(directory, name, new Uint8Array(content));
  else if (content instanceof ArrayBuffer) setTreeEntry(directory, name, new Uint8Array(content));
  else throw new Error(`Invalid content for project file: ${path}`);
}

function readMemoryFile(directory, path) {
  let current = directory;
  const parts = path.split("/");
  for (const part of parts.slice(0, -1)) {
    const entry = current.entries.get(part);
    if (entry?.type !== "directory") return null;
    current = entry;
  }
  const file = current.entries.get(parts.at(-1));
  return file?.type === "file" ? new Uint8Array(file.data) : null;
}

function makeLogger(tool, stream) {
  const textDecoder = new TextDecoder();
  let captured = "";
  return {
    write(bytes) {
      const text = textDecoder.decode(bytes, { stream: true });
      if (text) {
        captured += text;
        self.postMessage({ type: "log", tool, stream, text });
      }
    },
    flush() {
      const text = textDecoder.decode();
      if (text) {
        captured += text;
        self.postMessage({ type: "log", tool, stream, text });
      }
    },
    get text() {
      return captured;
    },
  };
}

function checkedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("The project has no HDL source files");
  }
  const tree = { build: {}, tmp: {} };
  const sourcePaths = [];
  const vhdlFiles = [];
  const dataFiles = [];
  let constraintPath = null;
  for (const file of files) {
    if (!file || typeof file.path !== "string") {
      throw new Error("A project file has an invalid path");
    }
    insertFile(tree, file.path, file.content);
    if (file.role === "data") {
      dataFiles.push(file);
      continue;
    }
    if (/\.(?:v|sv)$/i.test(file.path) && !/(?:^|\/)top_tb\.v$/i.test(file.path)) {
      sourcePaths.push(file.path);
    }
    if (/\.(?:vhd|vhdl)$/i.test(file.path)) vhdlFiles.push(file);
    if (/\.cst$/i.test(file.path)) {
      if (constraintPath) throw new Error("The project has multiple constraint files");
      constraintPath = file.path;
    }
  }
  if (sourcePaths.length === 0 && vhdlFiles.length === 0) {
    throw new Error("The project has no HDL source files");
  }
  if (!constraintPath) throw new Error("The project has no generated constraint file");
  return { tree, sourcePaths, vhdlFiles, dataFiles, constraintPath };
}

function toolResult(module, args, workdir, share, tool) {
  const stdout = makeLogger(tool, "stdout");
  const stderr = makeLogger(tool, "stderr");
  let result;
  try {
    result = runWasiP1(module, {
      args,
      env: { TMPDIR: "/tmp" },
      preopens: {
        "/": workdir,
        "/share": share,
        "/tmp": workdir.entries.get("tmp"),
      },
      stdout: (bytes) => stdout.write(bytes),
      stderr: (bytes) => stderr.write(bytes),
    });
  } finally {
    stdout.flush();
    stderr.flush();
  }
  return { ...result, stdout: stdout.text, stderr: stderr.text };
}

let building = false;
self.addEventListener("message", async ({ data }) => {
  if (data?.type !== "build") {
    self.postMessage({
      type: "error",
      stage: "synth",
      message: "Unsupported build worker message",
    });
    return;
  }
  if (building) {
    self.postMessage({
      type: "error",
      stage: "synth",
      message: "A build is already running",
    });
    return;
  }

  building = true;
  let stage = "synth";
  try {
    const board = getBoard(data.board);
    if (!board) throw new Error(`Unknown board: ${data.board}`);
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(data.top ?? "")) {
      throw new Error("The top module name is invalid");
    }
    const { tree, sourcePaths, vhdlFiles, dataFiles, constraintPath } = checkedFiles(data.files);
    const compileOptions = validateCompileOptions(data);
    const hasVhdl = vhdlFiles.length > 0;
    let vhdlTime = 0;
    let vhdlStarted = 0;
    let ghdlMemoryBytes = 0;
    const generatedVhdlPaths = [];
    let orderedVhdlFiles = [];
    let vhdlTargets = [];
    if (hasVhdl) {
      stage = "vhdl";
      self.postMessage({ type: "stage", stage });
      vhdlStarted = performance.now();
      const ordering = orderVhdlFiles(vhdlFiles);
      if (!ordering.ok) {
        for (const error of ordering.errors) {
          self.postMessage({
            type: "log",
            tool: "ghdl",
            stream: "stderr",
            text: `${error.file}:${error.line}:1: error: ${error.message}\n`,
          });
        }
        throw new Error("VHDL source ordering failed");
      }
      orderedVhdlFiles = ordering.order;
      const units = analyzeVhdlDesign(orderedVhdlFiles);
      const entities = units.flatMap(({ file, declarations }) =>
        declarations
          .filter(({ kind }) => kind === "entity" && getVhdlLibrary(file) === "work")
          .map(({ name }) => ({ name, file: file.path }))
      );
      const instantiated = new Set(
        units.flatMap(({ file, references }) =>
          references
            .filter(({ usage, library }) => usage === "instantiation" &&
              ((!library || library === "work") ? getVhdlLibrary(file) : library) === "work")
            .map(({ name }) => name)
        ),
      );
      const topName = data.top.toLowerCase();
      if (entities.some(({ name }) => name === topName)) {
        vhdlTargets = [topName];
      } else if (sourcePaths.length > 0) {
        vhdlTargets = entities
          .map(({ name }) => name)
          .filter((name) => !instantiated.has(name));
        if (vhdlTargets.length === 0) {
          throw new Error("No root VHDL entity is available for mixed synthesis");
        }
      } else {
        throw new Error(`Top entity ${data.top} was not found in the VHDL sources`);
      }
    } else {
      self.postMessage({ type: "stage", stage });
    }
    const assets = await synthAssets.loadManifest();
    const chipdbPath = `chipdb/chipdb-${board.nextpnrFamily}.bin`;
    const requiredPaths = [
      ...requiredAssetPaths,
      ...(hasVhdl ? ["ghdl-synth.wasm", "libraries.tar"] : []),
      chipdbPath,
    ];
    for (const path of requiredPaths) {
      if (!assets.has(path)) {
        throw new Error(`Synthesis asset is missing from manifest: ${path}`);
      }
    }
    const cache = await synthAssets.openCache();
    let loadedAssetBytes;
    try {
      loadedAssetBytes = await Promise.all(
        requiredPaths.map((path) => synthAssets.fetchVerifiedAsset(assets, path, cache)),
      );
    } finally {
      releaseDecoders();
    }
    await synthAssets.pruneCache(cache, assets);
    const loadedAssets = new Map(
      requiredPaths.map((path, index) => [path, loadedAssetBytes[index]]),
    );
    const yosysBytes = loadedAssets.get("yosys.wasm");
    const nextpnrBytes = loadedAssets.get("nextpnr-himbaechel-gowin.wasm");
    const shareTar = loadedAssets.get("yosys-share.tar");
    const chipdbBytes = loadedAssets.get(chipdbPath);
    const [yosysModule, nextpnrModule] = await Promise.all([
      WebAssembly.compile(yosysBytes),
      WebAssembly.compile(nextpnrBytes),
    ]);
    if (hasVhdl) {
      const ghdlModule = await WebAssembly.compile(loadedAssets.get("ghdl-synth.wasm"));
      const librariesTree = readUstar(loadedAssets.get("libraries.tar"));
      for (const target of vhdlTargets) {
        const result = runGhdlSynth({
          module: ghdlModule,
          librariesTree,
          files: [...orderedVhdlFiles, ...dataFiles],
          top: target,
          standard: data.vhdlStandard ?? "2008",
        });
        if (result.status !== 0 && result.log) {
          self.postMessage({
            type: "log",
            tool: "ghdl",
            stream: result.status === 0 ? "stdout" : "stderr",
            text: result.log,
          });
        }
        ghdlMemoryBytes = Math.max(ghdlMemoryBytes, result.memoryBytes ?? 0);
        if (result.status !== 0) {
          const file = result.file ? ` (${result.file})` : "";
          const standardNote = data.vhdlStandard === "2019"
            ? "\nVHDL-2019 は GHDL 6.0 の初期サポートです。未対応の構文・合成機能が含まれる場合があります。"
            : "";
          throw new Error(
            `GHDL failed during ${result.stage}${file}\n${result.log}${standardNote}`,
          );
        }
        const generatedPath = `build/vhdl/${target}.v`;
        insertFile(tree, generatedPath, result.verilog);
        generatedVhdlPaths.push(generatedPath);
      }
      vhdlTime = performance.now() - vhdlStarted;
    }
    stage = "synth";
    self.postMessage({ type: "stage", stage });
    const yosysShareTree = readUstar(shareTar);
    const nextpnrShareTree = {};
    insertFile(
      nextpnrShareTree,
      `himbaechel/gowin/chipdb-${board.nextpnrFamily}.bin`,
      chipdbBytes,
    );
    const workdir = createMemoryTree(tree);
    const yosysShare = createMemoryTree(yosysShareTree);
    const nextpnrShare = createMemoryTree(nextpnrShareTree);

    const yosysReadCommands = [];
    if (sourcePaths.length) {
      yosysReadCommands.push(
        verilogReadCommand(sourcePaths, compileOptions),
      );
    }
    if (generatedVhdlPaths.length) {
      yosysReadCommands.push(
        `read_verilog -nooverwrite ${generatedVhdlPaths
          .map((path) => JSON.stringify(path))
          .join(" ")}`,
      );
    }
    const yosysCommand =
      `${yosysReadCommands.join("; ")}; ` +
      gowinSynthesisCommand(board.id, data.top, "build/top.json");
    const synthStarted = performance.now();
    const yosysResult = toolResult(
      yosysModule,
      ["yosys", "-q", "-p", yosysCommand],
      workdir,
      yosysShare,
      "yosys",
    );
    if (yosysResult.exitCode !== 0) {
      throw new Error(
        `Yosys exited with status ${yosysResult.exitCode}\n${yosysResult.stderr}${yosysResult.stdout}`,
      );
    }
    const topJson = readMemoryFile(workdir, "build/top.json");
    if (!topJson?.byteLength) throw new Error("Yosys did not create build/top.json");
    const synthTime = performance.now() - synthStarted;

    stage = "pnr";
    self.postMessage({ type: "stage", stage });
    const pnrArgs = [
      "--seed",
      "73421",
      "--device",
      board.nextpnrDevice,
      "--vopt",
      `family=${board.nextpnrFamily}`,
      "--vopt",
      `cst=${constraintPath}`,
      "--json",
      "build/top.json",
      "--write",
      "build/top_pnr.json",
    ];
    const pnrStarted = performance.now();
    const nextpnrResult = toolResult(
      nextpnrModule,
      ["nextpnr-himbaechel-gowin", ...pnrArgs],
      workdir,
      nextpnrShare,
      "nextpnr",
    );
    if (nextpnrResult.exitCode !== 0) {
      throw new Error(
        `nextpnr exited with status ${nextpnrResult.exitCode}\n${nextpnrResult.stderr}${nextpnrResult.stdout}`,
      );
    }
    const routedJson = readMemoryFile(workdir, "build/top_pnr.json");
    if (!routedJson?.byteLength) {
      throw new Error("nextpnr did not create build/top_pnr.json");
    }
    const pnrTime = performance.now() - pnrStarted;

    const files = [
      { path: "build/top.json", bytes: topJson },
      { path: "build/top_pnr.json", bytes: routedJson },
    ];
    self.postMessage(
      {
        type: "done",
        files,
        timings: {
          ...(hasVhdl ? { vhdl: vhdlTime } : {}),
          synth: synthTime,
          pnr: pnrTime,
        },
        memoryBytes: {
          ...(hasVhdl ? { ghdl: ghdlMemoryBytes } : {}),
          yosys: yosysResult.memoryBytes,
          nextpnr: nextpnrResult.memoryBytes,
        },
      },
      files.map(({ bytes }) => bytes.buffer),
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      stage,
      message: String(error?.message ?? error),
    });
  } finally {
    building = false;
  }
});
