import { checksumGowinEflash } from "./fs-checksum.mjs";

const TAP = {
  reset: 0,
  idle: 1,
  selectDr: 2,
  captureDr: 3,
  shiftDr: 4,
  exit1Dr: 5,
  pauseDr: 6,
  exit2Dr: 7,
  updateDr: 8,
  selectIr: 9,
  captureIr: 10,
  shiftIr: 11,
  exit1Ir: 12,
  pauseIr: 13,
  exit2Ir: 14,
  updateIr: 15,
};

const TRANSITIONS = [
  [TAP.idle, TAP.reset],
  [TAP.idle, TAP.selectDr],
  [TAP.captureDr, TAP.selectIr],
  [TAP.shiftDr, TAP.exit1Dr],
  [TAP.shiftDr, TAP.exit1Dr],
  [TAP.pauseDr, TAP.updateDr],
  [TAP.pauseDr, TAP.exit2Dr],
  [TAP.shiftDr, TAP.updateDr],
  [TAP.idle, TAP.selectDr],
  [TAP.captureIr, TAP.reset],
  [TAP.shiftIr, TAP.exit1Ir],
  [TAP.shiftIr, TAP.exit1Ir],
  [TAP.pauseIr, TAP.updateIr],
  [TAP.pauseIr, TAP.exit2Ir],
  [TAP.shiftIr, TAP.updateIr],
  [TAP.idle, TAP.selectDr],
];

const TRACE_ENABLED = globalThis.process?.env?.FAKE_USB_TRACE === "1";
const TRACE_INSTRUCTIONS = new Set([0x0a, 0x13, 0x15, 0x3c, 0x71, 0x3a]);
const TRACE_COUNTS = new Map();
const FTDI_MAX_PACKET_SIZE = 512;
const FTDI_STATUS_SIZE = 2;

function traceHex(value, width = 8) {
  return `0x${(value >>> 0).toString(16).padStart(width, "0")}`;
}

function traceFakeUsb(message) {
  if (TRACE_ENABLED) process.stderr.write(`FAKE_USB_TRACE ${message}\n`);
}

function traceFakeUsbEvent(key, message, first = Infinity, interval = 1) {
  if (!TRACE_ENABLED) return;
  const count = (TRACE_COUNTS.get(key) ?? 0) + 1;
  TRACE_COUNTS.set(key, count);
  if (count <= first || (interval > 0 && count % interval === 0)) {
    traceFakeUsb(message);
  }
}

if (TRACE_ENABLED) {
  process.on("exit", () => {
    for (const [event, count] of TRACE_COUNTS) {
      process.stderr.write(`FAKE_USB_TRACE summary event=${event} count=${count}\n`);
    }
  });
}

const NOR_PHASES = Object.freeze({
  0x01: "nor-write-status",
  0x02: "nor-page-program",
  0x03: "nor-read",
  0x05: "nor-status",
  0x06: "nor-write-enable",
  0x09: "nor-read-status",
  0x20: "nor-sector-erase",
  0x52: "nor-block-erase",
  0x9f: "nor-read-id",
  0xc7: "nor-chip-erase",
  0xd8: "nor-block-erase",
});

class GowinTap {
  constructor(idcode, faults) {
    this.idcode = idcode >>> 0;
    this.faults = faults;
    this.eflashCorruptedWord = null;
    this.heartbeatEnabled =
      typeof process !== "undefined" && process.env?.FAKE_USB_HEARTBEAT === "1";
    this.heartbeatStartedAt = Date.now();
    this.lastHeartbeatAt = this.heartbeatStartedAt;
    this.mpsseBytesConsumed = 0;
    this.lastSpiOpcode = null;
    this.lastSpiAddress = null;
    this.phase = "idle";
    const maskedIdcode = this.idcode & 0x0fffffff;
    // Mirrors the GW1N BSCAN route selected after CONFIG_ENABLE and IR 0x3d; see gowin.cpp:63-75,187-194,983-986,1053-1083.
    this.spiPins = maskedIdcode === 0x0100981b
      ? { clock: 0x80, select: 0x20, input: 0x08, output: 0x02 }
      : { clock: 0x02, select: 0x08, input: 0x20, output: 0x80 };
    const flashSize = maskedIdcode === 0x0000081b
      ? 8 * 1024 * 1024
      : [0x0100981b, 0x0100481b].includes(maskedIdcode)
        ? 4 * 1024 * 1024
        : 0;
    this.externalFlash = flashSize > 0;
    this.nor = this.externalFlash ? new Uint8Array(flashSize).fill(0xff) : null;
    this.norStatus = faults.protectedNor ? 0x1c : 0;
    if (this.nor && faults.norSeed) {
      const offset = faults.norSeed.offset ?? 0;
      const bytes = Uint8Array.from(faults.norSeed.bytes ?? []);
      this.nor.set(bytes, offset);
    }
    this.sram = [];
    this.eflash = new Map();
    this.spiCommands = [];
    this.spiCommandCounts = new Map();
    this.instructionCounts = new Map();
    this.statusReads = [];
    this.spiReadTrace = [];
    this.configEnabled = false;
    this.bscanPins = this.spiPins.select;
    this.bscanSelected = false;
    this.bscanClockHigh = false;
    this.bscanBytes = [];
    this.bscanBitCount = 0;
    this.bscanCurrentByte = 0;
    this.bscanMiso = 0;
    this.wel = false;
    this.norBusy = false;
    this.norBusyPolls = 0;
    this.readCorrupted = false;
    this.readCorruptedAt = null;
    this.disconnectAfter = faults.disconnectAfter ?? Infinity;
    this.transferCount = 0;
    this.reset();
  }

