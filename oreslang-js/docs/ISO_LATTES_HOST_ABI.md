# JavaScript host bridge for iso-lattes (experimental)

Status: **compiler and trusted ESM bridge implemented; iso-lattes itself not integrated**.
The iso-lattes repository and its host API have not been verified. This document
describes the contract a future host integration must satisfy, not proof of support.

## Source -> ESM -> trusted host

The `compile()` entrypoint emits a dependency-free ESM module for a restricted
Oreslang scalar subset, and `buildPackage()` writes `module.mjs` with a JSON
manifest. The package is intended for preapproved `edge-js` or `browser`
deployments, not arbitrary code upload.

A trusted build coordinator can invoke:

```js
import {buildPackage} from '@oreslang/source-js/build-package';

const manifest = await buildPackage({
  sourceFile: '/absolute/reviewed/app.ores',
  outputDir: '/absolute/new/build-dir',
  target: 'edge-js',
  declaredCompilerSha: '0000000000000000000000000000000000000000',
});
// Use the *real*, independently verified 40-hex compiler SHA in production.
// Independently verify compiler and module provenance before release.
```

Manifest fields: `schemaVersion=1`, `backend=javascript`, `target`,
`hostABI=oreslang-js-int64-v1`, `module=module.mjs`, a **caller-declared**
compiler revision, SHA-256s of input source and generated module, `publicEntrypoints`,
and `declaredCapabilities=[]`. No compiler SHA attestation, signatures,
OS isolation, or runtime permission enforcement is provided by this API.

Once a **trusted** host has independently verified and imported the reviewed
module in its own isolation boundary, use the explicitly allowlisted entrypoint:

```js
import {invokeTrustedModule} from '@oreslang/source-js/host-bridge';

// `ns` must be the genuine ESM module namespace of approved, imported code.
// `manifest` must be independently verified and authoritatively approved.
const result = invokeTrustedModule(ns, {
  entry: 'add',
  allowlist: manifest.publicEntrypoints,
  args: [{type: 'int64', value: '40'}, {type: 'int64', value: '2'}],
});
// result = {type: 'int64', value: '42'}
```

Do not pass a pathname or arbitrary module URL from a remote user directly into
`import()`. The adapter intentionally accepts an already-imported trusted
namespace; it cannot make untrusted JavaScript safe.

## Wire contract

- Only `{"type":"int64","value":"<canonical signed decimal>"}` is supported.
- JSON numbers, fractional strings, whitespace, plus signs, leading zeros,
  negative zero, out-of-range values, extra keys and oversized values are rejected.
- Valid inputs decode to `BigInt`, which is never JSON-serialized directly.
- Only explicitly allowlisted public functions may be invoked.
- Guest exceptions are surfaced to the caller as generic invocation failures.
- Calls are synchronous. Promises, actors, closures, pointers, I/O and channels
  are not an accepted wire contract.

The compiler's **signed i64 wraparound arithmetic remains provisional** until
it is reconciled against Java language reference semantics. Passing the ABI
tests is not feature parity.

## Mandatory host integration gates

1. Identify the real iso-lattes host repository and deployment pipeline.
2. Confirm its module loader, trust and process/isolate boundary, resource
   accounting, and permitted capabilities.
3. Pin/review source and compiler commits and independently verify their
   provenance. A matching hash alone does not make an artifact trusted.
4. Confirm the package's exported entrypoints and `hostABI` compatibility.
5. Exercise at least one real Oreslang -> ESM -> iso-lattes execution in CI.
6. Refuse untrusted guest code unless an independent, appropriate sandbox
   and quota enforcement have been proven.
7. Keep this backend separate from JS/Wasm/Java/.NET actor parity until the
   shared conformance suite has actual exact-revision execution receipts.

## Hardened publication and admission (October 17, 2026)

A host must **not** accept a package merely because its own manifest lists
SHA-256 hashes. It needs independently trusted expected SHA-256 digests of
`manifest.json`, `module.mjs` and the source, an exact compiler revision,
and the requested target. `admitPackage()` now validates those expectations
without importing or evaluating guest JavaScript:

```js
import {admitPackage} from '@oreslang/source-js/package-admission';
// All expected hashes must come from an independently reviewed trusted release.
const approved = await admitPackage({
  directory: '/trusted/immutable/package',
  target: 'edge-js',
  expectedManifestSha256: '...exact SHA-256 hex...',
  expectedModuleSha256: '...exact SHA-256 hex...',
  expectedSourceSha256: '...exact SHA-256 hex...',
  expectedCompilerSha: '...exact 40-hex Git SHA...'
});
```

`buildPackage()` now reserves its destination using an exclusive directory
creation before publishing files. The manifest is linked into place **last**
as a readiness marker, so a crash may leave an incomplete directory that
admission must reject. Build into a trusted, private parent directory; this
does not protect against attackers who can mutate that parent or swap paths
between hash verification and import. Move admitted artifacts into a sealed
or immutable store before loading them.

For Node-based hosts, prefer `invokeTrustedNodeModule()` from
`@oreslang/source-js/host-bridge.node`, which uses Node's native
`util.types.isModuleNamespaceObject` brand check to reject forged ESM-like
plain objects. The browser-portable `invokeTrustedModule()` uses a structural
namespace check that **can be forged**; neither API establishes module
authenticity. Content trust comes from verified pinned provenance and a
trusted loader, and isolation requires a separate sandbox/process boundary.

The package builder rejects more than 128 public entrypoints and invalid
UTF-8 source, accepts a leading UTF-8 BOM consistently, and refuses to
replace an existing output directory even when concurrent builders race.
The wire ABI refuses accessor-backed data objects without invoking getters.

Remaining gaps: no verified iso-lattes host integration, no actor/async
semantics, no runtime sandbox, and no exact-runner CI evidence.
