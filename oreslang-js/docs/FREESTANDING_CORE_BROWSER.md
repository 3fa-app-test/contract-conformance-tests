# Freestanding core vs hosted std — JS target admission (experimental)

Oreslang has separate **library tiers**, not a single mandatory runtime:

| Tier | May depend on | Required host assumptions |
| --- | --- | --- |
| `core` | `core` only | none: no heap, OS, threads, clock, filesystem, network, FFI, runtime reflection, dynamic loading or mandatory Wasm |
| `alloc` | `core` and admitted `alloc` | explicit allocation provider and heap grant; host adapter may use GC |
| `actor` | freestanding actor primitives, `core` | no implicit heap, scheduler, clock or Worker; adapter explicitly selected when available |
| `std` | admitted lower tiers | explicit host capability grants, e.g. POSIX, Windows, Node, browser, WASI, embedded |
 
A browser is not Linux or Windows, and cannot satisfy POSIX filesystem/process APIs without an explicit implementation. **The JS backend should never inject Node builtins into core or quietly emulate unsupported OS effects.** Some optional `std` modules may have browser providers (`fetch`, WebSocket, timers); they require separate capability contracts. `core` must remain portable across all targets.

## Current proved source subset

`compileFreestandingCore(source)` in `src/freestanding-core.mjs` implements an intentionally **narrow source-effect gate**. It accepts one pure Oreslang `define module core` with integer `fnc` declarations in the program-v2 dialect. Supported functions may have bounded non-recursive integer arithmetic, comparisons, `if ...; do ... else ... fi`, total-returning branching, function calls, and scalar `match`. The exact canonical fixture is copied *unchanged* from `oreslang-source.java/stdlib/core.ores`, Git blob `d2cd9b8e0cd3e3bb3ee6a5f9cebf9ab3312c44f4`.

The generated ES module has no imports, host APIs, memory allocator requirements or dynamic code loading. It uses JavaScript BigInt for a provisional checked signed-i64 arithmetic model and does not promise **zero JavaScript GC**. The package path is browser-safe: `src/freestanding-core.mjs` imports only `src/program-v2.mjs` and `src/program-ir-v2.mjs`, both host-independent. This **does not** prove freestanding OS-independent behavior of arbitrary future Oreslang library files or transitive packages; those require whole-program typed effects and link-time import verification.

## Node verification

```sh
node bin/oreslang-jsc.mjs --freestanding-core --check tests/fixtures/freestanding-core-java.ores
node bin/oreslang-jsc.mjs --freestanding-core tests/fixtures/freestanding-core-java.ores --out=/tmp/ores-core.mjs
node -e 'import("file:///tmp/ores-core.mjs").then(m=>console.log(m.core.clamp_int(20n,0n,10n)))'
npm run test:core
```

## Browser verification

Run `npm run serve:browser` (a local-only Node.js fixture server), then open `http://127.0.0.1:8000/tests/core-browser-smoke.html`. This avoids Python scripts and does not load any hosted Node API into Oreslang core. The browser fixture fetches the **same pinned Oreslang source**, compiles with the host-neutral JS library, imports the resulting trusted Blob ESM, runs representative integer operations, and prints `PASS_BROWSER_FREESTANDING_CORE` only on success.

This is a browser test fixture, **not yet actual external browser CI evidence**; a clean headless Chromium/browser run must complete before a browser verification claim. Blob compilation is for local trusted tests; production deployment should use pinned prebuilt ESM and CSP, not compile arbitrary untrusted Oreslang in-page.

## Explicit closed-world core import for portable applications

The linker API `compileLinkedFreestandingCore({coreSource,appSource})` accepts a **caller-supplied validated source string** for the existing core module and one pure integer application. The application must begin exactly with:

```ores
import module core from "core";
pub fnc answer(): int {return core.clamp_int(42,0,10);}
```

The legacy import string `"std/core"` is also admitted as a compatibility alias; it does **not** enable hosted `std`. The source-independent linker validates `coreSource` through the freestanding source compiler, combines the two inputs in one bounded closed-world compiler invocation, and resolves actual core function names, visibility and arity in typed IR. The resulting ESM has **no runtime imports** and can be executed in Node or a browser. This is a bootstrap linkage design, not a general import system: additional modules, namespaces, host API calls, cycles, reflection, dynamic loading and OS-specific `std` are rejected.