  reset() {
    const previousInstruction = this.instruction;
    const previousUsercode = this.usercode;
    this.state = TAP.reset;
    this.instruction = 0x11;
    this.irShift = 0x01;
    this.drShift = this.idcode;
    this.status = (1 << 12) | (1 << 13) | (1 << 15) | (1 << 16);
    this.eflashErasePending = false;
    this.usercode = 0;
    this.traceUsercodeReadWindow = false;
    this.drInputBits = [];
    this.configEnabled = false;
    this.bscanPins = this.spiPins.select;
    this.bscanSelected = false;
    this.bscanClockHigh = false;
    this.bscanBytes = [];
    this.bscanBitCount = 0;
    this.bscanCurrentByte = 0;
    this.bscanMiso = 0;
    this.spiOutputBits = [];
    this.spiOutputIndex = 0;
    this.spiPrepared = false;
    if (previousInstruction !== undefined || previousUsercode !== undefined) {
      traceFakeUsb(
        `state-reset kind=device instruction=${previousInstruction === undefined ? "none" : traceHex(previousInstruction, 2)} usercode=${previousUsercode === undefined ? "none" : traceHex(previousUsercode)} next_usercode=${traceHex(this.usercode)}`,
      );
    }
  }

  setInstruction(instruction) {
    this.instruction = instruction & 0xff;
    if (TRACE_INSTRUCTIONS.has(this.instruction)) {
      traceFakeUsbEvent(
        `ir-load-${traceHex(this.instruction, 2)}`,
        `ir-load instruction=${traceHex(this.instruction, 2)} phase=${this.phase ?? "none"} usercode=${traceHex(this.usercode)} status=${traceHex(this.status)}`,
      );
    }
    if (instruction === 0x15) this.phase = "config-enable";
    else if (instruction === 0x3d) this.phase = "bscan-spi";
    else if (instruction === 0x16) this.phase = "jtag-spi";
    this.instructionCounts.set(
      this.instruction,
      (this.instructionCounts.get(this.instruction) ?? 0) + 1,
    );
    if (instruction === 0x15) {
      this.configEnabled = true;
      this.status |= 1 << 7;
    }
    if (instruction === 0x3a) {
      this.configEnabled = false;
      this.status &= ~(1 << 7);
    }
    if (instruction === 0x05) {
      this.status &= ~((1 << 13) | (1 << 5));
      this.status |= 1 << 5;
      this.sram = [];
    }
    if (instruction === 0x09) this.status &= ~(1 << 5);
    if (instruction === 0x08 && !this.faults.doneNever) this.status |= 1 << 13;
    if (instruction === 0x75) {
      this.status |= 1 << 13;
      this.eflashErasePending = true;
      this.eflash.clear();
    }
    if (instruction === 0x71) this.eflashExpectAddress = true;
    if (instruction === 0x3c) {
      this.status |= 1 << 13;
      if (this.eflash.size > 0) {
        const usercode = checksumGowinEflash(this.eflash);
        if (usercode !== undefined) this.usercode = usercode;
        traceFakeUsb(
          `usercode-set kind=internal-flash-reload value=${traceHex(this.usercode)}`,
        );
      }
      this.traceUsercodeReadWindow = true;
    }
  }

  registerValue() {
    if (this.instruction === 0x11) return this.idcode;
    if (this.instruction === 0x41) {
      if (this.eflashErasePending && !this.faults.eflashBusyForever) {
        this.status &= ~(1 << 13);
        this.eflashErasePending = false;
      }
      this.statusReads.push(this.status);
      if (this.statusReads.length > 40) this.statusReads.shift();
      return this.status;
    }
    if (this.instruction === 0x13) return this.usercode;
    if (this.instruction === 0x3d && this.bscanMiso) {
      return this.spiPins.output;
    }
    return 0;
  }

