import { createSimRunner } from "./sim-runner.mjs";

export function createFormalReplaySimulator({ runner = createSimRunner() } = {}) {
  const simulate = async ({ replay, sources, files, timeoutMs }) => {
    const selected = sources.map(path => {
      if (!files.has(path)) throw new Error(`Missing replay source: ${path}`);
      return { path, content: files.get(path) };
    });
    const execution = await runner.run({ files: [...selected, { path: replay.path, content: replay.content }],
      top: "__formal_replay", formal: true, timeLimitMs: timeoutMs, includeDirectories: [], defines: {} });
    return { status: execution.status, stdout: execution.stdout, stderr: execution.stderr,
      vcd: execution.vcds.find(file => file.name === "work/formal-replay.vcd")?.bytes ?? null };
  };
  simulate.cancel = () => runner.stop();
  simulate.dispose = () => runner.dispose();
  return simulate;
}