Node CLI:

```sh
node bin/oreslang-jsc.mjs --linked-core --core=/absolute/core.ores --core-sha256=YOUR_PINNED_64_HEX_DIGITS --check tests/fixtures/core-linked-app.ores
node bin/oreslang-jsc.mjs --linked-core --core=/absolute/core.ores tests/fixtures/core-linked-app.ores --out=/tmp/linked-core.mjs
node -e 'import("file:///tmp/linked-core.mjs").then(m=>console.log(m.sample(42n)))'
```

The optional `--core-sha256=HEX` build-time argument verifies SHA-256 of the decoded exact UTF-8 core source bytes before code generation. For reviewed/release builds, supply a pinned digest; no digest means source identity remains caller-controlled. This is **not** a binary provenance or complete supply-chain attestation.

The browser ESM smoke now exercises a **linked app** as well as the standalone core module. The development fixture server binds only to `127.0.0.1`, serves a limited `/tests/` and `/src/` allowlist of ESM/HTML/Oreslang source extensions, and is **not** for production hosting. The CLI is a Node-based **build-time** tool, not a runtime dependency of browser core. Neither linked code nor standalone core has a browser/Node API import. Source-relative path resolution and full library module graphs remain separate compiler work.

## Experimental boolean core values

The source compiler now recognizes **first-class `bool` parameters and return values** using explicit `bool` types, `true`/`false` constants, `!` boolean negation, signed integer comparisons returning `bool`, boolean-returning function calls, and `if predicate; do ... else ... fi` guards. The validated IR demands strict input types, and generated ESM rejects JavaScript numeric truthiness (`1`, `0`, `1n`) at the boolean ABI boundary. Boolean `if` results and arguments are statically checked before emission. Only integer comparisons are admitted so far; boolean `==` and generic `Any` equality, boolean `and/or`, `Option<T>`, and `Result<T,E>` are separate follow-ups.

The experimental IR v2 adds optional, **paired** `paramTypes` / `returnType` fields to function declarations containing `bool`, plus `bool` and `not` expression nodes. Legacy integer-only IR records remain structurally unchanged. This is an additive version-2 **backend-private migration format**, not yet an independently reviewed shared typed-IR contract. Other tools must negotiate the extended shape before consuming it.

`tests/fixtures/core-boolean.ores` is an explicitly **synthetic Oreslang portability fixture**. It is not the authoritative Java `core.ores` library, whose unchanged source still compiles to the identical integer ESM. `tests/core-boolean.test.mjs` compiles and runs pure typed boolean code, cross-module closed-world calls and adversarial IR mutations. The browser smoke also transpiles and imports the bool fixture. Generated boolean ESM has no Node, OS, filesystem, network or browser host imports; JavaScript GC remains normal.

## Architecture and future proof gates

1. The currently named `oreslang-source.java/stdlib/core.ores` and its `std/core` import are **legacy source layout/API**. Moving it to `core/` must be coordinated with import resolver and consumers; this change does **not** silently move or duplicate the authoritative source.
2. Extend a **shared, versioned typed IR** to identify `libraryTier`, inferred effects, dependencies and entrypoint roots. Reject `core -> alloc/std`, host I/O and implicit provider dependencies before any backend codegen.
3. Enforce `--freestanding` in every backend/CLI using compiler-proven dependency closure; forbid hosted imports after linking (native ELF, Wasm imports, JS ESM imports, etc.). A JSON manifest alone is not a proof.
4. `alloc` and actor scheduler adapters are opt-in. JS Web Workers/Node worker_threads belong to hosted actor providers, **not** core.
5. Cross-test exact core source/IR with Java, LLVM, JS Node and JS browser, and WASM guest once its source compiler admits the language slice.
6. A JS `strict-aot`/hard-real-time profile must still fail closed unless explicitly admitted; transpiled ESM and managed GC are not proofs of those constraints.

The schema now admits `compare` and `if` expression nodes as additive experimental program IR v2 variants, with strict expected boolean/int checking in the validator. Other consumers must negotiate the new variants; the IR remains backend-local and is not the shared authoritative typed IR.