  prepareShift(inputBits, hasRead) {
    if (this.state !== TAP.shiftDr || this.instruction !== 0x16 || !hasRead || this.spiPrepared) return;
    const input = [];
    for (let offset = 0; offset < inputBits.length; offset += 8) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        byte = (byte << 1) | (inputBits[offset + bit] ?? 0);
      }
      input.push(byte);
    }
    const response = this.spiTransaction(input);
    const trace = { bits: inputBits.length, input, response, tdoBits: [] };
    this.spiReadTrace.push(trace);
    if (this.spiReadTrace.length > 40) this.spiReadTrace.shift();
    this.currentSpiReadTrace = trace;
    this.spiPrepared = true;
    const raw = new Uint8Array(response.length + 1);
    for (let index = 0; index < response.length; index += 1) {
      let reversed = response[index];
      reversed = ((reversed & 0x55) << 1) | ((reversed >>> 1) & 0x55);
      reversed = ((reversed & 0x33) << 2) | ((reversed >>> 2) & 0x33);
      reversed = ((reversed & 0x0f) << 4) | ((reversed >>> 4) & 0x0f);
      raw[index] = (raw[index] & 1) | ((reversed << 1) & 0xfe);
      raw[index + 1] |= reversed >>> 7;
    }
    this.spiOutputBits = [];
    for (const byte of raw) {
      for (let bit = 0; bit < 8; bit += 1) this.spiOutputBits.push((byte >>> bit) & 1);
    }
    this.spiOutputIndex = 0;
  }

  spiTransaction(input) {
    if (input.length === 0) return [];
    const command = input[0];
    this.lastSpiOpcode = command;
    this.spiCommandCounts.set(command, (this.spiCommandCounts.get(command) ?? 0) + 1);
    this.spiCommands.push(input.slice(0, 8));
    if (this.spiCommands.length > 40) this.spiCommands.shift();
    const response = new Array(input.length).fill(0);
    const address = ((input[1] ?? 0) << 16) | ((input[2] ?? 0) << 8) | (input[3] ?? 0);
    if ([0x02, 0x03, 0x0b, 0x20, 0x52, 0xd8].includes(command) && input.length >= 4) {
      this.lastSpiAddress = address;
    }
    this.phase = NOR_PHASES[command]
      ?? `nor-opcode-0x${command.toString(16).padStart(2, "0")}`;
    if (command === 0x9f) {
      response[1] = 0xef;
      response[2] = 0x40;
      response[3] = this.nor.length === 4 * 1024 * 1024 ? 0x16 : 0x17;
    } else if (command === 0x05) {
      const status = (this.faults.norBusyForever || this.norBusy ? 1 : 0)
        | (this.wel ? 2 : 0)
        | this.norStatus;
      this.lastNorStatus = status;
      this.phase = (status & 1) === 1 ? "nor-status-wip" : "nor-status-ready";
      for (let index = 1; index < response.length; index += 1) {
        response[index] = status;
      }
      if (this.norBusy && !this.faults.norBusyForever && this.norBusyPolls > 0) {
        this.norBusyPolls -= 1;
        if (this.norBusyPolls === 0) this.norBusy = false;
      }
    } else if (command === 0x06) {
      this.wel = true;
    } else if (command === 0x04) {
      this.wel = false;
    } else if (command === 0x01 && this.wel) {
      this.norStatus = (input[1] ?? 0) & 0xfc;
      this.wel = false;
    } else if ((command === 0x20 || command === 0xd8) && this.wel) {
      const size = command === 0xd8 ? 0x10000 : 0x1000;
      this.nor.fill(0xff, address & ~(size - 1), Math.min(this.nor.length, (address & ~(size - 1)) + size));
      this.wel = false;
      this.norBusy = true;
      this.norBusyPolls = 1;
    } else if (command === 0x02 && this.wel) {
      for (let index = 4; index < input.length; index += 1) {
        const location = (address & ~0xff) | ((address + index - 4) & 0xff);
        this.nor[location] &= input[index];
      }
      this.wel = false;
      this.norBusy = true;
      this.norBusyPolls = 1;
    } else if (command === 0x03) {
      for (let index = 4; index < response.length; index += 1) {
        const value = this.nor[(address + index - 4) % this.nor.length];
        response[index] = this.faults.corruptNorReadback && !this.readCorrupted
          ? value ^ (this.readCorrupted = true, 1)
          : value;
      }
    } else if (command === 0xc7 && this.wel) {
      this.nor.fill(0xff);
      this.wel = false;
      this.norBusy = true;
      this.norBusyPolls = 1;
    }
    return response;
  }

  maybeHeartbeat() {
    if (!this.heartbeatEnabled) return;
    const now = Date.now();
    if (now - this.lastHeartbeatAt < 10_000) return;
    this.lastHeartbeatAt = now;
    const hex = (value, width = 2) =>
      value === null ? null : `0x${value.toString(16).padStart(width, "0")}`;
    const heartbeat = `FAKE_USB_HEARTBEAT ${JSON.stringify({
        elapsedMs: now - this.heartbeatStartedAt,
        mpsseBytesConsumed: this.mpsseBytesConsumed,
        lastSpiOpcode: hex(this.lastSpiOpcode),
        lastSpiAddress: hex(this.lastSpiAddress, 6),
        norStatus: hex(this.lastNorStatus ?? this.norStatus),
        wip: Boolean(this.faults.norBusyForever || this.norBusy || (this.norStatus & 1)),
        norBusyPolls: this.norBusyPolls,
        phase: this.phase,
        instruction: hex(this.instruction),
        bscanSelected: this.bscanSelected,
        bscanBitCount: this.bscanBitCount,
      })}\n`;
    process.stderr.write(heartbeat);
    const heartbeatFile = process.env?.FAKE_USB_HEARTBEAT_FILE;
    if (heartbeatFile && typeof process.getBuiltinModule === "function") {
      process.getBuiltinModule("node:fs").appendFileSync(heartbeatFile, heartbeat);
    }
  }

  bscanReadBit() {
    const command = this.bscanBytes[0];
    const byteIndex = this.bscanBytes.length;
    if (command === 0x9f) {
      const id = this.nor.length === 4 * 1024 * 1024 ? [0xef, 0x40, 0x16] : [0xef, 0x40, 0x17];
      return ((id[byteIndex - 1] ?? 0) >>> (7 - (this.bscanBitCount & 7))) & 1;
    }
    if (command === 0x05) {
      if (this.norBusy && !this.faults.norBusyForever && this.norBusyPolls > 0) {
        this.norBusyPolls -= 1;
        if (this.norBusyPolls === 0) this.norBusy = false;
      }
      const status = (this.faults.norBusyForever || this.norBusy ? 1 : 0)
        | (this.wel ? 2 : 0)
        | this.norStatus;
      return (status >>> (7 - (this.bscanBitCount & 7))) & 1;
    }
    if (command === 0x03 && byteIndex >= 4) {
      const address = ((this.bscanBytes[1] ?? 0) << 16)
        | ((this.bscanBytes[2] ?? 0) << 8)
        | (this.bscanBytes[3] ?? 0);
      let value = this.nor[(address + byteIndex - 4) % this.nor.length];
      if (this.faults.corruptNorReadback && !this.readCorrupted) {
        value ^= 1 << (7 - (this.bscanBitCount & 7));
        this.readCorrupted = true;
        this.readCorruptedAt = {
          address: (address + byteIndex - 4) % this.nor.length,
          bit: this.bscanBitCount & 7,
          elapsedMs: Date.now() - this.heartbeatStartedAt,
        };
      }
      return (value >>> (7 - (this.bscanBitCount & 7))) & 1;
    }
    return 0;
  }

  updateBscanRegister(byte) {
    if (!this.configEnabled) return;
    const selected = (byte & this.spiPins.select) === 0;
    const clockHigh = Boolean(byte & this.spiPins.clock);
    if (!this.bscanSelected && selected) {
      this.bscanBytes = [];
      this.bscanBitCount = 0;
      this.bscanCurrentByte = 0;
    }
    if (this.bscanSelected && selected && !clockHigh) {
      this.bscanMiso = this.bscanReadBit();
    }
    if (this.bscanSelected && selected && !this.bscanClockHigh && clockHigh) {
      this.bscanCurrentByte = (this.bscanCurrentByte << 1)
        | (Boolean(byte & this.spiPins.input) ? 1 : 0);
      this.bscanBitCount += 1;
      if ((this.bscanBitCount & 7) === 0) {
        this.bscanBytes.push(this.bscanCurrentByte);
        this.bscanCurrentByte = 0;
      }
    }
    if (this.bscanSelected && !selected) {
      if (this.bscanBitCount > 0 && (this.bscanBitCount & 7) === 0) {
        this.spiTransaction(this.bscanBytes);
      }
      this.bscanBytes = [];
      this.bscanBitCount = 0;
      this.bscanCurrentByte = 0;
      this.bscanMiso = 0;
    }
    this.bscanPins = byte;
    this.bscanSelected = selected;
    this.bscanClockHigh = clockHigh;
  }

  shiftedBytes() {
    const bytes = new Uint8Array(Math.ceil(this.drInputBits.length / 8));
    for (let bit = 0; bit < this.drInputBits.length; bit += 1) {
      bytes[bit >>> 3] |= this.drInputBits[bit] << (bit & 7);
    }
    return bytes;
  }

  updateDataRegister() {
    const bytes = this.shiftedBytes();
    if (TRACE_INSTRUCTIONS.has(this.instruction)) {
      const data = Array.from(bytes.subarray(0, 8), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const key = `dr-update-${traceHex(this.instruction, 2)}`;
      const message = `dr-update instruction=${traceHex(this.instruction, 2)} bits=${this.drInputBits.length} bytes=${bytes.length} data=${data || "-"} usercode=${traceHex(this.usercode)}`;
      traceFakeUsbEvent(key, message, this.instruction === 0x71 ? 3 : Infinity, this.instruction === 0x71 ? 8192 : 1);
    }
    if (this.instruction === 0x17) {
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        this.sram.push(...bytes.subarray(offset, offset + 8192));
      }
    } else if (this.instruction === 0x0a) {
      this.usercode = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8)
        | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 24);
      traceFakeUsb(
        `usercode-set instruction=0x0a value=${traceHex(this.usercode)}`,
      );
    } else if (this.instruction === 0x08 && !this.faults.doneNever) {
      this.status |= 1 << 13;
    } else if (this.instruction === 0x71) {
      if (this.eflashExpectAddress) {
        this.eflashAddress = ((bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8)
          | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 24)) * 4;
        this.eflashExpectAddress = false;
      } else {
        for (let offset = 0; offset < bytes.length; offset += 4) {
          const word = bytes.slice(offset, offset + 4);
          word.reverse();
          const wordAddress = this.eflashAddress;
          if (
            this.eflashCorruptedWord === null
            && this.faults.eflashCorruptWord === Math.floor(wordAddress / 4)
          ) {
            word[0] ^= 1;
            this.eflashCorruptedWord = Math.floor(wordAddress / 4);
          }
          for (const byte of word) this.eflash.set(this.eflashAddress++, byte);
        }
      }
    } else if (this.instruction === 0x16 && !this.spiPrepared) {
      const bytes = [];
      for (let offset = 0; offset + 7 < this.drInputBits.length; offset += 8) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit += 1) {
          byte = (byte << 1) | this.drInputBits[offset + bit];
        }
        bytes.push(byte);
      }
      this.spiTransaction(bytes);
    } else if (this.instruction === 0x3d && bytes.length === 1) {
      this.updateBscanRegister(bytes[0]);
    }
    this.drInputBits = [];
    this.spiPrepared = false;
  }

  clock(tms, tdi) {
    let tdo = 0;
    if (this.state === TAP.shiftDr) {
      if (this.instruction === 0x16) {
        tdo = this.spiOutputBits[this.spiOutputIndex++] ?? 0;
        this.currentSpiReadTrace?.tdoBits.push(tdo);
      } else {
        tdo = this.drShift & 1;
        this.drShift = (this.drShift >>> 1) | ((tdi & 1) << 31);
      }
      if (this.instruction === 0x13 && this.drReadBits) {
        this.drReadBits.push(tdo);
      }
      if ([0x16, 0x17, 0x0a, 0x08, 0x71, 0x3d].includes(this.instruction)) {
        this.drInputBits.push(tdi & 1);
      }
    } else if (this.state === TAP.shiftIr) {
      tdo = this.irShift & 1;
      this.irShift = (this.irShift >>> 1) | ((tdi & 1) << 7);
    }

    const next = TRANSITIONS[this.state][tms ? 1 : 0];
    if (this.state === TAP.shiftDr && next !== TAP.shiftDr && this.instruction === 0x16) {
      this.spiPrepared = false;
      this.currentSpiReadTrace = null;
    }
    if (next === TAP.captureDr) {
      this.drShift = this.registerValue();
      if (this.instruction === 0x13) {
        this.drReadBits = [];
        traceFakeUsbEvent(
          `dr-read-${traceHex(this.instruction, 2)}`,
          `dr-read instruction=${traceHex(this.instruction, 2)} value=${traceHex(this.drShift)} usercode=${traceHex(this.usercode)}`,
        );
      }
      this.drInputBits = [];
      this.spiPrepared = false;
    } else if (next === TAP.captureIr) {
      this.irShift = 0x01;
    } else if (next === TAP.updateDr) {
      this.updateDataRegister();
    } else if (next === TAP.updateIr) {
      this.setInstruction(this.irShift);
    } else if (next === TAP.reset) {
      if (this.state !== TAP.reset) {
        traceFakeUsb(
          `state-reset kind=tap instruction=${traceHex(this.instruction, 2)} usercode=${traceHex(this.usercode)} status=${traceHex(this.status)}`,
        );
      }
      this.instruction = 0x11;
    }
    if (
      this.state === TAP.shiftDr
      && next !== TAP.shiftDr
      && this.instruction === 0x13
      && this.drReadBits
    ) {
      const value = this.drReadBits.reduce(
        (result, bit, index) => result + (bit ? 2 ** index : 0),
        0,
      );
      traceFakeUsb(
        `dr-read-shift instruction=0x13 bits=${this.drReadBits.join("")} value=${traceHex(value)}`,
      );
      this.drReadBits = null;
    }
    this.state = next;
    return tdo;
  }
}

function asBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data ?? []);
}

function descriptorView(bytes, length) {
  const view = Uint8Array.from(bytes).subarray(0, length);
  return new DataView(view.buffer, view.byteOffset, view.byteLength);
}

function stringDescriptor(value) {
  const bytes = [2 + value.length * 2, 3];
  for (const character of value) {
    const code = character.charCodeAt(0);
    bytes.push(code & 0xff, code >>> 8);
  }
  return bytes;
}

class FakeUSBDevice {
  constructor(idcode, faults) {
    this.vendorId = 0x0403;
    this.productId = 0x6010;
    this.manufacturerName = "Sipeed";
    this.productName = "Tang Nano";
    this.serialNumber = "TN-S0-0001";
    this.opened = false;
    this.interfaceClaims = new Set();
    this.tap = new GowinTap(idcode, faults);
    this.traceUsercodeReadPending = false;
    this.mpsseOutputOrigins = [];
    this.lastTransferInTrace = null;
    this.faults = faults;
    this.mpsseInput = [];
    this.mpsseOutput = [];
    this.strings = [
      "",
      "Sipeed",
      "Tang Nano",
      "TN-S0-0001",
    ];
    this.configurations = [{
      configurationValue: 1,
      interfaces: [0, 1].map((interfaceNumber) => ({
        interfaceNumber,
        alternates: [{
          alternateSetting: 0,
          interfaceClass: 0xff,
          interfaceSubclass: 0xff,
          interfaceProtocol: 0xff,
          endpoints: [
            {
              endpointNumber: interfaceNumber === 0 ? 1 : 3,
              direction: "in",
              type: "bulk",
              packetSize: 512,
            },
            {
              endpointNumber: interfaceNumber === 0 ? 2 : 4,
              direction: "out",
              type: "bulk",
              packetSize: 512,
            },
          ],
        }],
      })),
    }];
    this.configuration = null;
  }

