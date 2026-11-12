const ERRNO = Object.freeze({
  SUCCESS: 0,
  BADF: 8,
  EXIST: 20,
  FAULT: 21,
  FBIG: 22,
  INVAL: 28,
  ISDIR: 31,
  NOENT: 44,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTSUP: 58,
  SPIPE: 70,
  NOTCAPABLE: 76,
});

const FILETYPE = Object.freeze({
  UNKNOWN: 0,
  CHARACTER: 2,
  DIRECTORY: 3,
  REGULAR_FILE: 4,
});

const OFLAGS = Object.freeze({
  CREATE: 1,
  DIRECTORY: 2,
  EXCLUSIVE: 4,
  TRUNCATE: 8,
});

const FDFLAGS = Object.freeze({
  APPEND: 1,
});

const RIGHTS = Object.freeze({
  FD_READ: 1n << 1n,
  FD_SEEK: 1n << 2n,
  FD_FDSTAT_SET_FLAGS: 1n << 3n,
  FD_TELL: 1n << 5n,
  FD_WRITE: 1n << 6n,
  PATH_CREATE_DIRECTORY: 1n << 9n,
  PATH_CREATE_FILE: 1n << 10n,
  PATH_OPEN: 1n << 13n,
  FD_READDIR: 1n << 14n,
  PATH_READLINK: 1n << 15n,
  PATH_RENAME_SOURCE: 1n << 16n,
  PATH_RENAME_TARGET: 1n << 17n,
  PATH_FILESTAT_GET: 1n << 18n,
  PATH_FILESTAT_SET_SIZE: 1n << 19n,
  FD_FILESTAT_GET: 1n << 21n,
  FD_FILESTAT_SET_SIZE: 1n << 22n,
  FD_PREAD: 1n << 24n,
});

const SUPPORTED_RIGHTS = Object.values(RIGHTS).reduce(
  (all, right) => all | right,
  0n,
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class WasiExit extends Error {
  constructor(code) {
    super(`WASI process exited with code ${code}`);
    this.code = code;
  }
}

function wasiExitFrom(error) {
  if (error instanceof WasiExit) return error;
  if (
    error instanceof WebAssembly.Exception &&
    typeof WebAssembly.JSTag === "object" &&
    error.is(WebAssembly.JSTag)
  ) {
    const wrapped = error.getArg(WebAssembly.JSTag, 0);
    if (wrapped instanceof WasiExit) return wrapped;
  }
  return null;
}

function asBytes(value) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new TypeError("Memory tree files must be strings or Uint8Arrays");
}

function buildDirectory(name, tree, parent) {
  if (tree === null || typeof tree !== "object" || tree instanceof Uint8Array) {
    throw new TypeError("Memory tree directories must be objects");
  }
  const directory = { type: "directory", name, parent, entries: new Map() };
  for (const [childName, value] of Object.entries(tree)) {
    if (!childName || childName === "." || childName === ".." || childName.includes("/")) {
      throw new TypeError(`Invalid memory tree entry name: ${childName}`);
    }
    const child = value !== null && typeof value === "object" && !(value instanceof Uint8Array)
      ? buildDirectory(childName, value, directory)
      : { type: "file", name: childName, parent: directory, data: asBytes(value) };
    directory.entries.set(childName, child);
  }
  return directory;
}

export function createMemoryTree(tree) {
  return buildDirectory("/", tree, null);
}

