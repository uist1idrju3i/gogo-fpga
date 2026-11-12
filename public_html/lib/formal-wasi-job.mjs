import { attachBytePipe } from "./byte-pipe.mjs";
import { packWorkspaceDelta } from "./formal-workspace.mjs";
import { readUstar } from "./ustar.mjs";
import { safePath } from "./verified-assets.mjs";
import { validateFormalToolCommand } from "./formal-tool-command.mjs";
import { createMemoryTree, runWasiP1, setTreeEntry } from "./wasi-p1.mjs";

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
}

function workspace(files) {
  if (!Array.isArray(files) || files.length > 4096) throw new Error("Invalid child workspace");
  const tree = { tmp: {} };
  const paths = new Set();
  let total = 0;
  for (const file of files) {
    if (!safePath(file?.path) || file.path.includes("\0") || file.path.length > 512 ||
        paths.has(file.path) || !(file.bytes instanceof Uint8Array) || file.path === "tmp") {
      throw new Error("Invalid child workspace file");
    }
    paths.add(file.path);
    total += file.bytes.length;
    if (total > 32 * 1024 * 1024) throw new Error("Child workspace size limit");
    const parts = file.path.split("/");
    let directory = tree;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(directory, part)) setTreeEntry(directory, part, {});
      const child = directory[part];
      if (!child || typeof child !== "object" || child instanceof Uint8Array) throw new Error("Conflicting workspace path");
      directory = child;
    }
    const name = parts.at(-1);
    if (Object.hasOwn(directory, name)) throw new Error("Conflicting workspace path");
    setTreeEntry(directory, name, new Uint8Array(file.bytes));
  }
  return createMemoryTree(tree);
}

function collect(directory, prefix = "", result = []) {
  for (const [name, entry] of [...directory.entries].sort(([a], [b]) => a < b ? -1 : 1)) {
    const path = prefix + name;
    if (entry.type === "directory") collect(entry, path + "/", result);
    else result.push({ path, bytes: new Uint8Array(entry.data) });
    if (result.length > 4096) throw new Error("Child workspace output count limit");
  }
  return result;
}

export async function runFormalWasiJob({ jobId, wasm, sha256: binaryHash, share, shareSha256,
  args, cwd, files, channels }) {
  let output;
  let errorOutput;
  let status = "setup-error";
  try {
    output = attachBytePipe(channels.stdout, "writer");
    errorOutput = attachBytePipe(channels.stderr, "writer");
    if (!(wasm instanceof Uint8Array) || !(share instanceof Uint8Array) ||
        !/^[0-9a-f]{64}$/.test(binaryHash) || !/^[0-9a-f]{64}$/.test(shareSha256)) {
      throw new TypeError("Invalid formal WASI asset");
    }
    status = "integrity-error";
    if (await sha256(wasm) !== binaryHash || await sha256(share) !== shareSha256) {
      throw new Error("Formal WASI asset hash mismatch");
    }
    status = "setup-error";
    if (validateFormalToolCommand(args, cwd).runtime !== "wasi") {
      throw new Error("Unsupported formal WASI command");
    }
    const work = workspace(files);
    let directory = work;
    for (const component of cwd.split("/")) {
      directory = directory.entries.get(component);
      if (directory?.type !== "directory") throw new Error("Missing formal WASI working directory");
    }
    const shared = createMemoryTree(readUstar(share));
    status = "invalid-wasm";
    const module = new WebAssembly.Module(wasm);
    status = "runtime-error";
    const result = runWasiP1(module, {
      args, env: { TMPDIR: "/tmp" },
      preopens: { "/": work, "/share": shared, "/tmp": work.entries.get("tmp") },
      workingDirectory: directory,
      stdout: bytes => output.writeSync(bytes), stderr: bytes => errorOutput.writeSync(bytes),
    });
    const frame = await packWorkspaceDelta(files, collect(work));
    return { type: "exit", jobId, sha256: binaryHash, shareSha256,
      result, frame, integrityVerified: true };
  } catch (error) {
    return { type: "failure", jobId, status, error: String(error.message).slice(0, 1024) };
  } finally {
    for (const endpoint of [output, errorOutput]) {
      try { endpoint?.end(); } catch { /* The host may already have cancelled. */ }
    }
  }
}