  async open() {
    this.opened = true;
  }

  async close() {
    this.opened = false;
  }

  async reset() {
    this.tap.reset();
    this.mpsseInput = [];
    this.mpsseOutput = [];
    this.mpsseOutputOrigins = [];
    this.lastTransferInTrace = null;
  }

  enqueueMpsseOutput(opcode, bytes) {
    const output = Array.from(bytes);
    if (output.length === 0) return;
    this.mpsseOutput.push(...output);
    if (!TRACE_ENABLED) return;

    const lastOrigin = this.mpsseOutputOrigins.at(-1);
    if (lastOrigin?.opcode === opcode) {
      lastOrigin.bytes += output.length;
    } else {
      this.mpsseOutputOrigins.push({ opcode, bytes: output.length });
    }
    if (this.tap.traceUsercodeReadWindow) {
      traceFakeUsb(
        `mpsse-enqueue opcode=${traceHex(opcode, 2)} bytes=${output.length} queued=${this.mpsseOutput.length}`,
      );
    }
  }

  consumeMpsseOutput(length) {
    const output = this.mpsseOutput.splice(0, length);
    if (!TRACE_ENABLED) return output;

    let remaining = output.length;
    while (remaining > 0 && this.mpsseOutputOrigins.length > 0) {
      const origin = this.mpsseOutputOrigins[0];
      const consumed = Math.min(remaining, origin.bytes);
      origin.bytes -= consumed;
      remaining -= consumed;
      if (origin.bytes === 0) this.mpsseOutputOrigins.shift();
    }
    return output;
  }

