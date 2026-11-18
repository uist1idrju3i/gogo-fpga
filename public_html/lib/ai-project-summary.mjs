import { getBoard } from "./boards.mjs";

export function summarizeProject(project) {
  if (!project) return null;
  const board = getBoard(project.board);
  const files = [...(project.files ?? [])].map(([path, content]) => ({ path,
    bytes: typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength }));
  const languages = [];
  if (files.some(({ path }) => /\.(v|vh)$/i.test(path))) languages.push("Verilog");
  if (files.some(({ path }) => /\.vhdl?$/i.test(path))) languages.push("VHDL");
  return { name: project.name, board: board ? { id: board.id, label: board.label, device: board.nextpnrDevice } : null,
    top: project.top, languages, files,
    ...(project.simulation ? { simulation: { top: project.simulation.top } } : {}),
    ...(project.formal ? { formal: { top: project.formal.top, mode: project.formal.mode } } : {}) };
}
