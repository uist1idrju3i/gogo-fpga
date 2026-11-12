self.addEventListener("message", async ({ data }) => {
  const sendLog = (stream) => (text) => {
    self.postMessage({ type: "log", stream, text: String(text) });
  };
  const stdout = sendLog("stdout");
  const stderr = sendLog("stderr");
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = (...args) => stdout(args.map(String).join(" "));
  console.error = (...args) => stderr(args.map(String).join(" "));

  try {
    const { default: instantiate } = await import("./openFPGALoader.mjs");
    const module = await instantiate({
      print: stdout,
      printErr: stderr,
    });
    for (const file of data.files ?? []) {
      module.FS.writeFile(file.path, new Uint8Array(file.bytes));
    }

    let exitCode = 0;
    try {
      const result = await module.callMain(data.args);
      if (typeof result === "number") {
        exitCode = result;
      }
    } catch (error) {
      if (typeof error?.status === "number") {
        exitCode = error.status;
      } else {
        throw error;
      }
    }

    const outputs = (data.outputs ?? []).map((path) => ({
      path,
      bytes: module.FS.readFile(path),
    }));
    self.postMessage({ type: "done", exitCode, outputs });
  } catch (error) {
    self.postMessage({
      type: "error",
      exitCode: 1,
      message: `${error}\n${error?.stack ?? ""}`,
    });
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
});
