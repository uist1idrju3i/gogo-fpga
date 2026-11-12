const HEADER_BYTES = 20;
const READ = 0;
const WRITE = 1;
const STATE = 2;
const EPOCH = 3;
const CLAIMS = 4;
const OPEN = 0;
const EOF = 1;
const CANCELLED = 2;
const CLOSED = 3;
const MAX_CAPACITY = 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;

export class BytePipeError extends Error {
  constructor(code) {
    super(`Byte pipe ${code}`);
    this.code = code;
  }
}

function requireSharedMemory() {
  if (globalThis.crossOriginIsolated !== true || typeof SharedArrayBuffer !== "function") {
    throw new BytePipeError("isolation-required");
  }
  if (typeof Atomics.waitAsync !== "function") throw new BytePipeError("async-wait-unavailable");
}

export function createBytePipe(capacity = 64 * 1024) {
  requireSharedMemory();
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    throw new RangeError("Byte pipe capacity must be between 1 and 1048576");
  }
  return Object.freeze({ version: 1, buffer: new SharedArrayBuffer(HEADER_BYTES + capacity + 1) });
}

export function attachBytePipe(descriptor, role) {
  requireSharedMemory();
  if (descriptor?.version !== 1 || !(descriptor.buffer instanceof SharedArrayBuffer) ||
      descriptor.buffer.growable || descriptor.buffer.byteLength < HEADER_BYTES + 2 ||
      descriptor.buffer.byteLength > HEADER_BYTES + MAX_CAPACITY + 1) {
    throw new TypeError("Invalid byte pipe descriptor");
  }
  if (role !== "reader" && role !== "writer") throw new TypeError("Invalid byte pipe role");
  const header = new Int32Array(descriptor.buffer, 0, HEADER_BYTES / 4);
  const buffer = new Uint8Array(descriptor.buffer, HEADER_BYTES);

  function snapshot() {
    const read = Atomics.load(header, READ);
    const write = Atomics.load(header, WRITE);
    const state = Atomics.load(header, STATE);
    if (read < 0 || read >= buffer.length || write < 0 || write >= buffer.length ||
        state < OPEN || state > CLOSED) throw new BytePipeError("corrupt");
    return { read, write, state };
  }
  snapshot();
  const claim = role === "reader" ? 1 : 2;
  if (Atomics.or(header, CLAIMS, claim) & claim) throw new BytePipeError("already-attached");

  function notify() {
    Atomics.add(header, EPOCH, 1);
    Atomics.notify(header, EPOCH);
  }

  function checkState(state, writing = false) {
    if (state === CANCELLED) throw new BytePipeError("cancelled");
    if (state === CLOSED || (writing && state === EOF)) throw new BytePipeError("closed");
  }

  function take(maxBytes) {
    const { read, write, state } = snapshot();
    checkState(state);
    const available = (write - read + buffer.length) % buffer.length;
    if (maxBytes === 0 || available === 0) {
      return maxBytes === 0 || state === EOF ? new Uint8Array() : null;
    }
    const count = Math.min(maxBytes, available, buffer.length - read);
    const result = buffer.slice(read, read + count);
    Atomics.store(header, READ, (read + count) % buffer.length);
    notify();
    return result;
  }

  function put(bytes, offset) {
    const { read, write, state } = snapshot();
    checkState(state, true);
    const free = (read - write - 1 + buffer.length) % buffer.length;
    const count = Math.min(free, bytes.length - offset, buffer.length - write);
    if (count > 0) {
      buffer.set(bytes.subarray(offset, offset + count), write);
      Atomics.store(header, WRITE, (write + count) % buffer.length);
      notify();
    }
    return count;
  }

  function validateRead(maxBytes) {
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_WRITE_BYTES) {
      throw new RangeError("Invalid byte pipe read size");
    }
  }

  function validateWrite(bytes) {
    checkState(snapshot().state, true);
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_WRITE_BYTES) {
      throw new TypeError("Byte pipe writes must be bounded Uint8Arrays");
    }
    return new Uint8Array(bytes);
  }

  async function waitAsync(epoch) {
    if (typeof Atomics.waitAsync !== "function") throw new BytePipeError("async-wait-unavailable");
    await Atomics.waitAsync(header, EPOCH, epoch).value;
  }

  function waitSync(epoch, timeoutMs = Infinity) {
    if (typeof globalThis.document !== "undefined") throw new BytePipeError("worker-required");
    Atomics.wait(header, EPOCH, epoch, timeoutMs);
  }

  const common = {
    cancel() {
      for (;;) {
        const state = snapshot().state;
        if (state === CLOSED || state === CANCELLED) break;
        if (Atomics.compareExchange(header, STATE, state, CANCELLED) === state) break;
      }
      notify();
    },
    close() {
      for (;;) {
        const state = snapshot().state;
        if (state === CANCELLED || state === CLOSED) break;
        if (Atomics.compareExchange(header, STATE, state, CLOSED) === state) break;
      }
      notify();
    },
  };
  let pending = false;

  if (role === "reader") {
    function enter(maxBytes) {
      if (pending) throw new BytePipeError("busy");
      validateRead(maxBytes);
      pending = true;
    }
    return Object.freeze({
      ...common,
      readAvailable(maxBytes) {
        enter(maxBytes);
        try { return take(maxBytes); }
        finally { pending = false; }
      },
      waitReadableSync(timeoutMs) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) {
          throw new RangeError("Invalid byte pipe wait time");
        }
        enter(0);
        const deadline = performance.now() + timeoutMs;
        try {
          for (;;) {
            const epoch = Atomics.load(header, EPOCH);
            const { read, write, state } = snapshot();
            checkState(state);
            if (read !== write || state === EOF) return true;
            const remaining = deadline - performance.now();
            if (remaining <= 0) return false;
            waitSync(epoch, remaining);
          }
        } finally { pending = false; }
      },
      readSync(maxBytes) {
        enter(maxBytes);
        try {
          for (;;) {
            const epoch = Atomics.load(header, EPOCH);
            const result = take(maxBytes);
            if (result !== null) return result;
            waitSync(epoch);
          }
        } finally { pending = false; }
      },
      async readAsync(maxBytes) {
        enter(maxBytes);
        try {
          for (;;) {
            const epoch = Atomics.load(header, EPOCH);
            const result = take(maxBytes);
            if (result !== null) return result;
            await waitAsync(epoch);
          }
        } finally { pending = false; }
      },
    });
  }

  function enter(bytes) {
    if (pending) throw new BytePipeError("busy");
    const copy = validateWrite(bytes);
    pending = true;
    return copy;
  }
  return Object.freeze({
    ...common,
    end() {
      if (pending) throw new BytePipeError("busy");
      const previous = Atomics.compareExchange(header, STATE, OPEN, EOF);
      checkState(previous, true);
      if (previous !== OPEN) throw new BytePipeError("corrupt");
      notify();
    },
    writeSync(bytes) {
      const copy = enter(bytes);
      try {
        for (let offset = 0; offset < copy.length;) {
          const epoch = Atomics.load(header, EPOCH);
          const count = put(copy, offset);
          offset += count;
          if (count === 0) waitSync(epoch);
        }
      } finally { pending = false; }
    },
    async writeAsync(bytes) {
      const copy = enter(bytes);
      try {
        for (let offset = 0; offset < copy.length;) {
          const epoch = Atomics.load(header, EPOCH);
          const count = put(copy, offset);
          offset += count;
          if (count === 0) await waitAsync(epoch);
        }
      } finally { pending = false; }
    },
  });
}