export function setTreeEntry(tree, name, value) {
  Object.defineProperty(tree, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function treeToObject(directory) {
  if (directory?.type !== "directory") {
    throw new TypeError("Expected a memory tree directory");
  }
  const result = {};
  for (const [name, entry] of directory.entries) {
    setTreeEntry(result, name, entry.type === "directory"
      ? treeToObject(entry)
      : new Uint8Array(entry.data));
  }
  return result;
}

function pathSegments(path) {
  if (path.includes("\0")) return null;
  return path.split("/").filter((segment) => segment && segment !== ".");
}

function nodePath(node) {
  const names = [];
  for (let current = node; current?.parent; current = current.parent) {
    names.push(current.name);
  }
  return `/${names.reverse().join("/")}`;
}

export function createWasiP1ImportObject({
  args = [],
  env = {},
  preopens = {},
  workingDirectory = null,
  stdin = () => new Uint8Array(),
  stdout = () => {},
  stderr = () => {},
  clockTime = null,
  onPollOneoff = () => {},
} = {}) {
  if (typeof stdin !== "function") throw new TypeError("stdin must be a synchronous byte reader");
  const encoderOut = encoder;
  let instance;
  let exitCode = 0;
  const descriptors = new Map();
  const preopenDescriptors = new Map();
  let nextFd = 3;
  const stdio = [
    { kind: "stdin", rights: RIGHTS.FD_READ, position: 0n, closed: false },
    { kind: "stdout", rights: RIGHTS.FD_WRITE, position: 0n, closed: false },
    { kind: "stderr", rights: RIGHTS.FD_WRITE, position: 0n, closed: false },
  ];
  stdio.forEach((descriptor, fd) => descriptors.set(fd, descriptor));

  if (workingDirectory !== null) {
    let parent = workingDirectory;
    const visited = new Set();
    while (parent && parent !== preopens["/"] && !visited.has(parent)) {
      visited.add(parent);
      parent = parent.parent;
    }
    if (!parent || workingDirectory.type !== "directory" || Object.hasOwn(preopens, ".")) {
      throw new TypeError("Working directory must be within the root preopen");
    }
    if (visited.has(parent)) throw new TypeError("Working directory has a cyclic parent");
    preopens = { ...preopens, ".": workingDirectory };
  }

  for (const [mountPath, directory] of Object.entries(preopens)) {
    if (directory?.type !== "directory") {
      throw new TypeError(`Preopen ${mountPath} must be a memory tree directory`);
    }
    const fd = nextFd++;
    const descriptor = {
      kind: "directory",
      node: directory,
      capabilityRoot: mountPath === "." && workingDirectory !== null ? preopens["/"] : directory,
      position: 0n,
      flags: 0,
      rights: SUPPORTED_RIGHTS,
      inheriting: SUPPORTED_RIGHTS,
      preopenPath: mountPath,
      closed: false,
    };
    descriptors.set(fd, descriptor);
    preopenDescriptors.set(fd, descriptor);
  }

  function memory() {
    if (!instance?.exports?.memory) {
      throw new Error("WASI module must export its memory");
    }
    return instance.exports.memory;
  }

  function view() {
    return new DataView(memory().buffer);
  }

  function inBounds(pointer, length) {
    return Number.isInteger(pointer) &&
      Number.isInteger(length) &&
      pointer >= 0 &&
      length >= 0 &&
      pointer + length <= memory().buffer.byteLength;
  }

  function writeU32(pointer, value) {
    if (!inBounds(pointer, 4)) return false;
    view().setUint32(pointer, value >>> 0, true);
    return true;
  }

  function readU32(pointer) {
    if (!inBounds(pointer, 4)) return null;
    return view().getUint32(pointer, true);
  }

  function readU64(pointer) {
    if (!inBounds(pointer, 8)) return null;
    return view().getBigUint64(pointer, true);
  }

  function writeU64(pointer, value) {
    if (!inBounds(pointer, 8)) return false;
    view().setBigUint64(pointer, BigInt.asUintN(64, value), true);
    return true;
  }

  function readString(pointer, length) {
    if (!inBounds(pointer, length)) return null;
    return decoder.decode(new Uint8Array(memory().buffer, pointer, length));
  }

  function writeBytes(pointer, bytes) {
    if (!inBounds(pointer, bytes.byteLength)) return false;
    new Uint8Array(memory().buffer, pointer, bytes.byteLength).set(bytes);
    return true;
  }

  function getDescriptor(fd) {
    const descriptor = descriptors.get(fd);
    return descriptor && !descriptor.closed ? descriptor : null;
  }

  function requireDescriptor(fd, type) {
    const descriptor = getDescriptor(fd);
    if (!descriptor) return { errno: ERRNO.BADF };
    if (type && descriptor.kind !== type) return { errno: ERRNO.NOTDIR };
    return { descriptor, errno: ERRNO.SUCCESS };
  }

  function allowRights(base, inheriting) {
    return ((base | inheriting) & ~SUPPORTED_RIGHTS) === 0n;
  }

  function resolveParent(directory, path, capabilityRoot = directory) {
    const segments = pathSegments(path);
    if (!segments) return { errno: ERRNO.INVAL };
    if (segments.length === 0) return { errno: ERRNO.INVAL };
    let current = directory;
    for (const segment of segments.slice(0, -1)) {
      if (current.type !== "directory") return { errno: ERRNO.NOTDIR };
      if (segment === "..") {
        if (current === capabilityRoot || !current.parent) {
          return { errno: ERRNO.NOTCAPABLE };
        }
        current = current.parent;
        continue;
      }
      const child = current.entries.get(segment);
      if (!child) return { errno: ERRNO.NOENT };
      if (child.type !== "directory") return { errno: ERRNO.NOTDIR };
      current = child;
    }
    const finalName = segments.at(-1);
    if (finalName === "..") return { errno: ERRNO.NOTCAPABLE };
    return { parent: current, name: finalName, errno: ERRNO.SUCCESS };
  }

  function resolveNode(directory, path, capabilityRoot = directory) {
    const segments = pathSegments(path);
    if (!segments) return { errno: ERRNO.INVAL };
    let current = directory;
    for (const segment of segments) {
      if (current.type !== "directory") return { errno: ERRNO.NOTDIR };
      if (segment === "..") {
        if (current === capabilityRoot || !current.parent) {
          return { errno: ERRNO.NOTCAPABLE };
        }
        current = current.parent;
        continue;
      }
      current = current.entries.get(segment);
      if (!current) return { errno: ERRNO.NOENT };
    }
    return { node: current, errno: ERRNO.SUCCESS };
  }

  function pathFromMemory(pointer, length) {
    const path = readString(pointer, length);
    return path === null ? { path: null, errno: ERRNO.FAULT } : { path, errno: ERRNO.SUCCESS };
  }

  function copyIovecs(fd, iovsPointer, iovsLength, bufferUsedPointer, writing, offset = null) {
    if (!inBounds(iovsPointer, iovsLength * 8) || !inBounds(bufferUsedPointer, 4)) {
      return ERRNO.FAULT;
    }
    const { descriptor, errno } = requireDescriptor(fd);
    if (errno !== ERRNO.SUCCESS) return errno;
    if (writing) {
      if (descriptor.kind === "directory") return ERRNO.ISDIR;
      if (descriptor.kind === "stdin" || !(descriptor.rights & RIGHTS.FD_WRITE)) {
        return ERRNO.NOTCAPABLE;
      }
    } else {
      if (descriptor.kind === "directory") return ERRNO.ISDIR;
      if (descriptor.kind !== "stdin" && !(descriptor.rights & (offset === null ? RIGHTS.FD_READ : RIGHTS.FD_PREAD))) {
        return ERRNO.NOTCAPABLE;
      }
    }

    let total = 0;
    let fileOffset = offset === null ? descriptor.position : BigInt(offset);
    for (let index = 0; index < iovsLength; index += 1) {
      const base = readU32(iovsPointer + index * 8);
      const length = readU32(iovsPointer + index * 8 + 4);
      if (base === null || length === null || !inBounds(base, length)) return ERRNO.FAULT;
      if (writing) {
        const bytes = new Uint8Array(memory().buffer, base, length);
        if (descriptor.kind === "stdout" || descriptor.kind === "stderr") {
          (descriptor.kind === "stdout" ? stdout : stderr)(new Uint8Array(bytes));
        } else {
          const file = descriptor.node;
          if (descriptor.flags & FDFLAGS.APPEND) fileOffset = BigInt(file.data.byteLength);
          const start = Number(fileOffset);
          const end = start + length;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return ERRNO.FBIG;
          if (end > file.data.byteLength) {
            const grown = new Uint8Array(end);
            grown.set(file.data);
            file.data = grown;
          }
          file.data.set(bytes, start);
          fileOffset = BigInt(end);
        }
        total += length;
      } else {
        let bytes;
        if (descriptor.kind === "stdin") {
          bytes = length === 0 ? new Uint8Array() : stdin(length);
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > length) {
            throw new TypeError("stdin must return at most the requested bytes as Uint8Array");
          }
        } else {
          const start = Number(fileOffset);
          if (!Number.isSafeInteger(start)) return ERRNO.FBIG;
          const end = Math.min(descriptor.node.data.byteLength, start + length);
          bytes = start >= descriptor.node.data.byteLength
            ? new Uint8Array()
            : descriptor.node.data.subarray(start, end);
        }
        new Uint8Array(memory().buffer, base, bytes.byteLength).set(bytes);
        total += bytes.byteLength;
        fileOffset += BigInt(bytes.byteLength);
        if (bytes.byteLength < length) break;
      }
    }
    if (offset === null) descriptor.position = fileOffset;
    writeU32(bufferUsedPointer, total);
    return ERRNO.SUCCESS;
  }

  function statNode(node) {
    const output = new Uint8Array(64);
    const data = new DataView(output.buffer);
    data.setBigUint64(8, BigInt(node.inode ?? 1), true);
    data.setUint8(16, node.type === "directory" ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
    data.setBigUint64(24, 1n, true);
    data.setBigUint64(32, BigInt(node.type === "file" ? node.data.byteLength : 0), true);
    return output;
  }

  function fdStat(descriptor) {
    const output = new Uint8Array(24);
    const data = new DataView(output.buffer);
    data.setUint8(
      0,
      descriptor.kind === "directory"
        ? FILETYPE.DIRECTORY
        : descriptor.kind === "file"
          ? FILETYPE.REGULAR_FILE
          : FILETYPE.CHARACTER,
    );
    data.setUint16(2, descriptor.flags ?? 0, true);
    data.setBigUint64(8, descriptor.rights ?? 0n, true);
    data.setBigUint64(16, descriptor.inheriting ?? 0n, true);
    return output;
  }

  function allocateDescriptor(descriptor) {
    while (descriptors.has(nextFd)) nextFd += 1;
    const fd = nextFd++;
    descriptors.set(fd, descriptor);
    return fd;
  }

  const imports = {
    args_sizes_get(argcPointer, argvBufSizePointer) {
      if (!writeU32(argcPointer, args.length)) return ERRNO.FAULT;
      const size = args.reduce((total, argument) => total + encoderOut.encode(argument).byteLength + 1, 0);
      return writeU32(argvBufSizePointer, size) ? ERRNO.SUCCESS : ERRNO.FAULT;
    },
    args_get(argvPointer, argvBufferPointer) {
      if (!inBounds(argvPointer, args.length * 4)) return ERRNO.FAULT;
      let cursor = argvBufferPointer;
      for (let index = 0; index < args.length; index += 1) {
        const bytes = encoderOut.encode(args[index]);
        if (!writeU32(argvPointer + index * 4, cursor) || !writeBytes(cursor, bytes) || !writeBytes(cursor + bytes.byteLength, new Uint8Array([0]))) {
          return ERRNO.FAULT;
        }
        cursor += bytes.byteLength + 1;
      }
      return ERRNO.SUCCESS;
    },
    environ_sizes_get(countPointer, bufferSizePointer) {
      const entries = Object.entries(env).map(([key, value]) => `${key}=${value}`);
      if (!writeU32(countPointer, entries.length)) return ERRNO.FAULT;
      const size = entries.reduce((total, entry) => total + encoderOut.encode(entry).byteLength + 1, 0);
      return writeU32(bufferSizePointer, size) ? ERRNO.SUCCESS : ERRNO.FAULT;
    },
    environ_get(entriesPointer, bufferPointer) {
      const entries = Object.entries(env).map(([key, value]) => `${key}=${value}`);
      if (!inBounds(entriesPointer, entries.length * 4)) return ERRNO.FAULT;
      let cursor = bufferPointer;
      for (let index = 0; index < entries.length; index += 1) {
        const bytes = encoderOut.encode(entries[index]);
        if (!writeU32(entriesPointer + index * 4, cursor) || !writeBytes(cursor, bytes) || !writeBytes(cursor + bytes.byteLength, new Uint8Array([0]))) {
          return ERRNO.FAULT;
        }
        cursor += bytes.byteLength + 1;
      }
      return ERRNO.SUCCESS;
    },
    clock_time_get(clockId, _precision, timePointer) {
      if (!inBounds(timePointer, 8)) return ERRNO.FAULT;
      if (clockId > 3) return ERRNO.INVAL;
      const now = clockTime
        ? BigInt(clockTime(clockId))
        : clockId === 1
        ? BigInt(Math.floor(performance.now() * 1_000_000))
        : BigInt(Date.now()) * 1_000_000n;
      return writeU64(timePointer, now) ? ERRNO.SUCCESS : ERRNO.FAULT;
    },
    poll_oneoff(_subscriptionsPointer, _eventsPointer, subscriptionCount, eventCountPointer) {
      onPollOneoff();
      if (!inBounds(eventCountPointer, 4)) return ERRNO.FAULT;
      if (subscriptionCount === 0) return ERRNO.INVAL;
      return ERRNO.NOSYS;
    },
    fd_close(fd) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      descriptor.closed = true;
      descriptors.delete(fd);
      preopenDescriptors.delete(fd);
      return ERRNO.SUCCESS;
    },
    fd_fdstat_get(fd, outputPointer) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      return writeBytes(outputPointer, fdStat(descriptor)) ? ERRNO.SUCCESS : ERRNO.FAULT;
    },
    fd_fdstat_set_flags(fd, flags) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      if (flags & ~FDFLAGS.APPEND) return ERRNO.NOTSUP;
      if (descriptor.kind !== "file") return flags ? ERRNO.NOTSUP : ERRNO.SUCCESS;
      descriptor.flags = flags;
      return ERRNO.SUCCESS;
    },
    fd_filestat_get(fd, outputPointer) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      const node = descriptor.node ?? { type: "file", data: new Uint8Array() };
      return writeBytes(outputPointer, statNode(node)) ? ERRNO.SUCCESS : ERRNO.FAULT;
    },
    fd_filestat_set_size(fd, size) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== "file") return descriptor.kind === "directory" ? ERRNO.ISDIR : ERRNO.NOTSUP;
      if (!(descriptor.rights & RIGHTS.FD_FILESTAT_SET_SIZE)) return ERRNO.NOTCAPABLE;
      const newSize = Number(size);
      if (newSize < 0 || !Number.isSafeInteger(newSize)) return ERRNO.FBIG;
      const grown = new Uint8Array(newSize);
      grown.set(descriptor.node.data.subarray(0, newSize));
      descriptor.node.data = grown;
      return ERRNO.SUCCESS;
    },
    fd_pread(fd, iovsPointer, iovsLength, offset, bufferUsedPointer) {
      return copyIovecs(fd, iovsPointer, iovsLength, bufferUsedPointer, false, offset);
    },
    fd_prestat_dir_name(fd, pathPointer, pathLength) {
      const descriptor = preopenDescriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      const bytes = encoderOut.encode(descriptor.preopenPath);
      if (pathLength < bytes.byteLength) return ERRNO.INVAL;
      return writeBytes(pathPointer, bytes) ? ERRNO.SUCCESS : ERRNO.FAULT;
    },
    fd_prestat_get(fd, outputPointer) {
      const descriptor = preopenDescriptors.get(fd);
      if (!descriptor) return ERRNO.BADF;
      if (!inBounds(outputPointer, 8)) return ERRNO.FAULT;
      const data = new DataView(memory().buffer);
      data.setUint8(outputPointer, 0);
      data.setUint32(outputPointer + 4, encoderOut.encode(descriptor.preopenPath).byteLength, true);
      return ERRNO.SUCCESS;
    },
    fd_read(fd, iovsPointer, iovsLength, bufferUsedPointer) {
      return copyIovecs(fd, iovsPointer, iovsLength, bufferUsedPointer, false);
    },
    fd_readdir(fd, bufferPointer, bufferLength, cookie, bufferUsedPointer) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== "directory") return ERRNO.NOTDIR;
      if (!inBounds(bufferPointer, bufferLength) || !inBounds(bufferUsedPointer, 4)) return ERRNO.FAULT;
      const entries = [
        { name: ".", node: descriptor.node },
        { name: "..", node: descriptor.node.parent ?? descriptor.node },
        ...[...descriptor.node.entries.values()]
          .sort((left, right) => left.name.localeCompare(right.name, "en"))
          .map((node) => ({ name: node.name, node })),
      ];
      let used = 0;
      const start = Number(cookie);
      if (!Number.isSafeInteger(start) || start < 0) return ERRNO.INVAL;
      for (let index = start; index < entries.length; index += 1) {
        const entry = entries[index];
        const nameBytes = encoderOut.encode(entry.name);
        const entrySize = 24 + nameBytes.byteLength;
        if (used + entrySize > bufferLength) break;
        const pointer = bufferPointer + used;
        if (!inBounds(pointer, entrySize)) return ERRNO.FAULT;
        const data = new DataView(memory().buffer);
        data.setBigUint64(pointer, BigInt(index + 1), true);
        data.setBigUint64(pointer + 8, BigInt(index + 1), true);
        data.setUint32(pointer + 16, nameBytes.byteLength, true);
        data.setUint8(pointer + 20, entry.node.type === "directory" ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
        new Uint8Array(memory().buffer, pointer + 24, nameBytes.byteLength).set(nameBytes);
        used += entrySize;
      }
      return writeU32(bufferUsedPointer, used) ? ERRNO.SUCCESS : ERRNO.FAULT;
    },
    fd_renumber(fromFd, toFd) {
      const source = getDescriptor(fromFd);
      if (!source) return ERRNO.BADF;
      if (fromFd === toFd) return ERRNO.SUCCESS;
      const target = getDescriptor(toFd);
      if (target) {
        target.closed = true;
        descriptors.delete(toFd);
        preopenDescriptors.delete(toFd);
      }
      descriptors.delete(fromFd);
      preopenDescriptors.delete(fromFd);
      descriptors.set(toFd, source);
      if (source.preopenPath !== undefined) preopenDescriptors.set(toFd, source);
      return ERRNO.SUCCESS;
    },
    fd_seek(fd, offset, whence, newOffsetPointer) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== "file") return descriptor.kind === "directory" ? ERRNO.ISDIR : ERRNO.SPIPE;
      if (!(descriptor.rights & RIGHTS.FD_SEEK)) return ERRNO.NOTCAPABLE;
      const signedOffset = BigInt.asIntN(64, offset);
      let base;
      if (whence === 0) base = 0n;
      else if (whence === 1) base = descriptor.position;
      else if (whence === 2) base = BigInt(descriptor.node.data.byteLength);
      else return ERRNO.INVAL;
      const next = base + signedOffset;
      if (next < 0n || next > BigInt(Number.MAX_SAFE_INTEGER)) return ERRNO.INVAL;
      descriptor.position = next;
      return writeU64(newOffsetPointer, next) ? ERRNO.SUCCESS : ERRNO.FAULT;
    },
    fd_write(fd, iovsPointer, iovsLength, bufferUsedPointer) {
      return copyIovecs(fd, iovsPointer, iovsLength, bufferUsedPointer, true);
    },
    path_create_directory(fd, pathPointer, pathLength) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== "directory") return ERRNO.NOTDIR;
      if (!(descriptor.rights & RIGHTS.PATH_CREATE_DIRECTORY)) return ERRNO.NOTCAPABLE;
      const path = pathFromMemory(pathPointer, pathLength);
      if (path.errno) return path.errno;
      const resolved = resolveParent(descriptor.node, path.path, descriptor.capabilityRoot);
      if (resolved.errno) return resolved.errno;
      if (resolved.parent.entries.has(resolved.name)) return ERRNO.EXIST;
      const directory = { type: "directory", name: resolved.name, parent: resolved.parent, entries: new Map() };
      resolved.parent.entries.set(resolved.name, directory);
      return ERRNO.SUCCESS;
    },
    path_filestat_get(fd, lookupFlags, pathPointer, pathLength, outputPointer) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== "directory") return ERRNO.NOTDIR;
      if (lookupFlags & ~1) return ERRNO.NOTSUP;
      if (!(descriptor.rights & RIGHTS.PATH_FILESTAT_GET)) return ERRNO.NOTCAPABLE;
      const path = pathFromMemory(pathPointer, pathLength);
      if (path.errno) return path.errno;
      const resolved = resolveNode(descriptor.node, path.path, descriptor.capabilityRoot);
      if (resolved.errno) return resolved.errno;
      return writeBytes(outputPointer, statNode(resolved.node)) ? ERRNO.SUCCESS : ERRNO.FAULT;
    },
    path_open(fd, lookupFlags, pathPointer, pathLength, oflags, rightsBase, rightsInheriting, fdflags, openedFdPointer) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== "directory") return ERRNO.NOTDIR;
      if (lookupFlags & ~1) return ERRNO.NOTSUP;
      if (oflags & ~(OFLAGS.CREATE | OFLAGS.DIRECTORY | OFLAGS.EXCLUSIVE | OFLAGS.TRUNCATE)) return ERRNO.NOTSUP;
      if (fdflags & ~FDFLAGS.APPEND) return ERRNO.NOTSUP;
      if (!(descriptor.rights & RIGHTS.PATH_OPEN)) return ERRNO.NOTCAPABLE;
      if (!allowRights(rightsBase, rightsInheriting)) return ERRNO.NOTSUP;
      const path = pathFromMemory(pathPointer, pathLength);
      if (path.errno) return path.errno;
      const resolved = resolveParent(descriptor.node, path.path, descriptor.capabilityRoot);
      if (resolved.errno) return resolved.errno;
      let node = resolved.parent.entries.get(resolved.name);
      if (node && (oflags & OFLAGS.CREATE) && (oflags & OFLAGS.EXCLUSIVE)) return ERRNO.EXIST;
      if (!node) {
        if (!(oflags & OFLAGS.CREATE)) return ERRNO.NOENT;
        if (!(descriptor.rights & RIGHTS.PATH_CREATE_FILE)) return ERRNO.NOTCAPABLE;
        node = { type: "file", name: resolved.name, parent: resolved.parent, data: new Uint8Array() };
        resolved.parent.entries.set(resolved.name, node);
      }
      if ((oflags & OFLAGS.DIRECTORY) && node.type !== "directory") return ERRNO.NOTDIR;
      if (node.type === "file" && (oflags & OFLAGS.TRUNCATE)) {
        if (!(rightsBase & RIGHTS.FD_WRITE)) return ERRNO.NOTCAPABLE;
        node.data = new Uint8Array();
      }
      const opened = node.type === "directory"
        ? {
            kind: "directory",
            node,
            capabilityRoot: descriptor.capabilityRoot,
            position: 0n,
            flags: fdflags,
            rights: rightsBase,
            inheriting: rightsInheriting,
            closed: false,
          }
        : {
            kind: "file",
            node,
            capabilityRoot: descriptor.capabilityRoot,
            position: 0n,
            flags: fdflags,
            rights: rightsBase,
            inheriting: rightsInheriting,
            closed: false,
          };
      const newFd = allocateDescriptor(opened);
      return writeU32(openedFdPointer, newFd) ? ERRNO.SUCCESS : ERRNO.FAULT;
    },
    path_readlink(_fd, _pathPointer, _pathLength, _bufferPointer, _bufferLength, _usedPointer) {
      return ERRNO.NOTSUP;
    },
    path_remove_directory(fd, pathPointer, pathLength) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== "directory") return ERRNO.NOTDIR;
      const path = pathFromMemory(pathPointer, pathLength);
      if (path.errno) return path.errno;
      const resolved = resolveParent(descriptor.node, path.path, descriptor.capabilityRoot);
      if (resolved.errno) return resolved.errno;
      const node = resolved.parent.entries.get(resolved.name);
      if (!node) return ERRNO.NOENT;
      if (node.type !== "directory") return ERRNO.NOTDIR;
      if (node.entries.size > 0) return ERRNO.NOTEMPTY;
      resolved.parent.entries.delete(resolved.name);
      return ERRNO.SUCCESS;
    },
    path_rename(oldFd, oldPathPointer, oldPathLength, newFd, newPathPointer, newPathLength) {
      const oldDescriptor = getDescriptor(oldFd);
      const newDescriptor = getDescriptor(newFd);
      if (!oldDescriptor || !newDescriptor) return ERRNO.BADF;
      if (oldDescriptor.kind !== "directory" || newDescriptor.kind !== "directory") return ERRNO.NOTDIR;
      if (!(oldDescriptor.rights & RIGHTS.PATH_RENAME_SOURCE) || !(newDescriptor.rights & RIGHTS.PATH_RENAME_TARGET)) return ERRNO.NOTCAPABLE;
      const oldPath = pathFromMemory(oldPathPointer, oldPathLength);
      const newPath = pathFromMemory(newPathPointer, newPathLength);
      if (oldPath.errno) return oldPath.errno;
      if (newPath.errno) return newPath.errno;
      const source = resolveParent(oldDescriptor.node, oldPath.path, oldDescriptor.capabilityRoot);
      const target = resolveParent(newDescriptor.node, newPath.path, newDescriptor.capabilityRoot);
      if (source.errno) return source.errno;
      if (target.errno) return target.errno;
      const node = source.parent.entries.get(source.name);
      if (!node) return ERRNO.NOENT;
      if (node.type === "directory") {
        for (let current = target.parent; current; current = current.parent) {
          if (current === node) return ERRNO.INVAL;
        }
      }
      const existing = target.parent.entries.get(target.name);
      if (existing) {
        if (existing.type === "directory" && existing.entries.size > 0) return ERRNO.NOTEMPTY;
        if (existing.type !== node.type) return existing.type === "directory" ? ERRNO.ISDIR : ERRNO.NOTDIR;
      }
      target.parent.entries.delete(target.name);
      source.parent.entries.delete(source.name);
      node.name = target.name;
      node.parent = target.parent;
      target.parent.entries.set(target.name, node);
      return ERRNO.SUCCESS;
    },
    path_unlink_file(fd, pathPointer, pathLength) {
      const descriptor = getDescriptor(fd);
      if (!descriptor) return ERRNO.BADF;
      if (descriptor.kind !== "directory") return ERRNO.NOTDIR;
      const path = pathFromMemory(pathPointer, pathLength);
      if (path.errno) return path.errno;
      const resolved = resolveParent(descriptor.node, path.path, descriptor.capabilityRoot);
      if (resolved.errno) return resolved.errno;
      const node = resolved.parent.entries.get(resolved.name);
      if (!node) return ERRNO.NOENT;
      if (node.type === "directory") return ERRNO.ISDIR;
      resolved.parent.entries.delete(resolved.name);
      return ERRNO.SUCCESS;
    },
    proc_exit(code) {
      throw new WasiExit(code);
    },
    sched_yield() {
      // This profile has only one guest thread to schedule.
      return ERRNO.SUCCESS;
    },
    random_get(pointer, length) {
      if (!inBounds(pointer, length)) return ERRNO.FAULT;
      if (typeof globalThis.crypto?.getRandomValues !== "function") return ERRNO.NOSYS;
      const output = new Uint8Array(memory().buffer, pointer, length);
      for (let offset = 0; offset < length; offset += 65_536) {
        globalThis.crypto.getRandomValues(output.subarray(offset, Math.min(length, offset + 65_536)));
      }
      return ERRNO.SUCCESS;
    },
  };

  const importObject = { wasi_snapshot_preview1: imports };
  return {
    importObject,
    initialize(nextInstance) {
      instance = nextInstance;
    },
    start() {
      try {
        instance.exports._start();
      } catch (error) {
        const exit = wasiExitFrom(error);
        if (exit) {
          exitCode = exit.code;
        } else if (error instanceof WebAssembly.Exception) {
          exitCode = 1;
        } else {
          throw error;
        }
      }
      return { exitCode, memoryBytes: instance.exports.memory.buffer.byteLength };
    },
  };
}

export function runWasiP1(module, options = {}) {
  const wasi = createWasiP1ImportObject(options);
  const instance = new WebAssembly.Instance(module, wasi.importObject);
  wasi.initialize(instance);
  return wasi.start();
}
