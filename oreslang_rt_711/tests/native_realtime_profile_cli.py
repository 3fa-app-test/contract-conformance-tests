#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys
import tempfile

def run(argv):
    return subprocess.run(argv, text=True, capture_output=True)

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def main():
    if len(sys.argv) != 2:
        raise RuntimeError("usage: native_realtime_profile_cli.py <compiler>")
    compiler = sys.argv[1]
    with tempfile.TemporaryDirectory() as td:
        root = pathlib.Path(td)
        pure = root / "pure.ores"
        pure.write_text(
            "fnc helper(): int { return 41; }\n"
            "fnc main(): int { return helper(); }\n"
        )
        result = run([compiler, "--rt-check", str(pure)])
        require(result.returncode == 0, result.stderr)
        report = json.loads(result.stdout)
        require(report["source_admitted"] is True, "pure source must admit")
        require(report["artifact_certified"] is False,
                "compiler check must not certify linked artifact")
        require(report["reachable_functions"] == 2,
                "transitive reachable count")

        report_path = root / "report.json"
        result = run([
            compiler,
            "--profile=native-hard-rt",
            f"--rt-report={report_path}",
            str(pure),
        ])
        require(result.returncode == 0, result.stderr)
        require("define" in result.stdout,
                "admitted profile must still emit LLVM IR")
        persisted = json.loads(report_path.read_text())
        require(persisted["diagnostic"] == "OK", "persisted report")

        io = root / "io.ores"
        io.write_text(
            "fnc io_capable(): int using io { return 1; }\n"
            "fnc main(): int { return io_capable(); }\n"
        )
        result = run([compiler, "--rt-check", str(io)])
        require(result.returncode == 1, "declared IO must reject")
        report = json.loads(result.stdout)
        require(report["source_admitted"] is False, "IO report admission")
        require(report["diagnostic"] != "OK", "IO diagnostic")

        recursive = root / "recursive.ores"
        recursive.write_text(
            "fnc bounce(): int { return bounce(); }\n"
            "fnc main(): int { return bounce(); }\n"
        )
        result = run([compiler, "--rt-check", str(recursive)])
        require(result.returncode == 1, "recursive graph must reject")
        report = json.loads(result.stdout)
        require(report["diagnostic"] == "RT008_UNBOUNDED_LOOP",
                "recursion diagnostic")

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
