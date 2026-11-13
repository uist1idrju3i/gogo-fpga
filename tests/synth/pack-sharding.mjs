import { test as nodeTest } from "node:test";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { containers, leaves, matrixAssignment, parsePackShard, root } from "../../scripts/ci-shard-plan.mjs";

export function createPackTest(url) {
  if (!process.env.PACK_SHARD) return nodeTest;
  const shard = parsePackShard(process.env.PACK_SHARD);
  if (!process.env.CI_SHARD_REPORT_DIR) throw new Error("Missing shard report directory");
  const file = path.relative(root, fileURLToPath(url));
  return (name, ...args) => {
    const entries = leaves(file, name);
    appendFileSync(path.join(process.env.CI_SHARD_REPORT_DIR, `${path.basename(file)}.jsonl`),
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const selected = name === containers[0] ? shard.startsWith("hdl-")
      : name === containers[1] ? shard.startsWith("cpu-") : entries.some((entry) => entry.shard === shard);
    return selected ? nodeTest(name, ...args) : nodeTest.skip(name, ...args);
  };
}

export function includeMatrixCase(cpu, id, board) {
  if (!process.env.PACK_SHARD) return true;
  for (const name of ["CPU_MATRIX_IDS", "CPU_MATRIX_PREFLIGHT", "CPU_LIBRARY_ASSETS"]) {
    if (process.env[name] !== undefined) throw new Error(`Research selector is forbidden in CI shards: ${name}`);
  }
  return matrixAssignment(cpu, id, board) === parsePackShard(process.env.PACK_SHARD);
}
