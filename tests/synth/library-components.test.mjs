import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { HDL_LIBRARY_CASES } from "../fixtures/libraries/cases.mjs";
import { libraryBench } from "../fixtures/libraries/bench.mjs";
import { runGhdlSynth } from "../../web/lib/ghdl-host.mjs";
import { runIverilog } from "../../web/lib/iverilog-host.mjs";
import { prepareLibrarySelection } from "../../web/lib/libraries.mjs";
import { changeProjectLibraries, prepareProjectInputs } from "../../web/lib/project.mjs";
import { exportProjectZip, importProjectZip } from "../../web/lib/project-zip.mjs";
import { createBlinkTemplate } from "../../web/lib/templates.mjs";
import { orderVhdlFiles } from "../../web/lib/vhdl-order.mjs";
import { nativeSimulation } from "./iverilog-helpers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const ghdlRoot = path.resolve(root, process.env.GHDL_WASM_BUILD_ROOT ?? "build");
const wasmDir = path.resolve(root, process.env.IVERILOG_WASM_DIR ?? "build/iverilog-wasm/output");
const modules = Object.fromEntries(["ivlpp", "ivl", "vvp"].map((name) =>
  [name, new WebAssembly.Module(readFileSync(path.join(wasmDir, `${name}.wasm`)))]));
const ghdlModule = new WebAssembly.Module(readFileSync(path.join(ghdlRoot, "ghdl-wasm/ghdl-synth.wasm")));

function tree(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const name = path.join(directory, entry.name);
    return [entry.name, entry.isDirectory() ? tree(name) : new Uint8Array(readFileSync(name))];
  }));
}
const librariesTree = tree(path.join(ghdlRoot, "ghdl-native/lib/ghdl"));


test("eight pinned HDL representatives execute independent scoreboards after portable ZIP import", async (t) => {
  const directory = mkdtempSync(path.join(root, "build/t5-library-simulation-"));
  const assets = path.join(directory, "assets");
  let passed = 0;
  try {
    const built = spawnSync("python3", ["scripts/build-library-assets.py", "--output", assets], { cwd: root, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const catalog = JSON.parse(readFileSync(path.join(assets, "catalog.json"), "utf8"));
    for (const { id, component, language, fixture } of HDL_LIBRARY_CASES) {
      await t.test(id, async () => {
        const added = await prepareLibrarySelection(catalog, { id, component },
          (asset) => readFileSync(path.join(assets, asset.asset)), { board: "tangnano20k" });
        const template = createBlinkTemplate("tangnano20k", language);
        template.files.set(language === "vhdl" ? "src/top.vhd" : "src/top.v", readFileSync(path.join(root, "tests/fixtures/libraries", fixture)));
        const installed = await changeProjectLibraries(template.project, template.files, { add: added });
        const zip = await exportProjectZip(installed.project, installed.files);
        writeFileSync(path.join(directory, `${id}.zip`), zip);
        const restored = await importProjectZip(zip);
        const input = await prepareProjectInputs(restored.project, restored.files);
        let sources = input.files.filter((file) => file.role === "data" || /\.vh?$/i.test(file.path));
        if (language === "vhdl") {
          const ordered = orderVhdlFiles(input.files.filter((file) => file.role !== "data" && /\.(vhd|vhdl)$/i.test(file.path)));
          assert.equal(ordered.ok, true, JSON.stringify(ordered));
          const generated = runGhdlSynth({ module: ghdlModule, librariesTree, files: ordered.order, top: "top", standard: "2008" });
          assert.equal(generated.status, 0, generated.log);
          sources = [...sources, { path: "src/top.v", content: generated.verilog }];
        }
        for (const broken of [false, true]) {
          const files = [...sources, { path: "src/tb.v", content: libraryBench(id, broken) }];
          const workdir = path.join(directory, id, broken ? "negative" : "positive");
          mkdirSync(workdir, { recursive: true });
          const native = nativeSimulation(workdir, files, input);
          const wasm = runIverilog({ modules, files, top: "tb", includeDirs: input.includeDirectories, defines: input.defines });
          writeFileSync(path.join(workdir, "results.json"), JSON.stringify({
            native: { status: native.status, stdout: native.stdout, stderr: native.stderr },
            wasm: { status: wasm.status, stdout: wasm.stdout, stderr: wasm.stderr },
          }, null, 2));
          if (wasm.tree?.work?.["wave.vcd"]) writeFileSync(path.join(workdir, "wasm.vcd"), wasm.tree.work["wave.vcd"]);
          assert.equal(native.status, broken ? 1 : 0, `${native.stdout}\n${native.stderr}`);
          assert.equal(wasm.status, native.status, `${wasm.stdout}\n${wasm.stderr}`);
          assert.equal(wasm.stdout, native.stdout);
          assert.match(wasm.stdout, broken ? /LIBRARY_MISMATCH/ : /LIBRARY_FUNCTION_OK/);
          assert.ok(native.vcd, "Native Icarus produced no VCD");
          assert.deepEqual(Buffer.from(wasm.tree.work["wave.vcd"]), native.vcd);
        }
        const corrupt = new Map(restored.files);
        const source = [...corrupt.keys()].find((name) => name.startsWith(`libraries/${id}/sources/`) && /\.(?:v|vhd|vhdl)$/i.test(name));
        assert.ok(source);
        corrupt.set(source, `${new TextDecoder().decode(corrupt.get(source))}\n`);
        await assert.rejects(exportProjectZip(restored.project, corrupt), /ハッシュ/);
        passed += 1;
      });
    }
  } finally {
    if (passed === HDL_LIBRARY_CASES.length) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained failing HDL functional evidence: ${directory}`);
  }
});
