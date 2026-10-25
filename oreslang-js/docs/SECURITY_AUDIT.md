# JavaScript backend audit — 2026-10-17

Status: **draft hardening changes; exact-head GitHub CI has not executed**.

## Audited trust surfaces

| Area | Finding | Response |
| --- | --- | --- |
| Package publication | A check-then-rename sequence could replace a concurrently created empty directory | Reserve the final output directory with exclusive `mkdir`; link the fully written module first and manifest last; reject collisions |
| Package admission | A manifest's own SHA-256 fields do not establish external trust | Require independently supplied, exact expected hashes for manifest, module and source, plus caller-pinned compiler SHA and target; verify schema and regular files before admitting |
| Package immutability | A filesystem path can change after hash verification | Document requirement for a trusted private output parent and immutable or sealed artifact before import; do not claim path verification is a sandbox |
| Namespace impersonation | JavaScript can forge `[object Module]` and a null prototype | Require a non-extensible namespace for basic portable misuse detection; provide a Node-specific API with the native `util.types.isModuleNamespaceObject` brand check |
| Integer ABI | Accessor-backed "JSON values" could invoke arbitrary getters; ordinary JS calls ignore extra arguments | Reject getters, symbols, noncanonical int64 data and wrong function arity (too few or too many arguments) |
| Numeric limits | The minimum signed 64-bit literal was rejected because its positive magnitude is out of range | Accept `-9223372036854775808` only through unary minus; keep positive `9223372036854775808` rejected |
| Resource limits | Compiled code size was not independently capped | Limit generated module to 4 MiB; verifier caps module and manifest reads; cap public ABI entrypoints at 128 |
| UTF-8 | `ignoreBOM:true` preserved a source BOM and broke the lexer | Decode strictly with leading BOM removed |

## Test evidence and limits

- Targeted dynamic compiler checks ran against the fetched exact GitHub source for arithmetic, the signed minimum, positive overflow rejection, signed remainder, oversized literals and deep expressions.
- Targeted host-bridge checks exercised signed-int64 round trips, non-invocation of accessors, simple forgery rejection and exact/missing/extra arity.
- Node 22 native `util.types.isModuleNamespaceObject` accepts a real module namespace and rejects a constructed module-tag impersonator.
- Read-only package admission exercised success, modified module bytes, modified manifest bytes and symlink rejection using stubbed filesystem/digest dependencies. **This is logic testing, not a full native filesystem/cryptographic integration run**.
- All changed production modules were syntax-checked with imports removed for dynamic parsing.
- The Node repository tests (`npm test`) and SHA-256 filesystem tests must run unmodified on an allocated runner; no green exact-head CI receipt exists yet.
- The conformance inventory includes JS positive/negative fixtures, but does not establish Java/Graal, LLVM or Wasm parity.

## Non-goals / open blockers

1. JS namespace brand checking does **not** prove source provenance: the host must pin and verify the exact approved artifact.
2. Neither V8, a Node worker thread, this bridge, nor `admitPackage` establishes a sandbox for untrusted code.
3. No actor runtime, channels, async continuation lowering, ownership/isolate boundary, or host capability permissions are implemented by this scalar slice.
4. The actual iso-lattes repository and loader API remain unidentified in the current GitHub installation; no end-to-end iso-lattes run is claimed.
5. GitHub Actions for this private repository has failed before any runner steps; maintain draft PR status pending an authorized private runner or equivalent reviewed evidence.
6. The `declaredCompilerSha` is caller-supplied metadata, not cryptographic attestation that produced the JS module.

Do not merge/promote on structural checks, fabricated module namespaces, hash-only claims without an independent trusted pin, or workflows with zero executed steps.

## Follow-up hardening: exact-byte loading and evidence

- `src/compiler.mjs` no longer depends on Node `Buffer.byteLength`; it
  measures UTF-8 source length with `TextEncoder`, compatible with browser JS.
- Build inputs and admission files use a pre-open `lstat` symlink/type/size check,
  final-component no-follow flags where supported, and post-open device/inode
  identity checks, avoiding silent symlink following on hosts without `O_NOFOLLOW`. A parent-directory attacker remains
  out of scope; hosts must control their build/store directories.
- `readVerifiedPackage()` returns an immutable base64 string containing the
  exact **previously hashed module bytes**. The Node-only
  `loadTrustedNodePackage()` imports that snapshot via a data URL instead of
  reopening a mutable module path, and rejects exported names/functions that
  do not match the reviewed manifest.
