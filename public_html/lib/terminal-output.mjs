export function writeTerminalText(state, chunk) {
  const lines = String(state.text).split("\n");
  let line = lines.pop() ?? "";

  for (const character of String(chunk)) {
    if (character === "\r") {
      line = "";
    } else if (character === "\n") {
      lines.push(line);
      line = "";
    } else {
      line += character;
    }
  }

  lines.push(line);
  return { text: lines.join("\n") };
}
