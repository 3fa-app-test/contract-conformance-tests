import unittest

from deep_tests.contract_model import Command, IdempotencyConflict, ReferenceStore, generate_valid_trace, replay


class ContractStressMatrixTests(unittest.TestCase):
    def test_multi_seed_duplicate_schedule_convergence(self):
        for seed in (7, 101, 2026):
            commands = generate_valid_trace(seed, steps=900)
            expected = replay(commands).snapshot()
            for duplicate_every in (2, 3, 5, 7, 11):
                self.assertEqual(replay(commands, duplicate_every=duplicate_every).snapshot(), expected)

    def test_duplicate_storm_is_revision_stable(self):
        store = ReferenceStore()
        command = Command("create", "alpha", "one", "storm")
        first = store.apply(command)
        for _ in range(128):
            self.assertEqual(store.apply(command), first)
        self.assertEqual(store.revision, 1)

    def test_idempotency_binding_survives_unrelated_write_storm(self):
        store = ReferenceStore()
        store.apply(Command("create", "alpha", "one", "stable"))
        for index in range(100):
            store.apply(Command("create", f"key-{index}", str(index), f"unrelated-{index}"))
        with self.assertRaises(IdempotencyConflict):
            store.apply(Command("update", "alpha", "changed", "stable"))


if __name__ == "__main__":
    unittest.main()