  traceReadWindowStart() {
    const originSummary = this.mpsseOutputOrigins
      .map(({ opcode, bytes }) => `${traceHex(opcode, 2)}:${bytes}`)
      .join(",");
    traceFakeUsb(
      `read-window-start instruction=0x3c queued=${this.mpsseOutput.length} origins=${originSummary || "-"} last-transfer-in=${this.lastTransferInTrace ?? "none"}`,
    );
  }

  clockTap(tms, tdi) {
    const wasInReadWindow = this.tap.traceUsercodeReadWindow;
    const value = this.tap.clock(tms, tdi);
    if (!wasInReadWindow && this.tap.traceUsercodeReadWindow) {
      this.traceReadWindowStart();
    }
    return value;
  }

  async selectConfiguration(configurationValue) {
    this.configuration =
      this.configurations.find((item) => item.configurationValue === configurationValue) ?? null;
  }

  async claimInterface(interfaceNumber) {
    this.interfaceClaims.add(interfaceNumber);
  }

  async releaseInterface(interfaceNumber) {
    this.interfaceClaims.delete(interfaceNumber);
  }

  async controlTransferIn(setup, length) {
    let bytes = [];
    if (setup.request === 6 && setup.requestType === "standard") {
      const descriptorType = setup.value >>> 8;
      const descriptorIndex = setup.value & 0xff;
      if (descriptorType === 1) {
        bytes = [
          18, 1, 0x00, 0x02, 0, 0, 0, 64,
          0x03, 0x04, 0x10, 0x60, 0x00, 0x07,
          1, 2, 3, 1,
        ];
      } else if (descriptorType === 2) {
        bytes = [
          9, 2, 55, 0, 2, 1, 0, 0x80, 50,
          9, 4, 0, 0, 2, 0xff, 0xff, 0xff, 0,
          7, 5, 0x81, 2, 0x00, 0x02, 0,
          7, 5, 0x02, 2, 0x00, 0x02, 0,
          9, 4, 1, 0, 2, 0xff, 0xff, 0xff, 0,
          7, 5, 0x83, 2, 0x00, 0x02, 0,
          7, 5, 0x04, 2, 0x00, 0x02, 0,
        ];
      } else if (descriptorType === 3) {
        bytes = descriptorIndex === 0
          ? [4, 3, 0x09, 0x04]
          : stringDescriptor(this.strings[descriptorIndex] ?? "");
      }
    } else if (setup.requestType === "vendor") {
      bytes = [0x60];
    } else if (setup.request === 8) {
      bytes = [1];
    }
    return { status: "ok", data: descriptorView(bytes, length) };
  }

