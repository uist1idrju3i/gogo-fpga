import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { BOARDS } from "../../web/lib/boards.mjs";
import { createBlinkTemplate } from "../../web/lib/templates.mjs";
import { fsIdcode, fsIdcodeMatchesBoard } from "../../web/lib/fs-idcode.mjs";
import {
  createWorkdir,
  pnrArgs,
  runNative,
  runWasi,
  runYosysWasi,
  root,
} from "../synth/nextpnr-helpers.mjs";

const ghdlBuildRoot = path.resolve(root, process.env.GHDL_WASM_BUILD_ROOT ?? "build");
const nativeGhdl = path.join(ghdlBuildRoot, "ghdl-native/bin/ghdl");
const nativeYosys = path.join(root, "build/native/yosys");
const packer = path.join(root, "build/deps/apycula-venv/bin/gowin_pack");

export default async function globalSetup() {
  const outputDirectory = path.join(root, "build/e2e-expected");
  mkdirSync(outputDirectory, { recursive: true });
  for (const board of BOARDS) {
    const workdir = createWorkdir(`s4-e2e-${board.id}-`);
    try {
      const template = createBlinkTemplate(board.id, "verilog");
      runYosysWasi(workdir, template.files.get("src/top.v"));
      writeFileSync(
        path.join(workdir, `constraints/board.cst`),
        template.files.get(`constraints/${board.id}.cst`),
      );
      const pnr = runWasi(workdir, pnrArgs(board));
      assert.equal(pnr.status, 0, `WASI nextpnr failed for ${board.id}:\n${pnr.stderr}`);
      const routed = readFileSync(path.join(workdir, "pnr.json"));
      writeFileSync(path.join(workdir, "top.json"), routed);
      const destination = path.join(outputDirectory, `${board.id}.fs`);
      const packed = spawnSync(
        packer,
        ["-d", board.packDevice, "-o", destination, "top.json"],
        { cwd: workdir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      assert.equal(
        packed.status,
        0,
        `Native gowin_pack failed for ${board.id}:\n${packed.stderr ?? ""}`,
      );
      const fsText = readFileSync(destination, "utf8");
      const idcode = fsIdcode(fsText);
      assert.ok(fsIdcodeMatchesBoard(idcode, board), `Expected IDCODE mismatch for ${board.id}`);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  const nativeVhdlCases = [
    {
      name: "mixed-verilog-top",
      board: BOARDS[0],
      files: {
        "src/top.v": readFileSync(
          path.join(root, "tests/fixtures/vhdl/mixed-verilog-top.v"),
          "utf8",
        ),
        "src/child.vhd": readFileSync(
          path.join(root, "tests/fixtures/vhdl/mixed-vhdl-child.vhd"),
          "utf8",
        ),
      },
      top: "top",
      vhdlTop: "child",
    },
    {
      name: "mixed-vhdl-top",
      board: BOARDS[0],
      files: {
        "src/top.vhd": readFileSync(
          path.join(root, "tests/fixtures/vhdl/mixed-vhdl-top.vhd"),
          "utf8",
        ),
        "src/child.v": readFileSync(
          path.join(root, "tests/fixtures/vhdl/mixed-verilog-child.v"),
          "utf8",
        ),
      },
      top: "top",
      vhdlTop: "top",
    },
  ];

  for (const board of BOARDS) {
    buildNativeFs(
      createBlinkTemplate(board.id, "vhdl"),
      `build/e2e-expected/${board.id}-vhdl.fs`,
      board,
      "top",
      "top",
    );
  }
  for (const testCase of nativeVhdlCases) {
    buildNativeFs(
      createBlinkTemplate(testCase.board.id, "vhdl"),
      `build/e2e-expected/${testCase.name}.fs`,
      testCase.board,
      testCase.top,
      testCase.vhdlTop,
      testCase.files,
    );
  }
}

function buildNativeFs(template, destination, board, top, vhdlTop, additions = {}) {
  const workdir = createWorkdir(`t3-2-native-${board.id}-`);
  try {
    for (const [name, content] of template.files) {
      if (name.endsWith(".cst")) {
        writeFileSync(path.join(workdir, "constraints/board.cst"), content);
      } else {
        writeFileSync(path.join(workdir, name), content);
      }
    }
    for (const [name, content] of Object.entries(additions)) {
      writeFileSync(path.join(workdir, name), content);
    }

    const vhdlFiles = [...new Set([...template.files.keys(), ...Object.keys(additions)])]
      .filter((name) => /\.(?:vhd|vhdl)$/i.test(name));
    const vhdlPaths = vhdlFiles.map((name) => path.relative(workdir, path.join(workdir, name)));
    const analysis = spawnSync(
      nativeGhdl,
      ["-a", "--std=08", ...vhdlPaths],
      { cwd: workdir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const analysisFailure = [
      analysis.error?.message,
      analysis.signal ? `signal: ${analysis.signal}` : "",
      analysis.stderr,
    ].filter(Boolean).join("\n");
    assert.equal(
      analysis.status,
      0,
      `Native GHDL analysis failed for ${destination}:\n${analysisFailure}`,
    );
    const synthesis = spawnSync(
      nativeGhdl,
      ["--synth", "--std=08", "--out=verilog", vhdlTop],
      { cwd: workdir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(
      synthesis.status,
      0,
      `Native GHDL synthesis failed for ${destination}:\n${synthesis.stderr ?? ""}`,
    );

    mkdirSync(path.join(workdir, "build"), { recursive: true });
    const generatedPath = `build/vhdl-${vhdlTop}.v`;
    writeFileSync(path.join(workdir, generatedPath), synthesis.stdout ?? "");
    const verilogPaths = [
      generatedPath,
      ...Object.keys(additions).filter((name) => /\.(?:v|sv)$/i.test(name)),
    ];
    const yosys = spawnSync(
      nativeYosys,
      [
        "-q",
        "-p",
        `read_verilog ${verilogPaths.map((name) => JSON.stringify(name)).join(" ")}; ` +
          `synth_gowin -top ${top} -json top.json`,
      ],
      {
        cwd: workdir,
        encoding: "utf8",
        env: { ...process.env, YOSYS_DATDIR: path.join(root, "build/native/share") },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const yosysFailure = [
      yosys.error?.message,
      yosys.signal ? `signal: ${yosys.signal}` : "",
      yosys.stderr,
    ].filter(Boolean).join("\n");
    assert.equal(
      yosys.status,
      0,
      `Native Yosys synthesis failed for ${destination}:\n${yosysFailure}`,
    );

    const pnr = runNative(workdir, pnrArgs(board));
    const pnrFailure = [
      pnr.error?.message,
      pnr.stderr,
    ].filter(Boolean).join("\n");
    assert.equal(
      pnr.status,
      0,
      `Native nextpnr failed for ${destination}:\n${pnrFailure}`,
    );
    writeFileSync(
      path.join(workdir, "top.json"),
      readFileSync(path.join(workdir, "pnr.json")),
    );
    const packed = spawnSync(
      packer,
      ["-d", board.packDevice, "-o", path.join(root, destination), "top.json"],
      { cwd: workdir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(
      packed.status,
      0,
      `Native gowin_pack failed for ${destination}:\n${packed.stderr ?? ""}`,
    );
    const fsText = readFileSync(path.join(root, destination), "utf8");
    assert.ok(
      fsIdcodeMatchesBoard(fsIdcode(fsText), board),
      `Expected IDCODE mismatch for ${destination}`,
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
