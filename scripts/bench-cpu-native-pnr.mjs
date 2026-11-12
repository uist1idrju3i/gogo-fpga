import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CPU_CASES } from "../tests/fixtures/cpus/cases.mjs";
import { cpuBench } from "../tests/fixtures/cpus/bench.mjs";
import { BOARDS, gowinSynthesisCommand } from "../web/lib/boards.mjs";
import { prepareLibrarySelection, verilogReadCommand } from "../web/lib/libraries.mjs";
import { changeProjectLibraries, prepareProjectInputs } from "../web/lib/project.mjs";
import { exportProjectZip, importProjectZip } from "../web/lib/project-zip.mjs";
import { createBlinkTemplate, generateCst } from "../web/lib/templates.mjs";
import { pnrArgs, root, runNative, runYosysWasi } from "../tests/synth/nextpnr-helpers.mjs";

const { values } = parseArgs({ options: {
  cpu: { type: "string" }, board: { type: "string" }, output: { type: "string" },
  repeats: { type: "string", default: "5" },
} });
const sample = CPU_CASES.find(({ id }) => id === values.cpu);
const board = BOARDS.find(({ id }) => id === values.board);
const repeats = Number(values.repeats);
assert.ok(sample && sample.language === "verilog" && !sample.frontendFailure, "Choose a supported Verilog CPU");
assert.ok(board && values.output, "Specify --board and a new --output directory");
assert.ok(Number.isSafeInteger(repeats) && repeats > 0, "--repeats must be a positive integer");
const directory = path.resolve(root, values.output);
mkdirSync(directory);
const assets = path.join(directory, "assets");
execFileSync("python3", ["scripts/build-library-assets.py", "--output", assets], { cwd: root });
const catalog = JSON.parse(readFileSync(path.join(assets, "catalog.json"), "utf8"));
const added = await prepareLibrarySelection(catalog, { id: sample.id, component: sample.component },
  (asset) => readFileSync(path.join(assets, asset.asset)), { board: board.id });
const template = createBlinkTemplate(board.id, "verilog");
const fixtureDirectory = path.join(root, "tests/fixtures/cpus");
template.files.set("src/top.v", readFileSync(path.join(fixtureDirectory, sample.fixture)));
template.files.set("src/top_tb.v", cpuBench());
template.project.simulation.top = "tb";
template.project.simulation.files = null;
for (const name of ["memory.v", "bus.vh", "program.hex"]) {
  template.files.set(`src/${name}`, readFileSync(path.join(fixtureDirectory, name)));
}
template.project.files = [...template.files.keys()].map((path) => ({ path }));
const installed = await changeProjectLibraries(template.project, template.files, { add: added });
const restored = await importProjectZip(await exportProjectZip(installed.project, installed.files));
const input = await prepareProjectInputs(restored.project, restored.files);
for (const file of input.files) {
  const target = path.join(directory, file.path);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, file.content);
}
mkdirSync(path.join(directory, "tmp"));
const sources = input.files.filter((file) => file.role !== "data" && /\.v$/i.test(file.path));
const command = verilogReadCommand(sources.map((file) => file.path), input);
runYosysWasi(directory, sources.find((file) => file.path === "src/top.v").content,
  `${command}; ${gowinSynthesisCommand(board.id, "top", "top.json")}`);
writeFileSync(path.join(directory, "constraints/board.cst"), generateCst(board.id));
const hash = (file) => createHash("sha256").update(readFileSync(path.join(directory, file))).digest("hex");
const rows = ["cpu,board,repeat,native_ms,status,input_sha256,output_sha256"];
let expected;
for (let repeat = 1; repeat <= repeats; repeat += 1) {
  const args = pnrArgs(board);
  args[args.indexOf("--write") + 1] = "native-pnr.json";
  const result = runNative(directory, args);
  writeFileSync(path.join(directory, `native-${repeat}.stderr`), result.stderr);
  assert.equal(result.status, 0, `${result.stderr}\n${result.error ?? ""}`);
  const output = hash("native-pnr.json");
  expected ??= output;
  assert.equal(output, expected, "Repeated native PNR output differs");
  const row = [sample.id, board.id, repeat, result.elapsed.toFixed(3), result.status, hash("top.json"), output].join(",");
  rows.push(row);
  console.log(row);
  writeFileSync(path.join(directory, "results.csv"), `${rows.join("\n")}\n`);
}
