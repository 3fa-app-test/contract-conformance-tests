# Java ↔ JavaScript semantic parity: evidence and blockers

This is a **source-pinned comparison contract**, not a claim of Java/JS parity.

## What runs today

`npm run parity:js` compiles and **actually executes** five positive Oreslang
fixtures and compiles five intentional diagnostic fixtures with the experimental
JS program-v2 backend on Node 22. All ten are copied byte-for-byte from
`ores-truffle-oreslang/oreslang-source.java` under
`contracts/v1/semantics/fixtures/`, at reference revision
`e719222e2c4c8ff8eff5d3986ad1885bfc02bc7a`.

Every fixture has a pinned Git blob SHA-1 checked at runtime. The suite has an
independent deterministic SHA-256 over length-delimited case ID, kind, expected
observation, blob SHA and exact source bytes. Positive cases must return a real
`bigint` and the expected value; negative cases must fail during compilation
with a corresponding Oreslang program-v2 diagnostic class. Results include the
actual local checkout commit and Git tree (from `git rev-parse`).

The ten fixture IDs match the **subset** of Java's
`contracts/v1/semantics/cases.json`: add, precedence, forward calls, unary
minus, underscored literals, and unknown name, wrong call arity, duplicate
definition, overflowing literal, unterminated comment. No unsupported features
are silently counted as passes.

`compareJavaAndJsReports(js, graal)` accepts Java's v1.1 semantic report
shape to compare ten matching per-fixture results. It rejects missing, pending
or failed cases, duplicate IDs, Java reports from a revision other than the
exact pinned reference revision, value/diagnostic differences, falsified JS
fixture identity/model metadata, and wrong subset identities. Both the JS
and Java report inputs must use ordinary plain-data records and dense native
arrays (not accessor-backed objects, subclasses or replaced Array methods). It **cannot authenticate** the
supplied Java report: a synthetic JSON document can satisfy its checks.
This is an object-shape and fixture-observation check only: a caller could
still fabricate a fully valid data report. Proxies with executable JS traps are
not a sandboxable JSON transport; ingest an actual JSON document at trusted
service boundaries, and independently attest GitHub Actions source/build/run
provenance. The comparison therefore always returns
`java_runner_authenticated:false`,
`source_to_binary_authenticated:false`,
`full_java_js_parity_certified:false`, even for matching records.

## Discovered substantive divergence — overflow policy

At Java reference main `e719222e2c4c8ff8eff5d3986ad1885bfc02bc7a`,
`src/main/java/dev/oreslang/nodes/OresEvalRootNode.java` implements integral
addition/subtraction/multiplication as ordinary Java `long` operations
(`x+y`, `x-y`, `x*y`), and unary minus as Java `-long`. That implementation
**wraps** on signed-64 overflow. The JS Program IR v2 lowerer currently uses
`signed-i64-checked-provisional` and throws if the result is outside signed
64-bit range. That divergence is detected in a JS-only characterization test,
not yet confirmed by executing the Java compiler and guest.

Do **not** silently retag a checked IR as wrapping, or change the Java
reference implementation without a language-semantics decision. Literal
overflow at compile time is a separate contract from arithmetic overflow at
runtime. An independently executed Java/Graal probe of
`MAX_I64 + 1`, `MIN_I64 - 1`, `MIN_I64 * -1`, unary `-MIN_I64`, and
intermediate overflow should determine the observed behavior. Decide whether
Oreslang specifies checked arithmetic or wrapping arithmetic, then align the
frontends, runtime helpers, IR semantics, tests, error taxonomy and LLVM/Wasm
lowering consistently. If two intentional policies remain, they need
**different explicit IR tags** and no silent fallback.

## October 18 — pinned full Java semantic suite and explicit overflow probes

The Java conformance runner's suite SHA-256 at the pinned reference commit is
`6f1b0303b609a400d3ea1b6809a95bcf0d43061bacb4db2c1b8a9233f4528ec1`.
This was independently reconstructed from **all 19 source files** named by
`validate_suite()`: `cases.json`, `schema.json`,
`report.schema.json`, `main.tsp`, and the fifteen `.ores` fixtures.
The reconstruction uses the original Python runner's
`oreslang-conformance-suite-v1.1` domain tag, length-delimited names and
bytes in the documented order. Each Git blob's byte length was checked against
the pinned Java commit before hashing.

`compareJavaAndJsReports` now requires both that **exact digest and the
pinned Java source revision**, and validates all **15 required Java manifest
observations** before claiming a structural match on the ten overlapping
Java/JS fixtures. Neither a fake SHA-shaped digest nor a partial ten-case
Java report is accepted as an actual complete Java suite report. This is
still only structural admission; a malicious actor can fabricate valid JSON.
A verifier must independently authenticate the Java Actions run and compiler.

