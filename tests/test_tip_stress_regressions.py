import unittest

from deep_tests.contract_model import Command, ReferenceStore, generate_valid_trace, replay


class TipStressContractTests(unittest.TestCase):
    def test_heavier_duplicate_schedules_converge_across_many_seeds(self) -> None:
        for seed in range(24):
            commands = generate_valid_trace(10_000 + seed, steps=360)
            fast = replay(commands, duplicate_every=2)
            sparse = replay(commands, duplicate_every=13)
            self.assertEqual(fast.snapshot(), sparse.snapshot(), f"seed={seed}")

    def test_many_duplicate_retries_do_not_advance_revision(self) -> None:
        store = ReferenceStore()
        command = Command("create", "alpha", "one", "stable-create")
        first = store.apply(command)
        for _ in range(32):
            self.assertEqual(store.apply(command), first)
        self.assertEqual(store.revision, 1)

    def test_duplicate_result_remains_stable_after_unrelated_writes(self) -> None:
        store = ReferenceStore()
        original = Command("create", "alpha", "one", "create-alpha")
        first = store.apply(original)
        store.apply(Command("create", "beta", "two", "create-beta"))
        store.apply(Command("update", "beta", "three", "update-beta"))
        self.assertEqual(store.apply(original), first)
        self.assertEqual(store.revision, 3)


if __name__ == "__main__":
    unittest.main()