  async controlTransferOut(_setup, data) {
    return { status: "ok", bytesWritten: asBytes(data).byteLength };
  }

  async clearHalt() {
    return { status: "ok" };
  }

  async transferOut(endpoint, data) {
    if (++this.tap.transferCount > this.tap.disconnectAfter) {
      throw new DOMException("Device disconnected", "NotFoundError");
    }
    if (![2, 4, 0x02, 0x04].includes(endpoint)) {
      return { status: "stall", bytesWritten: 0 };
    }
    const bytes = asBytes(data);
    this.tap.mpsseBytesConsumed += bytes.byteLength;
    this.mpsseInput.push(...bytes);
    this.consumeMpsse();
    this.tap.maybeHeartbeat();
    return { status: "ok", bytesWritten: bytes.byteLength };
  }

  async transferIn(endpoint, length) {
    if (++this.tap.transferCount > this.tap.disconnectAfter) {
      throw new DOMException("Device disconnected", "NotFoundError");
    }
    if (![1, 3, 0x81, 0x83].includes(endpoint)) {
      return { status: "stall", data: new DataView(new ArrayBuffer(0)) };
    }
    const maxPayload = Math.max(
      1,
      Math.min(FTDI_MAX_PACKET_SIZE - FTDI_STATUS_SIZE, length - FTDI_STATUS_SIZE),
    );
    const output = [];
    while (this.mpsseOutput.length > 0 && output.length < length) {
      output.push(0x01, 0x60);
      const count = Math.min(
        maxPayload,
        this.mpsseOutput.length,
        length - output.length - FTDI_STATUS_SIZE,
      );
      if (count <= 0) break;
      output.push(...this.consumeMpsseOutput(count));
    }
    if (output.length === 0) output.push(0x01, 0x60);
    this.tap.maybeHeartbeat();
    if (TRACE_ENABLED) {
      const packetHeads = [];
      for (let offset = 0; offset < output.length; offset += FTDI_MAX_PACKET_SIZE) {
        packetHeads.push(
          output
            .slice(offset, offset + Math.min(8, FTDI_MAX_PACKET_SIZE))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        );
      }
      const trace = `requested=${length} returned=${output.length} queued=${this.mpsseOutput.length} packet-heads=${packetHeads.join("/")}`;
      this.lastTransferInTrace = trace;
      if (this.tap.traceUsercodeReadWindow) {
        traceFakeUsb(`transfer-in endpoint=${endpoint} ${trace}`);
      }
    }
    if (this.traceUsercodeReadPending) {
      this.traceUsercodeReadPending = false;
    }
    return { status: "ok", data: descriptorView(output, length) };
  }

