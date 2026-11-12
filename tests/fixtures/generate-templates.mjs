import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBlinkTemplate } from "../../web/lib/templates.mjs";

const outputRoot = resolve(process.argv[2]);
for (const boardId of ["tangnano1k", "tangnano4k", "tangnano9k", "tangnano20k"]) {
  const { files } = createBlinkTemplate(boardId, "verilog");
  for (const [path, content] of files) {
    if (!path.endsWith(".v") && !path.endsWith(".cst")) continue;
    const target = resolve(outputRoot, boardId, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
}
