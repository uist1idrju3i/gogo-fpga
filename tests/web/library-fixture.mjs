import { libraryHash, prepareLibrarySelection } from "../../web/lib/libraries.mjs";
import { createBlinkTemplate } from "../../web/lib/templates.mjs";

export async function createLibraryFixture() {
  const contents = new Map();
  async function asset(id, path, content, extra = {}) {
    const data = new TextEncoder().encode(content);
    contents.set(`${id}/${path}`, data);
    return { path, asset: `${id}/${path}`, size: data.length, sha256: await libraryHash(data), ...extra };
  }
  const entries = [];
  for (const id of ["primary", "dependency"]) {
    entries.push({
      id, label: id, kind: "library", language: "verilog", submodule: `third_party/${id}`,
      status: "available", deprecated: false, reason: "",
      source: { url: `https://example.test/${id}.git`, revision: (id === "primary" ? "1" : "2").repeat(40) },
      license: { expression: "MIT", files: [await asset(id, "LICENSE", `${id} license\n`)] },
      components: [{
        id: "rtl", label: "RTL", sources: [await asset(id, "rtl/unit.v", `module ${id}; endmodule\n`, { language: "verilog" })],
        data: [], dependencies: id === "primary" ? ["dependency/rtl"] : [],
        includeDirectories: ["rtl"], defines: {},
        boards: Object.fromEntries(["1k", "4k", "9k", "20k"].map((size) => [`tangnano${size}`, "confirmed"])),
      }],
    });
  }
  const catalog = { formatVersion: 1, entries };
  const selection = { id: "primary", component: "rtl" };
  const prepare = () => prepareLibrarySelection(catalog, selection, async ({ asset }) => contents.get(asset), { board: "tangnano1k" });
  return { catalog, contents, selection, prepare };
}

export async function createLibraryProject() {
  const fixture = await createLibraryFixture();
  const installed = await fixture.prepare();
  const initial = createBlinkTemplate("tangnano1k", "verilog");
  initial.project.libraries.push(installed.selection);
  for (const [path, content] of installed.files) {
    initial.project.files.push({ path });
    initial.files.set(path, content);
  }
  return { ...initial, ...fixture };
}
