import getopt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import runpy
import sys
import tempfile


MAX_BYTES = 8 * 1024 * 1024
MAX_SIGNALS = 4096
MAX_STEPS = 1024
OUTPUT = "formal-trace.json"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def relative_file(name):
    require(type(name) is str and 0 < len(name) <= 512 and not any(c in name for c in "\\\0:"),
            "Invalid trace file path")
    path = PurePosixPath(name)
    require(path.parts and not path.is_absolute() and name == path.as_posix()
            and all(part not in {".", ".."} for part in path.parts), "Unsafe trace file path")
    current = Path()
    for part in path.parts:
        current /= part
        require(not current.is_symlink(), "Symlink in trace file path")
    return current


def net_path(path):
    require(type(path) in (list, tuple) and 0 < len(path) <= 64
            and all(type(part) is str and 0 < len(part) <= 512 and "\0" not in part for part in path),
            "Invalid captured net path")
    return tuple(path)


def validate_args(args):
    require(type(args) is list and 0 < len(args) <= 64
            and all(type(arg) is str and len(arg) < 4096 and "\0" not in arg for arg in args),
            "Invalid trace entrypoint arguments")
    options, files = getopt.getopt(args, "s:t:m:icg", ["presat", "noprogress", "unroll", "noinfo",
        "dump-vcd=", "dump-yw=", "dump-vlogtb=", "smtc="])
    require(len(files) == 1, "Exactly one trace model required")
    model = relative_file(files[0])
    require(model.is_file() and model.as_posix() != OUTPUT, "Missing trace model")
    paths = {model.as_posix(), OUTPUT}
    for option, name in options:
        if option in {"--dump-vcd", "--dump-yw", "--dump-vlogtb", "--smtc"}:
            file = relative_file(name)
            require("%" not in name and name not in paths, "Duplicate or unsupported trace file path")
            require(file.is_file() if option == "--smtc" else not file.exists(),
                    "Missing trace constraints or existing trace output")
            paths.add(name)
    return model


def recording_writer(original, captures):
    class RecordingMkVcd(original):
        def __init__(self, stream):
            require(len(captures) < 64, "Captured trace count limit")
            self.capture_path = relative_file(stream.name).as_posix()
            require(self.capture_path != OUTPUT and self.capture_path not in {item.capture_path for item in captures},
                    "Duplicate or reserved captured trace path")
            self.frames = []
            self.capture_signals = {}
            self.capture_time = -1
            self.capture_bytes = 0
            super().__init__(stream)
            captures.append(self)

        def reserve(self, count):
            self.capture_bytes += count
            require(sum(item.capture_bytes for item in captures) <= MAX_BYTES, "Captured value byte limit")

        def add_net(self, path, width):
            path = net_path(path)
            require(self.capture_time == -1 and path not in self.capture_signals and type(width) is int and 0 < width <= 4096,
                    "Duplicate captured net or invalid width")
            require(len(self.capture_signals) < MAX_SIGNALS, "Captured signal count limit")
            self.reserve(sum(len(part) for part in path) + 64)
            self.capture_signals[path] = (width, None)
            super().add_net(path, width)

        def add_clock(self, path, edge):
            path = net_path(path)
            require(self.capture_time == -1 and path not in self.capture_signals and type(edge) is str and edge in {"posedge", "negedge", "event"},
                    "Duplicate captured clock or invalid edge")
            require(len(self.capture_signals) < MAX_SIGNALS, "Captured signal count limit")
            self.reserve(sum(len(part) for part in path) + 64)
            self.capture_signals[path] = (1, edge)
            super().add_clock(path, edge)

        def set_time(self, time):
            require(type(time) is int and 0 <= time <= MAX_STEPS and time >= self.capture_time, "Invalid captured time")
            if time != self.capture_time:
                self.frames.append({"time": time, "values": {}})
            self.capture_time = time
            super().set_time(time)

        def set_net(self, path, bits):
            path = net_path(path)
            require(self.frames and path in self.capture_signals and path not in self.frames[-1]["values"],
                    "Duplicate or unknown captured value")
            require(type(bits) is str and len(bits) == self.capture_signals[path][0] and set(bits) <= set("01"),
                    "Invalid captured bits")
            self.reserve(len(bits) + sum(len(part) for part in path) + 64)
            self.frames[-1]["values"][path] = bits
            super().set_net(path, bits)

        def snapshot(self):
            require(self.f.closed and len(self.frames) >= 2 and not self.frames[-1]["values"],
                    "Incomplete captured trace")
            require(all(frame["values"] for frame in self.frames[:-1]), "Empty captured trace sample")
            require(all(set(frame["values"]) == set(self.capture_signals) for frame in self.frames[:-1]),
                    "Missing captured signal sample")
            file = relative_file(self.capture_path)
            raw = file.read_bytes()
            require(len(raw) <= MAX_BYTES, "Captured VCD byte limit")
            return {
                "path": self.capture_path,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "signals": [{"path": list(path), "width": width, "clock": edge}
                            for path, (width, edge) in self.capture_signals.items()],
                "steps": [{"time": frame["time"], "values": [{"path": list(path), "bits": bits}
                           for path, bits in frame["values"].items()]} for frame in self.frames[:-1]],
                "endTime": self.frames[-1]["time"],
            }

    return RecordingMkVcd


def main(args):
    model = validate_args(args)
    model_hash = hashlib.sha256(model.read_bytes()).hexdigest()
    output = relative_file(OUTPUT)
    require(not output.exists(), "Captured trace output already exists")
    import smtio
    original = smtio.MkVcd
    captures = []
    saved_args = sys.argv
    try:
        smtio.MkVcd = recording_writer(original, captures)
        sys.argv = ["smtbmc", *args]
        try:
            runpy.run_path(str(Path(smtio.__file__).with_name("smtbmc.py")), run_name="__main__")
            code = 0
        except SystemExit as error:
            code = 0 if error.code is None else error.code
            require(type(code) is int and 0 <= code <= 255, "Invalid upstream trace exit code")
    finally:
        smtio.MkVcd = original
        sys.argv = saved_args
    require(hashlib.sha256(model.read_bytes()).hexdigest() == model_hash, "Trace model changed during execution")
    result = {"format_version": 1, "model": {"path": model.as_posix(), "sha256": model_hash},
              "upstreamExitCode": code, "traces": [capture.snapshot() for capture in captures]}
    raw = (json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    require(len(raw) <= MAX_BYTES, "Captured trace JSON byte limit")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=".", prefix=".formal-trace-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(raw)
        require(not output.exists() and not output.is_symlink(), "Captured trace output already exists")
        if sys.platform == "emscripten":
            temporary.rename(output)
        else:
            os.link(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
