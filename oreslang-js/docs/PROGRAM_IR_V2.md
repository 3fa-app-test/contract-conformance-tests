# Experimental resolved Program IR v2: contract and promotion gates

Status: **backend-local, provisional**, not the canonical Java/Graal/LLVM/JS shared typed IR.

The JS compiler now follows an explicit three-stage pipeline:

1. `compileToProgramIRV2(source)`: parse the small supported Oreslang subset; resolve flat runtime-module names, file-root names, caller-visible arity, public/private visibility and references; validate and deep-copy the resulting plain JSON-compatible IR.
2. `validateProgramIRV2(value)` / `stringifyProgramIRV2(value)`: strictly validate external IR as data, including record shape, property descriptors, numeric bounds, call-graph cycles, match exhaustiveness and maximum expression depth.
3. `compileProgramIRV2(ir)`: validate again at the untrusted IR boundary and emit deterministic ESM; `compileProgramV2(source)` shares this validated emission path.

The wire shape, also described structurally in `schemas/program-ir-v2.schema.json`, is:

```json
{
  "schemaVersion": 2,
  "dialect": "oreslang.program",
  "integerModel": "signed-i64-checked-provisional",
  "sourceNamespace": "payments",
  "modules": ["math"],
  "functions": [
    {
      "module": "math",
      "name": "answer",
      "kind": "fnc",
      "pub": true,
      "params": [],
      "body": {"kind": "int", "value": "42"}
    }
  ]
}
```

A file namespace such as `namespace payments;` becomes **only** `sourceNamespace`. It is never emitted as a JavaScript runtime object or export. Each actual named runtime module appears in `modules`. A module named `root` is valid and cannot alias the file-root scope, because internal symbols are keyed by distinct scopes rather than the spelling `root`. Source module objects expose public `fnc` declarations with overload dispatch by caller-visible arity. Public `routine` declarations are rejected: routines are direct-call-only and cannot be reified as ESM exports. Private functions remain internal.

IR expressions are `int`, `param`, `neg`, `binary`, `call` and scalar `match`. Each call refers to a numeric function target, after resolution; each parameter uses a numeric index. Scalar match arms use signed-64 decimal literal strings, with a final `null` wildcard, and are compiled to one-evaluation `switch` expressions. No JavaScript identifier, source path, namespace name or pattern body is ever interpolated as a raw executable JavaScript expression.

## Security and semantic invariants

- Reject unknown IR fields, accessors, symbols, unusual prototypes, sparse/accessor arrays, unknown module owners, duplicate function slots, malformed or out-of-range integers, invalid call/parameter indexes, arity mismatches, private cross-module calls, cycles and non-exhaustive matches.
- Preserve source-facing compiler diagnostics; callers that supply invalid serialized IR receive explicitly prefixed program-IR errors.
- Bound functions/modules at 512, arguments at 128, match arms at 256 and expression nodes at 30,000 with depth at 192.
- Treat the IR as **trusted data** in the JS engine, not a security boundary for malicious JavaScript Proxy objects. Generated JS and runtime modules are not an OS/VM sandbox.
- This compiler has no imports, module fields, init lifecycle, actors, classes, full pattern matching, ownership or async lowering. Recursive functions are still rejected in this subset pending fuel/stack semantics.
- Source `int` semantics use provisional **checked signed-64** BigInt arithmetic: inputs must fit signed i64 and overflowing negation, addition, subtraction or multiplication must reject instead of wrapping. The previous `signed-i64-wrap-provisional` model tag was incorrect and is now deliberately rejected on input, even though the IR is still marked v2. Java/LLVM differential execution is mandatory before parity claims.
- This IR does not implement TypeSpec/WIT contract generation or eliminate backend-local parsing. It is a **migration seam** toward a shared typed IR, not the shared IR itself.

## Evidence required for graduation

1. Run exact-commit Node 22 `npm test` and `npm run check` with real GitHub Actions job steps and logs. The new tests cover module-root collisions, direct-call routines, program-IR roundtrips, invalid descriptors, cross-module privacy and 500 deterministic signed-i64 vectors.
2. Run the same bounded programs on real Java/GraalVM reference compiler and JS backend, record true outputs/diagnostics and source provenance in the platform-conformance repository.
3. Implement a common schema/typed-IR producer and digest-bound handoff, then replace the independent parser rather than perpetuating backend grammar drift.
4. Extend IR and emitter to fields, initialization, cross-file dependency SCCs, enums/Option/Result patterns and full class inheritance only after typechecker/effect/ownership contracts are proven.