  consumeMpsse() {
    while (this.mpsseInput.length > 0) {
      const command = this.mpsseInput[0];
      if (command === 0xaa || command === 0xab) {
        this.mpsseInput.shift();
        this.enqueueMpsseOutput(command, [0xfa, command]);
        continue;
      }
      if (command === 0x80 || command === 0x82 || command === 0x86) {
        if (this.mpsseInput.length < 3) return;
        this.mpsseInput.splice(0, 3);
        continue;
      }
      if ([0x81, 0x83].includes(command)) {
        this.mpsseInput.shift();
        this.enqueueMpsseOutput(command, [0xff]);
        continue;
      }
      if (command === 0x8e) {
        if (this.mpsseInput.length < 2) return;
        this.mpsseInput.splice(0, 2);
        continue;
      }
      if (command === 0x8f) {
        if (this.mpsseInput.length < 3) return;
        this.mpsseInput.splice(0, 3);
        continue;
      }
      if ([0x8a, 0x8b, 0x8d, 0x97, 0x85, 0x87].includes(command)) {
        this.mpsseInput.shift();
        continue;
      }
      if (command === 0x4b || command === 0x6b) {
        if (this.mpsseInput.length < 3) return;
        const count = this.mpsseInput[1] + 1;
        const bits = this.mpsseInput[2];
        this.mpsseInput.splice(0, 3);
        let result = 0;
        for (let bit = 0; bit < count; bit++) {
          const tms = (bits >>> bit) & 1;
          const tdo = this.clockTap(tms, bits >>> 7);
          result |= tdo << (7 - bit);
        }
        if (command === 0x6b) {
          this.enqueueMpsseOutput(command, [result]);
          if (this.tap.instruction === 0x13) {
            traceFakeUsb(
              `mpsse-tms-read instruction=0x13 bits=${count} bytes=${result.toString(16).padStart(2, "0")}`,
            );
          }
        }
        continue;
      }

      const mode = command & 0x30;
      if (![0x10, 0x20, 0x30].includes(mode)) {
        this.mpsseInput.shift();
        continue;
      }
      const bitMode = Boolean(command & 0x02);
      const hasWrite = mode === 0x10 || mode === 0x30;
      const hasRead = mode === 0x20 || mode === 0x30;
      const lsbFirst = Boolean(command & 0x08);
      const headerSize = bitMode ? 2 : 3;
      if (this.mpsseInput.length < headerSize) return;
      const count = bitMode
        ? this.mpsseInput[1] + 1
        : (this.mpsseInput[1] | (this.mpsseInput[2] << 8)) + 1;
      if (bitMode && hasRead && count > 8) {
        throw new Error(
          `Invalid MPSSE bit-mode count ${count} for opcode 0x${command.toString(16).padStart(2, "0")}`,
        );
      }
      const dataBytes = hasWrite ? (bitMode ? 1 : count) : 0;
      if (this.mpsseInput.length < headerSize + dataBytes) return;
      const payload = this.mpsseInput.slice(headerSize, headerSize + dataBytes);
      this.mpsseInput.splice(0, headerSize + dataBytes);
      const bits = bitMode ? count : count * 8;
      if (hasWrite && this.tap.state === TAP.shiftDr) {
        const inputBits = [];
        for (let bit = 0; bit < bits; bit += 1) {
          const byteIndex = Math.floor(bit / 8);
          const bitIndex = lsbFirst ? bit % 8 : 7 - (bit % 8);
          inputBits.push((payload[byteIndex] >>> bitIndex) & 1);
        }
        this.tap.prepareShift(inputBits, hasRead);
      }
      const received = new Array(bitMode ? 1 : count).fill(0);
      const bitModeReadBits = bitMode && hasRead ? [] : null;
      for (let bit = 0; bit < bits; bit++) {
        const byteIndex = Math.floor(bit / 8);
        const bitIndex = lsbFirst ? bit % 8 : 7 - (bit % 8);
        const tdi = hasWrite ? ((payload[byteIndex] >>> bitIndex) & 1) : 0;
        const tdo = this.clockTap(0, tdi);
        if (hasRead) {
          if (bitMode) {
            bitModeReadBits.push(tdo);
          } else {
            const outputBit = bit % 8;
            const outputIndex = lsbFirst ? outputBit : 7 - outputBit;
            received[byteIndex] |= tdo << outputIndex;
          }
        }
      }
      if (hasRead) {
        if (bitMode) received[0] = packMpsseBitModeRead(bitModeReadBits, lsbFirst);
        if (this.tap.instruction === 0x13) {
          traceFakeUsb(
            `mpsse-read instruction=0x13 bits=${bits} bytes=${received.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
          );
          this.traceUsercodeReadPending = true;
        }
        this.enqueueMpsseOutput(command, received);
      }
    }
  }
}

export function packMpsseBitModeRead(bits, lsbFirst = true) {
  const bitCount = bits.length;
  if (bitCount < 1 || bitCount > 8) {
    throw new RangeError(`Invalid MPSSE bit-mode read count: ${bitCount}`);
  }

  let packed = 0;
  for (let bit = 0; bit < bitCount; bit += 1) {
    const outputIndex = lsbFirst ? 8 - bitCount + bit : bitCount - 1 - bit;
    if (outputIndex < 0 || outputIndex >= 8) {
      throw new RangeError(`Invalid MPSSE bit-mode output index: ${outputIndex}`);
    }
    packed |= (bits[bit] & 1) << outputIndex;
  }
  return packed;
}

export function createFakeUsb(
  idcode,
  { connected = true, faults = {} } = {},
) {
  const device = new FakeUSBDevice(idcode, faults);
  return {
    device,
    usb: {
      async getDevices() {
        return connected ? [device] : [];
      },
    },
  };
}
