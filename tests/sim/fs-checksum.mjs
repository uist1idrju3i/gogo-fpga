function bitValue(bits) {
  return BigInt(`0b${bits}`);
}

const lineCounts = new Map([
  [0x0900281b, 274],
  [0x0900381b, 274],
  [0x0100681b, 274],
  [0x0100181b, 494],
  [0x0120681b, 494],
  [0x0300081b, 494],
  [0x0300181b, 494],
  [0x0100981b, 494],
  [0x0100381b, 494],
  [0x1100381b, 494],
  [0x0100481b, 712],
  [0x1100481b, 712],
  [0x0100581b, 712],
  [0x1100581b, 712],
  [0x0000081b, 1342],
  [0x0000281b, 2038],
]);

const eflashConfigLineBytes = new Map([
  [0x0100681b, 160],
  [0x0100981b, 295],
  [0x1100481b, 363],
]);

const eflashHeaderLineBytes = new Map([
  [0x06, 8],
  [0x0a, 8],
  [0x0b, 4],
  [0x10, 8],
  [0x12, 4],
  [0x3b, 4],
  [0x51, 8],
  [0x52, 8],
]);

export function checksumGowinConfigPayload(payloadBytes) {
  if (payloadBytes.length % 2 !== 0) {
    throw new Error("Gowin configuration checksum data is truncated");
  }
  let checksum = 0;
  for (let offset = 0; offset < payloadBytes.length; offset += 2) {
    checksum = (checksum + (payloadBytes[offset] << 8) + payloadBytes[offset + 1])
      & 0xffff;
  }
  return checksum;
}

export function parseGowinFsChecksum(source) {
  const rows = source.split(/\r?\n/).filter((line) => line && !line.startsWith("/"));
  let idcode = 0;
  let compressed = false;
  let crcCheck = false;
  let configLength = 0;
  let headerEnd = -1;
  let zeroCodes = [0xff, 0xff, 0xff];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const key = Number.parseInt(row.slice(0, 8), 2) & 0x7f;
    const value = bitValue(row);
    if (key === 0x06) idcode = Number(value & 0xffffffffn);
    if (key === 0x10) compressed = Boolean((value >> 13n) & 1n);
    if (key === 0x51) {
      zeroCodes = [
        Number((value >> 16n) & 0xffn),
        Number((value >> 8n) & 0xffn),
        Number(value & 0xffn),
      ];
    }
    if (key === 0x3b) {
      crcCheck = Boolean((value >> 23n) & 1n);
      configLength = Number(value & 0xffffn);
      headerEnd = index;
      break;
    }
  }

  const lineCount = Math.min(lineCounts.get(idcode) ?? 0, configLength);
  const padding = [0x0100481b, 0x1100481b, 0x0100581b, 0x1100581b]
    .includes(idcode) ? 4 + (compressed ? 40 : 0) : 0;
  const drop = 48 + (crcCheck ? 16 : 0);
  const checksumBits = [];

  for (const row of rows.slice(headerEnd + 1, headerEnd + 1 + lineCount)) {
    let payload = row.slice(0, row.length - drop);
    if (compressed) {
      let expanded = "";
      for (let offset = 0; offset < payload.length; offset += 8) {
        const byte = Number.parseInt(payload.slice(offset, offset + 8), 2);
        const codeIndex = zeroCodes.indexOf(byte);
        expanded += codeIndex < 0 ? payload.slice(offset, offset + 8) : "0".repeat([64, 32, 16][codeIndex]);
      }
      payload = expanded;
    }
    checksumBits.push(payload.slice(padding));
  }
  const payloadBits = checksumBits.join("");
  if (payloadBits.length % 8 !== 0) {
    throw new Error("Gowin configuration checksum data is truncated");
  }
  const payloadBytes = new Uint8Array(payloadBits.length / 8);
  for (let offset = 0; offset < payloadBits.length; offset += 8) {
    payloadBytes[offset / 8] = Number.parseInt(payloadBits.slice(offset, offset + 8), 2);
  }
  return checksumGowinConfigPayload(payloadBytes);
}

export function checksumGowinEflash(eflash) {
  let eflashLength = 0;
  for (const address of eflash.keys()) {
    if (address >= eflashLength) eflashLength = address + 1;
  }
  const readByte = (address) => eflash.get(address) ?? 0xff;
  let offset = 48;
  let idcode = 0;
  let compressed = false;
  let crcCheck = false;
  let configLength = 0;
  let zeroCodes = [0xff, 0xff, 0xff];

  while (offset < eflashLength) {
    const key = readByte(offset) & 0x7f;
    const length = eflashHeaderLineBytes.get(key);
    if (length === undefined || offset + length > eflashLength) return undefined;
    const row = Uint8Array.from(
      { length },
      (_, index) => readByte(offset + index),
    );
    offset += length;

    if (key === 0x06) {
      idcode = ((row[4] << 24) | (row[5] << 16) | (row[6] << 8) | row[7]) >>> 0;
    } else if (key === 0x10) {
      compressed = Boolean((row[6] >> 5) & 1);
    } else if (key === 0x51) {
      zeroCodes = [row[5], row[6], row[7]];
    } else if (key === 0x3b) {
      crcCheck = Boolean((row[1] >> 7) & 1);
      configLength = (row[2] << 8) | row[3];
      break;
    }
  }

  const lineBytes = eflashConfigLineBytes.get(idcode);
  if (lineBytes === undefined || configLength === 0) return undefined;
  const lineCount = Math.min(lineCounts.get(idcode) ?? 0, configLength);
  const padding = [0x0100481b, 0x1100481b, 0x0100581b, 0x1100581b]
    .includes(idcode) ? 4 + (compressed ? 40 : 0) : 0;
  const drop = 6 + (crcCheck ? 2 : 0);
  const checksumBits = [];

  for (let line = 0; line < lineCount; line += 1) {
    if (offset + lineBytes > eflashLength) return undefined;
    const payloadLength = lineBytes - drop;
    const rowBits = [];
    for (let index = 0; index < payloadLength; index += 1) {
      const byte = readByte(offset + index);
      if (!compressed) {
        rowBits.push(byte.toString(2).padStart(8, "0"));
        continue;
      }
      const codeIndex = zeroCodes.indexOf(byte);
      rowBits.push(
        codeIndex < 0
          ? byte.toString(2).padStart(8, "0")
          : "0".repeat([64, 32, 16][codeIndex]),
      );
    }
    checksumBits.push(rowBits.join("").slice(padding));
    offset += lineBytes;
  }

  const payloadBits = checksumBits.join("");
  if (payloadBits.length % 8 !== 0) return undefined;
  const payloadBytes = new Uint8Array(payloadBits.length / 8);
  for (let index = 0; index < payloadBits.length; index += 8) {
    payloadBytes[index / 8] = Number.parseInt(payloadBits.slice(index, index + 8), 2);
  }
  return checksumGowinConfigPayload(payloadBytes);
}
