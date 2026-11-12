export function normalizeSmtbmcTestbench(text) {
  return text.replace(/(?:^  (?:reg|wire) \[\d+:\d+\] PI_[A-Za-z0-9_$]+(?: = clock)?;\n)+/gm,
    block => block.trimEnd().split("\n").sort().join("\n") + "\n")
    .replace(/(  top UUT \(\n)((?:    \.[A-Za-z0-9_$]+\(PI_[A-Za-z0-9_$]+\),?\n)+)(  \);)/g,
      (block, start, ports, end) => {
        const lines = ports.trimEnd().split("\n").map(line => line.replace(/,$/, ""));
        if (lines.some(line => !/^    \.([A-Za-z_][A-Za-z0-9_$]*)\(PI_\1\)$/.test(line))) return block;
        return start + lines.sort().join(",\n") + "\n" + end;
      });
}
