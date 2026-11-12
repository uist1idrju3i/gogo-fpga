import sys

from formal_process import SbyPopen, select_processes


for conversion, trace, mapping, output in [
    ("aiw2yw", "trace.aiw", "aiger-map.json", "aiger.yw"),
    ("wit2yw", "trace.wit", "btor-map.json", "btor.yw"),
]:
    process = SbyPopen(f"cd witness; yosys-witness {conversion} {trace} {mapping} {output}", logstderr=True)
    while process.poll() is None:
        ready, _, _ = select_processes([process.stdout], [], [], 0.01)
        for stream in ready:
            line = stream.readline()
            if line:
                sys.stdout.write(line.decode("utf-8"))
    while line := process.stdout.readline():
        sys.stdout.write(line.decode("utf-8"))
    if process.returncode != 0:
        raise SystemExit(process.returncode)
