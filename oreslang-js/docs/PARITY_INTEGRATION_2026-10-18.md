# Java ↔ JavaScript parity integration gate — 2026-10-18

**Status: DRAFT / NOT CERTIFIED.** This is a source-repository integration
checkpoint, **not** proof that Java/GraalVM or LLVM code has been executed.

## Reconciliation and lineage

* JS PR #19 (head `2574fad41d3c62d0fbdd795a9d8f46e4e8ce83a9`)
  pins the Java v1.1 semantic fixture inventory and independently reconstructed
  19-file suite SHA-256, with actual Node guest numeric probes.
* JS PR #21 (head `42e6ca793e42a07f7fe1cb6b1c1fe9137cb9b35e`)
  adds strict contradiction rejection for successful Java/JS observation records.
* JS PR #22 (head `67467cac73e291e35056b6872948165aaf2803e5`)
  starts from #19 and incorporates those same contradictory-observation
  invariants **plus** bounded parsed-JSON ingress, commit/tree pairing,
  and Node version shape checks.
* This branch descends from #22; its integration regression test expressly
  exercises #21's acceptance obligations against #22's implementation.
  Do **not** cherry-pick #21's older comparator implementation on top of #22:
  its duplicated field-level checks and different error wording can mask
  or regress the later, stronger admission layer.

`compareJavaAndJsJsonReports` accepts at most 64 KiB JS and 256 KiB Java
JSON; the `compareJavaAndJsReports` live-object interface remains a
**trusted in-process API only**. When JS checkout metadata is present, all six receipt fields (commit, tree, Node runtime, fixture count, and the two explicitly false attestation flags) are required together, and the declared Node version must be 22 or newer. Missing fields are rejected, but self-reported fields are never authenticated. Neither validates GitHub signatures, source
checkout authenticity, executable digests, Java runner allocation, or a
Java ↔ JS parity claim.

## Numeric semantics: blocking issue

The Java reference has historic unmarked `long` wraparound behavior,
whereas the experimental JS Program IR advertises
`signed-i64-checked-provisional` and raises on overflow.

**Proposed language-level rule for review:** checked signed i64 in all
portable guest integer arithmetic; no intermediate wrap or silent narrowing.
A directly signed `-9223372036854775808` literal is legal; the unsigned
positive magnitude `9223372036854775808` is not. Negating an existing
`INT64_MIN` value, adding/subtracting/multiplying outside the range, and
overflowing an intermediate expression are errors. The remainder of
`INT64_MIN % -1` is zero. Remainder by zero errors. Java's existing
`int / int` floating promotion **must not** be silently replaced by
truncating integer division: its typing is a separate language decision.

Until the normative contract is approved and the real Java/LLVM runtime is
changed or configured consistently, the checked-versus-wrapping vectors
are **known discrepancies**, not allowed skips or passing parity cases.
Do not change a wire tag to pretend these semantics agree.

## Checked numeric witness source identity (October 19, 2026)

The 16-case `src/js-numeric-boundary-v1.mjs` reporter now compiles Oreslang
source with the **exact first line** `// oreslang:checked-i64-v1\n`.
Previously it generated unmarked source, which was unsuitable for comparing
against Java's explicitly opted-in checked profile. The renderer admits only
the 16 fixed audited expressions and rejects arbitrary external fragments.

The numeric suite's SHA-256 includes the **complete emitted guest source bytes**
for every probe, in addition to its ID, expression, category and expected
value. Fields are each preceded by an unsigned 8-byte big-endian byte length.
Pinned source-suite digest:
`2400f20207799bf824342747d711249be612df7ed81266878e1f24b46dc130c0`.
The digest is an integrity witness, **not** an authenticated checkout, actual
Java/Graal execution, or cross-backend parity attestation.

This is distinct from the conformance repository's 43-case mathematical
contract and its separate 38-source-vector digest. Only *identical* source bytes
under the same checked profile can be meaningfully compared across backends.
Local Node 22 helper-level source/digest assertions do not replace running
the complete JS compiler suite on an approved runner.

## Checked-i64 executable source-vector gate (2026-10-19)

The experimental JS numeric boundary reporter now generates the exact first-line
`// oreslang:checked-i64-v1` profile marker for all 16 probes. Its suite SHA-256
also binds the actual source bytes, so an unmarked program cannot retain the
same reviewed evidence fingerprint. The source helper rejects expressions that
are not members of the explicit probe inventory.

The added `tests/checked-i64-shared-source-vectors.test.mjs` duplicates only
the **38 source-executable** vectors from the independently authored
`oreslang-platform-conformance#119` fixture Git blob
`44224caf6f6c76dedff429a47d51edc926830fdc`, and pins their canonical
five-field serialization with SHA-256
`b83276db9e770025291dd09b0837a55cd8fadc2a7f9fff4c2a78a2ea836c3044`.
The fixture's five abstract `div_trunc` cases are excluded because guest
Oreslang `int / int` has different semantics.

The test **requests real JS compilation and guest execution** for each source
case and distinguishes 23 values, 2 compile-time literal errors and 13
runtime checked arithmetic errors. These checks are *committed*, not yet
confirmed executed on this PR head: source-org Actions currently fail before
job steps. No Java/Graal or LLVM observations are supplied; cross-backend
parity remains uncertified.

## CI and source-transfer policy

1. Run source-repository Node 22 tests and record exact PR head, Git tree,
   Node version, test output, workflow run/job IDs and executed steps.
2. Before copying **any** private code into a different organization,
   require security-owner and maintainer approvals for immutable destination
   repo ID *and* exact source snapshot, stored in a protected policy.
   Recheck destination identity, visibility, permissions, and policy at
   transfer time. Java PR #1450 is explicitly a proposal, not approval.
3. The incident holds in
   `oreslang-platform-conformance#22` and `#77` must be honored;
   a private carrier and green Actions job do not retroactively
   authorize a private source export.
4. Build and execute the **real** GraalVM/JDK25 Java compiler and the **real**
   Node22 JS compiler against the exact same pinned fixture bytes. Verify
   every branch-tree/checkout/build identity independently. Never substitute
   a hand-authored Java JSON or a Node-only oracle for actual Java execution.
5. Compare exact observed values, failure category **and phase**,
   diagnostics, crash/timeout signals, logs and process exit status.
   Reject missing, pending and unsupported results rather than counting
   them as passing.
6. Extend the same gate to LLVM only after Java↔JS is fully observed.
   LLVM must compile and execute every supported fixture independently.
7. Merge only after green **executed** CI, resolved overflow policy,
   integration review and security approval; never use a zero-step failed
   Actions job to infer a compiler-test failure or available Actions quota.

This branch performs **no cross-organization source copy or CI dispatch**.
