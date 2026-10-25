# Common advisory static facts v0 — JavaScript scalar compiler

`node bin/oreslang-jsc.mjs --static-facts input.ores` uses the same
`compileToIR` + `validateScalarIR` checked scalar source path as
JavaScript code generation. It emits v0 JSON, exact-byte SHA-256 identity,
canonical `__root__.name/arity` procedure IDs and direct-call edges
with `guard=unproved`, `fanout=1`.

The current scalar frontend cannot express loops, actors, `nb` Tasks,
callbacks, ownership or dynamic I/O. Do not interpret empty effect fields
as a whole-language security proof. Repeated caller/callee callsites fail
closed because v0 lacks callsite multiplicity. No execution-work,
zero-allocation, termination or static actor scheduling certification.
Program-v2 dialect is **not admitted** to this scalar fact command.

The CLI checks raw file bytes and rejects a leading UTF-8 BOM (the normal
`TextDecoder` would otherwise strip it before hashing). Malformed UTF-8,
unpaired surrogates, unknown calls and unverified scalar IR fail closed.
Run `node --test tests/static-facts-v0.test.mjs` and `npm test`.
Generated JSON is advisory, not authenticated compiler attestation.
