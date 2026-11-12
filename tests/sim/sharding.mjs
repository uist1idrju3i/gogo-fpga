import { test as nodeTest } from "node:test";
import { readFileSync } from "node:fs";

const testShards = JSON.parse(
  readFileSync(new URL("./shards.json", import.meta.url), "utf8"),
);
const shardSetting = process.env.SIM_SHARD;

function parseShard(value) {
  if (!value) return null;
  const match = /^([1-3])\/3$/.exec(value);
  if (!match) throw new Error(`Invalid SIM_SHARD value: ${value}`);
  return Number(match[1]);
}

const currentShard = parseShard(shardSetting);

export function test(name, ...args) {
  if (currentShard === null) return nodeTest(name, ...args);
  if (!Object.hasOwn(testShards, name)) {
    throw new Error(`SIM_SHARD test is missing from shards.json: ${name}`);
  }
  if (testShards[name] === currentShard) return nodeTest(name, ...args);
  return nodeTest.skip(name, ...args);
}
