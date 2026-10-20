import hashlib
import json
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIRROR = ROOT / "oreslang_rt_validation"

JAVA = MIRROR / "java/dev/oreslang/runtime/realtime/RealtimeProfile.java"
HEADER = MIRROR / "llvm/src/main/cpp/oreslang/runtime/HardRealtimeContract.hpp"
CPP_TEST = MIRROR / "llvm/tests/native_hard_rt_contract_test.cpp"
SCHEMA = MIRROR / "common/realtime-profile.schema.json"

EXPECTED = {
    JAVA: "3f88df7c38bc7c26a9ee4bd41e6004935b8afc2b",
    HEADER: "4cd08aebd754f32f6b4e2b136a324bb51acfc521",
    CPP_TEST: "d1b9360d9f26b16a132dcabc32cfa1a452c8f83e",
    SCHEMA: "bb0630e0c8a290c00d6e31ee61333088d786dc7e",
}

def git_blob_sha(path: Path) -> str:
    data = path.read_bytes()
    payload = b"blob " + str(len(data)).encode("ascii") + b"\0" + data
    return hashlib.sha1(payload).hexdigest()

class OreslangRealtimeMirrorTest(unittest.TestCase):
    def test_exact_source_blobs(self):
        for path, expected in EXPECTED.items():
            self.assertEqual(expected, git_blob_sha(path), path)

    def test_native_admission_compiles_and_runs(self):
        compiler = shutil.which("g++")
        self.assertIsNotNone(compiler, "g++ must exist on the Actions runner")
        with tempfile.TemporaryDirectory() as td:
            exe = Path(td) / "rt-native"
            subprocess.run(
                [
                    compiler,
                    "-std=c++17",
                    "-O2",
                    "-Wall",
                    "-Wextra",
                    "-Wpedantic",
                    "-Werror",
                    "-UNDEBUG",
                    f"-I{MIRROR / 'llvm/src/main/cpp'}",
                    str(CPP_TEST),
                    "-o",
                    str(exe),
                ],
                check=True,
            )
            subprocess.run([str(exe)], check=True)

    def test_java_admission_compiles_and_runs(self):
        javac = shutil.which("javac")
        java = shutil.which("java")
        self.assertIsNotNone(javac, "javac must exist on the Actions runner")
        self.assertIsNotNone(java, "java must exist on the Actions runner")
        harness = textwrap.dedent(
            """
            package dev.oreslang.runtime.realtime;

            public final class RealtimeProfileSmoke {
                private static RealtimeProfile.Effects effects(
                        boolean heap, boolean gc, boolean codegen, boolean ffi,
                        boolean alloc, boolean block, boolean loop,
                        boolean cleanup, boolean pageFault) {
                    return new RealtimeProfile.Effects(
                            heap, gc, codegen, ffi, alloc, block,
                            loop, cleanup, pageFault);
                }

                private static RealtimeProfile.Budget budget(
                        long deadline, long wcet, long blocking, long jitter) {
                    return new RealtimeProfile.Budget(
                            deadline, wcet, blocking, jitter,
                            10_000_000L, 65_536L,
                            RealtimeProfile.Scheduler.FIXED_PRIORITY);
                }

                private static void check(boolean value, String message) {
                    if (!value) throw new AssertionError(message);
                }

                public static void main(String[] args) {
                    var clean = effects(false,false,false,false,false,false,false,false,false);
                    check(RealtimeProfile.admitJavaHardRt(
                            clean, budget(1_000_000,500_000,100_000,50_000)).admitted(),
                            "bounded path should admit");

                    var gc = RealtimeProfile.admitJavaHardRt(
                            effects(false,true,false,false,false,false,false,false,false),
                            budget(1_000_000,500_000,100_000,50_000));
                    check(gc.failure() == RealtimeProfile.Failure.TRACING_GC_INTERFERENCE,
                            "collector interference should reject");
                    check("RT011_COLLECTOR_INTERFERENCE".equals(gc.diagnosticCode()),
                            "collector diagnostic mismatch");

                    check(!RealtimeProfile.admitJavaHardRt(
                            clean,
                            budget(Long.MAX_VALUE, Long.MAX_VALUE - 10, 8, 8)).admitted(),
                            "overflowing response bound should reject");

                    check(RealtimeProfile.admitJavaHardRt(
                            clean, budget(650_000,500_000,100_000,50_000)).admitted(),
                            "exact response bound should admit");
                }
            }
            """
        )
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            src = td / "RealtimeProfileSmoke.java"
            out = td / "classes"
            src.write_text(harness)
            out.mkdir()
            subprocess.run(
                [
                    javac,
                    "--release",
                    "17",
                    "-Xlint:all",
                    "-Werror",
                    "-d",
                    str(out),
                    str(JAVA),
                    str(src),
                ],
                check=True,
            )
            subprocess.run(
                [java, "-ea", "-cp", str(out),
                 "dev.oreslang.runtime.realtime.RealtimeProfileSmoke"],
                check=True,
            )

    def test_strict_profile_schema_encodes_hard_rt_invariants(self):
        schema = json.loads(SCHEMA.read_text())
        self.assertEqual("https://json-schema.org/draft/2020-12/schema", schema["$schema"])
        self.assertIn("java-hard-rt", schema["properties"]["profile"]["enum"])

        strict = schema["allOf"][0]["then"]["properties"]
        self.assertFalse(
            strict["gc"]["properties"]["tracingCollectorAllowedOnCertifiedPath"]["const"])
        self.assertFalse(
            strict["gc"]["properties"]["managedHeapAllowedOnCertifiedPath"]["const"])
        self.assertFalse(
            strict["memory"]["properties"]["pageFaultsAllowedAfterStart"]["const"])
        self.assertEqual(
            {"fixed-priority", "edf"},
            set(strict["timing"]["properties"]["scheduler"]["enum"]),
        )
        required = set(strict["timing"]["required"])
        self.assertTrue(
            {"deadlineNs", "wcetNs", "maxBlockingNs", "maxJitterNs"} <= required)
        self.assertTrue(
            strict["aot"]["properties"]["guestFullyAheadOfTime"]["const"])
        self.assertFalse(strict["aot"]["properties"]["interpreterAllowed"]["const"])
        self.assertFalse(strict["aot"]["properties"]["jitAllowed"]["const"])

if __name__ == "__main__":
    unittest.main()
