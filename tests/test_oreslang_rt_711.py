import hashlib
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIRROR = ROOT / "oreslang_rt_711"

EXPECTED = {
    "src/main/cpp/oreslang/runtime/RealtimeActorArena.h": "e4e0a423638aae4f3290d7d4f38917d1cd6b6725",
    "src/main/cpp/oreslang/runtime/RealtimeActorArena.c": "1ce0884e85141965c56f2893282918044417b49e",
    "src/main/cpp/oreslang/types/RealtimeAnalysis.hpp": "936a47a23e375d90e31080b2e4f80698b32e105c",
    "src/main/cpp/oreslang/types/FunctionEffects.hpp": "fc7c86965ff8278b405335a47526f79c03f3c4a4",
    "src/main/cpp/oreslang/frontend/Parser.hpp": "75254dc4343e212bd3b31b6de4785d93d6a56e91",
    "tests/realtime_actor_arena_test.cpp": "8ce564b4e2c2286fbbb4aa3563026aec80d4f30b",
    "tests/realtime_analysis_test.cpp": "5710473e35ec0b998779b81ed8fd92edf9b66643",
    "tests/native_realtime_profile_cli.py": "09d024e6f34d634d44681242b81d20803b7903c1",
    "src/main/cpp/oreslang/main.cpp": "8c35ddd92a69a53d64770705f5039eb573ed6a55"
}

def blob_sha(path):
    data = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()

class NativeHardRealtime711(unittest.TestCase):
    def test_exact_source_blobs(self):
        for rel, expected in EXPECTED.items():
            path = MIRROR / rel
            self.assertTrue(path.exists(), rel)
            self.assertEqual(expected, blob_sha(path), rel)

    def test_strict_arena_compiles_runs_and_has_no_allocator_or_lock_symbols(self):
        cc = shutil.which("cc")
        cxx = shutil.which("g++") or shutil.which("c++")
        nm = shutil.which("nm")
        self.assertIsNotNone(cc)
        self.assertIsNotNone(cxx)
        self.assertIsNotNone(nm)
        with tempfile.TemporaryDirectory() as td:
            td = pathlib.Path(td)
            obj = td / "arena.o"
            exe = td / "arena-test"
            subprocess.run([
                cc, "-std=c11", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror",
                "-I" + str(MIRROR / "src/main/cpp"),
                "-c", str(MIRROR / "src/main/cpp/oreslang/runtime/RealtimeActorArena.c"),
                "-o", str(obj),
            ], check=True)
            undefined = subprocess.run(
                [nm, "-u", str(obj)], text=True, capture_output=True, check=True
            ).stdout
            symbols = {
                line.split()[-1]
                for line in undefined.splitlines()
                if line.strip()
            }
            self.assertLessEqual(
                symbols,
                {"_GLOBAL_OFFSET_TABLE_"},
                "strict arena gained a callable/runtime import: " + undefined,
            )
            subprocess.run([
                cxx, "-std=c++17", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror",
                "-I" + str(MIRROR / "src/main/cpp"),
                str(MIRROR / "tests/realtime_actor_arena_test.cpp"),
                str(obj), "-o", str(exe),
            ], check=True)
            subprocess.run([str(exe)], check=True)

    def test_transitive_analysis_compiles_and_runs(self):
        cxx = shutil.which("g++") or shutil.which("c++")
        self.assertIsNotNone(cxx)
        with tempfile.TemporaryDirectory() as td:
            exe = pathlib.Path(td) / "analysis-test"
            subprocess.run([
                cxx, "-std=c++17", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror",
                "-I" + str(MIRROR / "src/main/cpp"),
                str(MIRROR / "tests/realtime_analysis_test.cpp"),
                "-o", str(exe),
            ], check=True)
            subprocess.run([str(exe)], check=True)

    def test_cli_wiring_and_harness_are_present(self):
        main = (MIRROR / "src/main/cpp/oreslang/main.cpp").read_text()
        for token in (
            "--profile=native-hard-rt",
            "--rt-check",
            "--rt-entry=",
            "--rt-report=",
            "analyze_native_hard_rt",
            "rt_report_path == path",
            "compiler-admission-only",
        ):
            if token == "compiler-admission-only":
                analysis = (MIRROR / "src/main/cpp/oreslang/types/RealtimeAnalysis.hpp").read_text()
                self.assertIn(token, analysis)
            else:
                self.assertIn(token, main)
        harness = MIRROR / "tests/native_realtime_profile_cli.py"
        compile(harness.read_text(), str(harness), "exec")

if __name__ == "__main__":
    unittest.main()
