import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import tomllib
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
SNAPSHOT = REPO_ROOT / "fixtures" / "infra-snapshot"
LOCK_PATH = REPO_ROOT / "infra-source-lock.json"
SOURCE_REPO = "3FA-app/3fa-infra"
SOURCE_PR = 22
SOURCE_SHA = "517d1c0b025a0396f95494f8ba95d32dd8cf259a"
ENVIRONMENTS = ("preview", "staging", "production")
PROVIDER_NATIVE_NAMES = {"wrangler.toml", "wrangler.json", "wrangler.jsonc", "neon.ts"}


def run(*args: str, cwd: pathlib.Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


class SourceLockTests(unittest.TestCase):
    def test_snapshot_matches_exact_upstream_blobs(self) -> None:
        lock = json.loads(LOCK_PATH.read_text())
        self.assertEqual(lock["source_repo"], SOURCE_REPO)
        self.assertEqual(lock["source_pr"], SOURCE_PR)
        self.assertEqual(lock["source_head_sha"], SOURCE_SHA)
        self.assertTrue(lock["files"])
        for relative, expected_sha in lock["files"].items():
            snapshot_file = SNAPSHOT / relative
            self.assertTrue(snapshot_file.is_file(), relative)
            actual_sha = run("git", "hash-object", str(snapshot_file), cwd=REPO_ROOT).stdout.strip()
            self.assertEqual(actual_sha, expected_sha, relative)

    def test_snapshot_tracks_only_environment_composition(self) -> None:
        tracked = run("git", "ls-files", "fixtures/infra-snapshot/environments", cwd=REPO_ROOT).stdout.splitlines()
        self.assertTrue(tracked)
        prefix = pathlib.PurePosixPath("fixtures/infra-snapshot")
        for tracked_path in tracked:
            relative = pathlib.PurePosixPath(tracked_path).relative_to(prefix)
            self.assertNotIn(relative.name, PROVIDER_NATIVE_NAMES, tracked_path)
            self.assertNotIn("supabase", relative.parts, tracked_path)
            self.assertFalse(relative.name.endswith(".tfstate"), tracked_path)
            self.assertNotIn(".terraform", relative.parts, tracked_path)


@unittest.skipUnless(shutil.which("terraform"), "Terraform is exercised by the dedicated infra counterpart workflow")
class CounterpartInfraLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory(prefix="3fa-infra-contract-")
        cls.root = pathlib.Path(cls._tmp.name) / "infra"
        shutil.copytree(SNAPSHOT, cls.root)
        cls.manifest = tomllib.loads((cls.root / ".ores-infra.toml").read_text())

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def test_modules_first_provider_roots(self) -> None:
        self.assertEqual(self.manifest["schema_version"], 1)
        self.assertEqual(self.manifest["layout"], "modules")
        self.assertEqual(self.manifest["modules_root"], "modules")
        self.assertEqual(self.manifest["environments_root"], "environments")
        providers = self.manifest["providers"]
        self.assertEqual(providers["supabase"]["canonical_path"], "modules/supabase")
        self.assertEqual(providers["supabase"]["native_working_directory"], "modules")
        self.assertEqual(providers["cloudflare"]["canonical_path"], "modules/cloudflare")
        self.assertEqual(providers["neon"]["project_root"], "modules/neon")
        self.assertEqual(providers["neon"]["config"], "modules/neon/neon.ts")
        self.assertEqual(self.manifest["policy"]["state_isolation"], "per-provider-per-environment")

    def test_terraform_environments_validate(self) -> None:
        run("terraform", "fmt", "-check", "-recursive", "modules/cloudflare/terraform", cwd=self.root)
        for environment in ENVIRONMENTS:
            env_root = self.root / "environments" / environment
            text = (env_root / "main.tf").read_text()
            self.assertIn('backend "s3" {}', text)
            self.assertRegex(text, r'source\s*=\s*"\.\./\.\./modules/cloudflare/terraform/worker-shell"')
            self.assertRegex(text, rf'environment\s*=\s*"{re.escape(environment)}"')
            run("terraform", "fmt", "-check", "-recursive", ".", cwd=env_root)
            run("terraform", "init", "-backend=false", "-input=false", cwd=env_root)
            run("terraform", "validate", "-no-color", cwd=env_root)

    def test_worker_shell_is_opt_in(self) -> None:
        text = (self.root / "modules/cloudflare/terraform/worker-shell/main.tf").read_text()
        self.assertIn('variable "enabled"', text)
        self.assertIn("default = false", text)
        self.assertIn("var.enabled ? 1 : 0", text)


if __name__ == "__main__":
    unittest.main()
