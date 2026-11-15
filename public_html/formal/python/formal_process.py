from queue import Empty
from subprocess import PIPE, STDOUT, CalledProcessError
from _formal_host import spawn_solver
import hashlib
import json
import os
import shlex
import stat
import struct
import time


class SolverInput:
    def __init__(self, handle):
        self.handle = handle
        self.closed = False

    def write(self, data):
        if self.closed:
            raise ValueError("Write to closed virtual solver stdin")
        return self.handle.stdin_write(data)

    def flush(self):
        if self.closed:
            raise ValueError("Flush of closed virtual solver stdin")

    def close(self):
        if not self.closed:
            self.handle.stdin_close()
            self.closed = True


class Popen:
    def __init__(self, args, *, stdin, stdout, stderr):
        if stdin != PIPE or stdout != PIPE or stderr != STDOUT:
            raise ValueError("Unsupported virtual solver stdio configuration")
        self.handle = spawn_solver(args)
        self.stdin = SolverInput(self.handle)

    def terminate(self):
        self.handle.terminate()

    def wait(self):
        return self.handle.finish(True)

    def poll(self):
        return self.handle.poll()


def check_output(args, *, text=False):
    if type(text) is not bool:
        raise TypeError("Invalid virtual process text mode")
    handle = spawn_solver(args, False)
    output = bytearray()
    try:
        handle.stdin_close()
        while True:
            raw = bytes(handle.readline().to_py())
            if not raw:
                break
            output.extend(raw)
            if len(output) > 8 * 1024 * 1024:
                raise ValueError("Virtual process capture limit")
        code = handle.finish(True)
        result = bytes(output).decode("utf-8").replace("\r\n", "\n").replace("\r", "\n") if text else bytes(output)
        if code:
            raise CalledProcessError(code, args, output=result)
        return result
    except BaseException:
        handle.terminate()
        raise


class SolverQueue:
    def __init__(self, owner):
        self.owner = owner

    def get(self, block=True, timeout=None):
        value = self.owner.p.handle.readline(-1 if block and timeout is None else timeout if block else 0)
        if value is None:
            raise Empty
        raw = bytes(value.to_py())
        if not raw:
            self.owner.p_running = False
        return raw.decode("utf-8")

    def join(self):
        self.owner.p.handle.finish(True)
        self.owner.p_running = False


def workspace_path(path):
    return (isinstance(path, str) and 0 < len(path) <= 512 and
            "\\" not in path and "\0" not in path and
            all(part not in ("", ".", "..") for part in path.split("/")))