- Added tests for import after a pathname mutation, corrupt digests, module
  symlinks, mismatched exports and exact-arity Node invocation.
- Added deterministic scalar property coverage aligned to the audited Java
  signed-i64 contract. On the current compiler blob, 250 generated vectors
  produced **1,250/1,250 passing assertions** for add/subtract/multiply/remainder
  and nested calls. Full differential Java execution is still a separate gate.
- A separate `oreslang-platform-conformance` PR now contains a
  real compiler-to-ESM execution evidence collector, but cannot certify
  real execution until the private source checkout and runner are available.

`loadTrustedNodePackage()` executes JavaScript **with the host process's
privileges**, even though the bytes are pinned. Do not load an untrusted
compiler artifact and do not claim OS isolation. Declared source revision
still needs independent attestation; a caller-supplied 40-hex SHA is metadata.

CI incident: [JS private Actions runner issue #2](https://github.com/ores-truffle-oreslang/oreslang-source.js/issues/2).


## Follow-up audit: package admission portability and public API

Current head hardening additionally:

- exports `@oreslang/source-js/load-trusted-package.node`; the exact-byte loader
  existed previously but was unreachable through the package `exports` map;
- rejects source symlinks in `buildPackage()` even on hosts where
  `O_NOFOLLOW` is unavailable, using pre-open `lstat` plus post-open
  device/inode identity checks;
- applies the same fallback identity checks to admitted manifest/module files;
- decodes independently pinned `manifest.json` with fatal UTF-8 rather than
  Node's replacement-character string conversion. Malformed bytes inside an
  otherwise syntactically valid JSON string therefore fail closed;
- adds self-reference loader-export, invalid-manifest-UTF-8, and portable
  symlink regressions.

The current PR contains **43 Node test cases**. Their source syntax has been
checked and the pure compiler subset has targeted exact-blob execution, but
the complete 43-test filesystem/Node suite has **not** executed on the latest
head because the source repository's Actions job still records zero steps and
zero artifacts.

The reviewed private-CI fallback is being hardened in
`oreslang-source.java#1217` with a funded source-free carrier in
`sagitta-stack/sagitta-infra#7`. No JS source may be mirrored there until the
independent-review policy, incident #22, exact approvals and source-snapshot
authorization all permit the transfer.

## 2026-10-18 update: externally supplied IR, host arguments and parity-report admission

The historical no-CI statements earlier in this document describe older
snapshots; they are **superseded** for the latest JS draft source revisions.
Private Node 22 GitHub Actions executed real jobs using the source-identical
private carrier. Every green run must still be tied to the exact source tree
and synthetic PR merge tree; it proves the tested JS subset, not Graal parity.

- **Program IR v2 and scalar IR v1:** arrays are now required to have the native
  array prototype, a dense canonical index set, and own data descriptors.
  Subclass/custom-prototype arrays no longer get to supply their own
  \`map\` implementation to the validator. Numeric target/parameter indices
  reject negative zero instead of silently serializing it as zero.
- **Parity report comparison:** JS and Java result records must contain own
  plain-data properties, and result arrays must be dense native arrays.
  All ten JS case results and source blob IDs must match pinned authority,
  exact fixture model and observations. The Java report's claimed source
  revision must match the pinned authority revision, and all ten required
  cases must pass. A fabricated report containing self-consistent JSON still
  cannot attest actual Java compilation, runner identity or build provenance.
- **Host bridge:** allowlist and argument-list inputs now require dense native
  arrays with own data values before membership tests or argument decoding.
  Caller-supplied Array subclasses/custom methods must not be invoked.
- **Boundaries not solved:** getters hidden behind malicious JS Proxy traps,
  arbitrary JavaScript executing in the same process, ancestor-directory
  filesystem substitution by a hostile writer, and claims derived from a
  self-reported report remain outside these JSON-shape checks.
- **Arithmetic parity blocker:** the scalar IR retains provisional signed-i64
  wrap semantics, while Program IR v2 uses checked arithmetic. Java reference
  source uses Java long wrapping operations. No Java↔JS parity is certified
  until a real pinned Graal run and an explicit semantics decision.

Keep all stacked JS PRs in draft until review and independently verified
Java/Graal semantic evidence. The private test-org mirror is not a release
provenance authority by itself.
