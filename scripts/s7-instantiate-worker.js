self.addEventListener("message", async () => {
  try {
    const { default: instantiate } = await import("./openFPGALoader.mjs");
    await instantiate({
      noInitialRun: true,
      print: () => {},
      printErr: () => {},
    });
    self.postMessage({ status: "ready" });
  } catch (error) {
    self.postMessage({ status: "error", message: `${error}\n${error?.stack ?? ""}` });
  }
});