def apply_workspace_delta(frame, root="/work"):
    if not 4 <= len(frame) <= 4 + 33 * 1024 * 1024:
        raise ValueError("Invalid workspace delta frame")
    length, = struct.unpack_from("<I", frame)
    if length > 1024 * 1024 or 4 + length > len(frame):
        raise ValueError("Truncated workspace delta header")

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate workspace manifest key")
            result[key] = value
        return result

    manifest = json.loads(frame[4:4 + length].decode("utf-8"), object_pairs_hook=pairs)
    if (not isinstance(manifest, dict) or set(manifest) != {"version", "changes"} or
            type(manifest["version"]) is not int or manifest["version"] != 1 or
            not isinstance(manifest["changes"], list) or len(manifest["changes"]) > 4096):
        raise ValueError("Invalid workspace delta manifest")
    current = {}
    directories = set()
    total = 0
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            absolute = os.path.join(directory, name)
            mode = os.lstat(absolute).st_mode
            if stat.S_ISDIR(mode):
                directories.add(os.path.relpath(absolute, root))
                continue
            if not stat.S_ISREG(mode):
                raise ValueError("Unsupported workspace file type")
            path = os.path.relpath(absolute, root)
            if not workspace_path(path):
                raise ValueError("Invalid workspace file path")
            with open(absolute, "rb") as source:
                current[path] = source.read(32 * 1024 * 1024 + 1)
            total += len(current[path])
            if total > 32 * 1024 * 1024 or len(current) > 4096:
                raise ValueError("Workspace size limit")
    updated = dict(current)
    staged = []
    offset = 4 + length
    previous = ""
    for change in manifest["changes"]:
        if (not isinstance(change, dict) or set(change) != {"path", "beforeSha256", "afterSha256", "length"} or
                not workspace_path(change["path"]) or change["path"] <= previous or
                type(change["length"]) is not int or not 0 <= change["length"] <= 32 * 1024 * 1024):
            raise ValueError("Invalid workspace delta entry")
        path = change["path"]
        if path in directories:
            raise ValueError("Workspace delta targets an existing directory")
        previous = path
        before, after = change["beforeSha256"], change["afterSha256"]
        for digest in (before, after):
            if digest is not None and (not isinstance(digest, str) or len(digest) != 64 or
                                       any(char not in "0123456789abcdef" for char in digest)):
                raise ValueError("Invalid workspace delta hash")
        if (before is None and after is None) or (after is None and change["length"] != 0):
            raise ValueError("Invalid workspace delta deletion")
        existing = current.get(path)
        if (hashlib.sha256(existing).hexdigest() if existing is not None else None) != before:
            raise ValueError(f"Workspace delta conflict: {path}")
        end = offset + change["length"]
        if end > len(frame):
            raise ValueError("Truncated workspace delta payload")
        payload = frame[offset:end]
        if after is None:
            updated.pop(path, None)
        else:
            if hashlib.sha256(payload).hexdigest() != after:
                raise ValueError(f"Workspace delta hash mismatch: {path}")
            updated[path] = payload
        staged.append((path, payload if after is not None else None))
        offset = end
    if offset != len(frame):
        raise ValueError("Unexpected workspace delta bytes")
    if len(updated) > 4096 or sum(map(len, updated.values())) > 32 * 1024 * 1024:
        raise ValueError("Workspace size limit")
    for path in updated:
        components = path.split("/")
        if any("/".join(components[:index]) in updated for index in range(1, len(components))):
            raise ValueError("Conflicting workspace path")
    for path, payload in staged:
        absolute = os.path.join(root, path)
        if payload is None:
            os.unlink(absolute)
        else:
            os.makedirs(os.path.dirname(absolute), exist_ok=True)
            with open(absolute, "wb") as target:
                target.write(payload)


class ProcessOutput:
    def __init__(self, owner):
        self.owner = owner

    def readline(self):
        return bytes(self.owner.handle.readline().to_py())


class SbyPopen:
    def __init__(self, command, *, logstderr):
        from _formal_host import spawn_process
        if not logstderr:
            raise ValueError("Separate SBY stderr is not supported")
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>`$()")
        lexer.whitespace_split = True
        lexer.commenters = ""
        words = list(lexer)
        if (len(words) < 4 or words[0] != "cd" or words[2] != ";" or
                not workspace_path(words[1]) or words[3] not in ("yosys", "yosys-smtbmc", "yosys-witness") or
                any(any(char in word for char in ";&|<>`$()") for word in words[3:])):
            raise ValueError("Unsupported virtual SBY command")
        self.handle = spawn_process(words[3:], words[1])
        self.stdout = ProcessOutput(self)
        self.returncode = None
        self.applied = False
        self.frame = None

    def poll(self):
        code = self.handle.poll()
        if code is not None:
            if not self.applied:
                if self.frame is None:
                    self.frame = bytes(self.handle.take_delta().to_py())
                apply_workspace_delta(self.frame)
                self.applied = True
                self.frame = None
            self.returncode = code
        return code

    def terminate(self):
        self.handle.terminate()


def select_processes(readers, writers, errors, timeout):
    from _formal_host import pause
    if writers or errors:
        raise ValueError("Unsupported virtual select set")
    deadline = time.monotonic() + timeout
    while True:
        ready = [reader for reader in readers if reader.owner.handle.ready()]
        if ready or time.monotonic() >= deadline:
            return ready, [], []
        pause(min(10, max(0, (deadline - time.monotonic()) * 1000)))
