import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const workerSource = readFileSync(resolve(repoRoot, "web/worker.js"), "utf8");
const fakeWebUsbSource = readFileSync(
  resolve(repoRoot, "tests/sim/fake-webusb.mjs"),
  "utf8",
);
const fsChecksumSource = readFileSync(
  resolve(repoRoot, "tests/sim/fs-checksum.mjs"),
  "utf8",
);
const isolatedResponseHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export async function stubPageUsb(
  page,
  unsupported = false,
  { captureFakeUsbState = false } = {},
) {
  await page.addInitScript(({ isUnsupported, captureFakeUsbState: captureState }) => {
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...transfer) {
      window.__workerMessages ??= [];
      window.__workerMessages.push({ args: message.args, outputs: message.outputs });
      return originalPostMessage.call(this, message, ...transfer);
    };
    if (captureState) {
      const NativeWorker = globalThis.Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", ({ data }) => {
            if (data?.__fakeUsbState) {
              globalThis.__s7FakeUsbState = data.__fakeUsbState;
            }
          });
        }
      };
    }
    Object.defineProperty(globalThis.navigator, "usb", {
      configurable: true,
      value: isUnsupported
        ? undefined
        : {
            async requestDevice(options) {
              window.__usbRequestCount = (window.__usbRequestCount ?? 0) + 1;
              window.__usbRequestOptions = options;
              return { productName: "Tang Nano (test fake)" };
          },
      },
    });
  }, { isUnsupported: unsupported, captureFakeUsbState });
}

export async function routeWorkerWithFakeUsb(
  page,
  {
    faults = {},
    idcode = 0x1100481b,
    onWorkerRequest = () => {},
    captureState = null,
  } = {},
) {
  await page.route("**/__e2e/fake-webusb.mjs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: isolatedResponseHeaders,
      body: fakeWebUsbSource,
    }),
  );
  await page.route("**/__e2e/fs-checksum.mjs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: isolatedResponseHeaders,
      body: fsChecksumSource,
    }),
  );
  await page.route("**/worker-real.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: isolatedResponseHeaders,
      body: workerSource,
    }),
  );
  await page.route("**/worker.js", async (route) => {
    onWorkerRequest();
    const serializedCaptureState = JSON.stringify(captureState);
    const wrapper = `
      import { createFakeUsb } from "/__e2e/fake-webusb.mjs";
      const fake = createFakeUsb(${idcode}, { faults: ${JSON.stringify(faults)} });
      const captureState = ${serializedCaptureState};
      const snapshotFakeUsb = (tap, limits) => {
        if (!limits) return null;
        const state = { sram: null, eflash: null, nor: null };
        if (limits.sramLength !== undefined) {
          state.sram = Uint8Array.from(tap.sram.slice(0, limits.sramLength));
        }
        if (limits.eflashLength !== undefined) {
          state.eflash = new Uint8Array(limits.eflashLength).fill(0xff);
          for (const [address, byte] of tap.eflash) {
            if (address < state.eflash.length) state.eflash[address] = byte;
          }
        }
        if (limits.norLength !== undefined && tap.nor) {
          state.nor = tap.nor.slice(0, limits.norLength);
        }
        return state;
      };
      const originalPostMessage = self.postMessage.bind(self);
      self.postMessage = (message, ...transfer) => {
        if (
          captureState
          && (message?.type === "done" || message?.type === "error")
        ) {
          const state = snapshotFakeUsb(fake.device.tap, captureState);
          const stateTransfer = Object.values(state)
            .filter(Boolean)
            .map((bytes) => bytes.buffer);
          const transferList =
            transfer.length === 1 && Array.isArray(transfer[0]) ? transfer[0] : transfer;
          return originalPostMessage(
            { ...message, __fakeUsbState: state },
            [...transferList, ...stateTransfer],
          );
        }
        return originalPostMessage(message, ...transfer);
      };
      const originalNavigator = globalThis.navigator;
      const fakeNavigator = Object.create(originalNavigator);
      Object.defineProperties(fakeNavigator, {
        userAgent: {
          configurable: true,
          value: originalNavigator.userAgent,
        },
        language: {
          configurable: true,
          value: originalNavigator.language,
        },
        usb: {
          configurable: true,
          value: fake.usb,
        },
      });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: fakeNavigator,
      });
      const originalAddEventListener = self.addEventListener.bind(self);
      const pendingMessages = [];
      let realMessageHandlerReady = false;
      originalAddEventListener("message", (event) => {
        if (!realMessageHandlerReady) {
          pendingMessages.push(event);
        }
      });
      self.addEventListener = (type, listener, options) => {
        if (type === "message") {
          realMessageHandlerReady = true;
          for (const event of pendingMessages.splice(0)) {
            queueMicrotask(() => listener.call(self, event));
          }
        }
        return originalAddEventListener(type, listener, options);
      };
      await import("/worker-real.js");
    `;
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: isolatedResponseHeaders,
      body: wrapper,
    });
  });
}