`npm run parity:numeric-js` executes sixteen boundary probes under the real
Node 22 Oreslang JS backend. It checks exact signed-i64 values, intermediate
overflow, negation and multiplication overflow, modulo sign and zero-divisor
behavior. It emits deterministic probe-suite SHA-256, actual Git checkout
commit and tree identities, and explicitly sets
`java_graal_execution_verified:false` and
`cross_backend_arithmetic_parity_certified:false`.

**Intentional release blocker:** Java's currently inspected `long` operator
implementation appears to wrap, while JS uses checked signed-i64 arithmetic.
The numeric JS probes do not assert Java guest behavior; no arithmetic
parity may be claimed until a real compiler-checked Graal runtime executes
equivalent boundary probes and the language standard chooses a policy.

## October 18 — pass-result consistency and bounded JSON ingress

A successful parity report is not allowed to carry conflicting outcomes:
value cases require exactly one numeric observation, diagnostic cases require
exactly one diagnostic class, and a Java `pass` cannot include nonempty error
detail. These constraints reject an internally contradictory report before
comparing compiler results. They do not authenticate that the reported guest
actually ran.

Prefer `compareJavaAndJsJsonReports(jsJson, graalJson)` for externally
received reports. It accepts JSON **text**, enforces 64 KiB / 256 KiB input
limits (JS / Graal), parses to inert data, and applies the same structural
admission checks. The lower-level object comparator remains for trusted local
data; arbitrary live proxies may invoke traps and are not a safe ingestion
format. The JSON reader rejects duplicate object members at all nesting levels,
including escaped spellings of the same member name. JSON input also has
bounded bytes, nesting depth (64) and value count (20,000). These structural
checks still do not establish authentic checkout, compiler-binary provenance
or actual Java/Graal execution; independent evidence and producer controls
remain necessary.

When *any* JS checkout/provenance metadata is supplied, the six metadata fields (commit, tree, Node version, checked fixture count, and both false attestation flags) must appear together. The declared Node version must be Node 22 or newer. This is stricter structural admission, not runtime authentication. These fields remain self-reported until
verified independently from the actual GitHub Actions run.

## Required release evidence

1. Verify Java compiler source checkout and built binary via a real GraalVM
   runner; execute the exact same fixture byte corpus, both positive and
   negative, with independent report evidence.
2. Compare the actual Java report against the JS output; authenticate run ID,
   job ID, real executed steps, SHA of checkout tree and compiler artifacts
   **outside** the self-reported JSON.
3. Execute explicit dynamic overflow probes, compare exact values/error
   classes, and resolve the policy before promoting arithmetic parity.
4. Pin TypeSpec and Draft 2020-12 authorities for the eventual **shared typed
   IR**. The current program-v2 IR is JS-backend-local and experimental.
5. Do not infer Java/JS, actor, class, ownership or full-language parity from
   a successful JS CI run or a structurally valid report.

The private cross-org Git tree mirror provides a valid route to test a
**complete, SHA-identical JS tree**. It does not by itself authorize a Java
runtime claim or prove source-to-binary provenance.


## Checked remainder diagnostic hardening (October 19)

The program-v2 backend now checks both BigInt operands before `%`, returns
signed remainder including `MIN_I64 % -1 == 0`, and classifies zero-divisor
failures with `ORES_I64_DIVISION_BY_ZERO` instead of accepting a generic V8
RangeError message. The numeric probe adapter accepts only this explicit code.
Java draft PR #956 now handles checked `%` and emits the corresponding
provisional host failure code. **These codes are not yet a unified guest Error
wire ABI.** The checked first-line source profile remains experimental; Java
unmarked source retains its legacy wrapping behavior.

The JS Node 22 suite and Java/Graal JUnit suite must both execute under
approved source-repository CI before this is runtime parity evidence.

## Admission ordering and numeric materialization hardening (2026-10-20)

The lexical grammar, duplicate-member, depth and value-count checks now finish
before parsing the complete report into an object graph. A report exceeding the
64-depth or 20,000-value limits must not reach full JSON.parse materialization.
Overflowing JSON numbers such as 1e999 are rejected instead of becoming Infinity.
The size limit counts UTF-8 bytes and requires a finite nonnegative integer budget.

Eight helper suites cover exact accepted limits, the first rejected value/depth,
escaped duplicate keys, malformed lexical forms, Unicode byte budgets, 512 seeded
ordinary JSON round trips, and rejection before full graph creation. They passed
against the exact candidate helper in an isolated V8 evaluation with a byte-count
and assertion adapter. The original helper fails the new ordering and nonfinite
regressions. This is helper-level execution only; full Node22 npm test/check and
both parity commands, plus independent review, remain required before merge.
