import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [variant] = process.argv.slice(2);
const buildRoot = resolve(process.env.WASM_BUILD_ROOT ?? "build");
const modulePath = resolve(buildRoot, variant, "openFPGALoader.mjs");
const started = performance.now();
const { default: instantiate } = await import(pathToFileURL(modulePath));
await instantiate();
process.stdout.write(
  `__INSTANTIATE_RESULT__${JSON.stringify({ elapsedMs: performance.now() - started })}\n`,
);
