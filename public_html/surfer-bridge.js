import { waves_loaded } from "./surfer/surfer.js";

let watching = false;

window.addEventListener("message", ({ data, origin }) => {
  if (origin !== location.origin || data?.command !== "LoadUrl" || watching) return;
  watching = true;
  void (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await waves_loaded()) {
        window.parent.postMessage(
          { type: "toolchain:surfer-waveform-loaded" },
          location.origin,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    window.parent.postMessage(
      { type: "toolchain:surfer-waveform-timeout" },
      location.origin,
    );
  })().finally(() => {
    watching = false;
  });
});

window.parent.postMessage(
  { type: "toolchain:surfer-bridge-ready" },
  location.origin,
);
