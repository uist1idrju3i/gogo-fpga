import { attachBytePipe } from "./byte-pipe.mjs";
import { createMemoryTree, runWasiP1 } from "./wasi-p1.mjs";

export async function runSolverJob({ jobId, wasm, sha256, args, channels }) {
  let input;
  let output;
  let errorOutput;
  let status = "setup-error";
  let verified = false;
  try {
    input = attachBytePipe(channels.stdin, "reader");
    output = attachBytePipe(channels.stdout, "writer");
    errorOutput = attachBytePipe(channels.stderr, "writer");
    status = "integrity-error";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", wasm));
    const actual = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== sha256) throw new Error("Solver binary SHA-256 mismatch");
    verified = true;
    status = "invalid-wasm";
    const module = new WebAssembly.Module(wasm);
    status = "runtime-error";
    const temporary = createMemoryTree({});
    const result = runWasiP1(module, {
      args, env: { TMPDIR: "/tmp" }, preopens: { "/tmp": temporary },
      stdin: size => input.readSync(size),
      stdout: bytes => output.writeSync(bytes),
      stderr: bytes => errorOutput.writeSync(bytes),
    });
    return { type: "exit", jobId, sha256: actual, result };
  } catch (error) {
    return { type: "failure", jobId, status, sha256: verified ? sha256 : null, error: String(error.message).slice(0, 1024) };
  } finally {
    try { input?.close(); } catch { /* The host may have already cancelled. */ }
    for (const endpoint of [output, errorOutput]) {
      try { endpoint?.end(); } catch { /* The host may have already cancelled. */ }
    }
  }
}
