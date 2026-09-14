import unittest

from deep_tests.contract_model import Command, IdempotencyConflict, ReferenceStore, generate_valid_trace, replay


class ThreeFADomainHardeningTests(unittest.TestCase):
    def test_duplicate_enrollment_event_is_exactly_once(self) -> None:
        store = ReferenceStore()
        enrollment = Command("create", "factor-device-42", "totp-enrolled", "enroll-device-42")
        first = store.apply(enrollment)
        revision = store.revision
        for _ in range(50):
            self.assertEqual(store.apply(enrollment), first)
        self.assertEqual(store.revision, revision)

    def test_enrollment_idempotency_key_cannot_rebind_factor_state(self) -> None:
        store = ReferenceStore()
        store.apply(Command("create", "factor-device-42", "totp-enrolled", "stable-enrollment-key"))
        store.apply(Command("create", "factor-device-99", "webauthn-enrolled", "enroll-device-99"))
        with self.assertRaises(IdempotencyConflict):
            store.apply(Command("update", "factor-device-42", "recovery-reset", "stable-enrollment-key"))

    def test_factor_event_trace_converges_under_duplicate_delivery(self) -> None:
        commands = generate_valid_trace(2026091405, steps=860)
        snapshots = {replay(commands, duplicate_every=n).snapshot() for n in (2, 5, 12, 25)}
        self.assertEqual(len(snapshots), 1)


if __name__ == "__main__":
    unittest.main()
