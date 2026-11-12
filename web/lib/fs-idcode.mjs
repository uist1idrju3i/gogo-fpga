export const FS_IDCODE_MASK = 0x0fffffff;

export function fsIdcode(text) {
  if (typeof text !== "string") {
    return null;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length === 0) {
      break;
    }
    if (rawLine.startsWith("/") || !/^[01]+$/.test(rawLine)) {
      continue;
    }
    if (rawLine.length < 8) {
      return null;
    }

    const key = Number.parseInt(rawLine.slice(0, 8), 2) & 0x7f;
    if (key === 0x3b) {
      break;
    }
    if (key !== 0x06) {
      continue;
    }
    if (rawLine.length !== 64) {
      return null;
    }

    // Mirrors FsParser::parseHeader(): key 0x06, 64-bit record, low 32-bit value.
    return Number(BigInt(`0b${rawLine}`) & 0xffffffffn) >>> 0;
  }

  return null;
}

export function fsIdcodeMatchesBoard(idcode, board) {
  if (!Number.isInteger(idcode) || !Number.isInteger(board?.idcode)) {
    return false;
  }
  // Gowin::Gowin compares the parsed IDCODE after applying this mask.
  return (idcode & FS_IDCODE_MASK) === board.idcode;
}
