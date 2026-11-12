import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createFakeUsb } from "./fake-webusb.mjs";

const [variant, idcodeHex, argsJson, connectedText] = process.argv.slice(2);
const idcode = Number.parseInt(idcodeHex, 16);
const args = JSON.parse(argsJson);
const { usb } = createFakeUsb(idcode, { connected: connectedText === "true" });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: { usb },
});

try {
  const started = performance.now();
  const buildRoot = resolve(process.env.WASM_BUILD_ROOT ?? "build");
  const modulePath = resolve(buildRoot, variant, "openFPGALoader.mjs");
  const { default: instantiate } = await import(pathToFileURL(modulePath));
  const module = await instantiate();
  const callMainResult = module.callMain(args);
  const isPromise = callMainResult instanceof Promise;
  let exitCode;
  try {
    exitCode = await callMainResult;
    if (typeof exitCode !== "number") exitCode = 0;
  } catch (error) {
    if (typeof error?.status === "number") {
      exitCode = error.status;
    } else {
      throw error;
    }
  }
  process.stderr.write(
    `\n__DETECT_RESULT__${JSON.stringify({
      exitCode,
      isPromise,
      elapsedMs: performance.now() - started,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `\n__DETECT_ERROR__${JSON.stringify({
      message: String(error),
      stack: error?.stack,
    })}\n`,
  );
  process.exitCode = 1;
}
