# JS backend next steps

1. Register the JavaScript backend in the existing oreslang-platform-conformance manifest and validator; preserve its fail-closed, real-binary evidence requirement.
2. Pin a reviewed target-profiles commit for browser and edge-js rather than using floating main. Separate allowed host capabilities from runtime enforcement.
3. Reconcile signed integer width, arithmetic overflow and integer division against Java. The current signed i64 wraparound behavior is provisional.
4. Replace the restricted standalone parser with shared frontend/IR contracts, adding tests for strings, structs, arrays, maps and closures one vertical slice at a time.
5. Define actor and mailbox semantics with ownership/borrow/transport boundaries and async continuation lowering; never emulate isolates with ordinary JS objects.
6. Add a pinned, trusted ESM packaging adapter for iso-lattes after locating its repository and confirming permission/host loading interfaces.
7. Expand generated code runtime tests and exact-source CI receipts before marking browser/edge-js target support ready.


## 2026-10-17 security audit: pre-release gates

The CLI now reads from an opened source descriptor, checks regular-file identity
and byte bounds, and rejects invalid UTF-8 even inside comments. A final-component
symlink replacement is blocked by O_NOFOLLOW on supporting platforms; directory
ancestors still require a trusted filesystem/parent directory. Artifacts are
published using an exclusive hard link to avoid overwrite races.

In the current return-only, eager-evaluation scalar grammar, all cyclic function
call graphs are non-terminating. The JS backend rejects direct or mutual cycles
until conditional semantics plus explicit execution budgets are implemented.
This is a restriction of the experimental JS subset, NOT a general Oreslang
ban on recursion.

Run npm test including CLI atomic and package admission negative cases.
A separate local Node 22 reproduction of the exact committed compiler, CLI,
package builder, admission and host bridge Git blobs passed 19 focused
positive/negative tests; this is not a substitute for GitHub runner-backed CI
or real Java/LLVM differential parity.

Never mark untrusted guest isolation, process resource quotas, or iso-lattes
host execution complete based on these tests. Build in a trusted directory,
pin and independently review source/compiler/artifact provenance, enforce
a real OS isolation boundary for untrusted code, and require actual
approved-host integration tests before releasing.
