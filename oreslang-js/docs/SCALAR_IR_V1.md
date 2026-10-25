# Experimental scalar IR v1 (JavaScript backend)

Status: **bootstrap contract only**, not the official cross-backend Oreslang typed IR. This documents the first narrow front-end/IR/codegen seam so that future Java/LLVM/Wasm frontends can produce reviewed identical scalar fixtures without running JavaScript parsers. No other backend currently consumes this format.

## Pipeline

`compile(source)` = `compileIR(compileToIR(source))`.

- `compileToIR(source)`: lexical and parser subset, resolve function and parameter names into integer slots, validate the entire module and call graph, return JSON-safe v1 IR.
- `validateScalarIR(ir)`: strictly revalidate a supplied IR value, reject extra/missing keys, accessors in plain objects, invalid indices, arities, duplicate names, unsupported expressions and eager recursion cycles. Return a freshly constructed canonical IR value.
- `compileIR(ir)`: validate again before codegen. Generate a dependency-free ESM module with internal symbol names and exact quoted export names.
- `stringifyScalarIR(ir)`: JSON-serialize validated canonical IR in deterministic field order. This is stable for the current contract but is **not** a cryptographic signature or attestation.

Example:

```ores
pub fnc main(): int { return add(40, 2); }
fnc add(int x, int y): int { return x + y; }
```

```json
{
  "schemaVersion": 1,
  "dialect": "oreslang.scalar",
  "integerModel": "signed-i64-wrap-provisional",
  "functions": [
    {
      "name": "main",
      "pub": true,
      "params": [],
      "resultType": "int",
      "body": {"kind": "call", "target": 1, "args": [
        {"kind": "int", "value": "40"}, {"kind": "int", "value": "2"}
      ]}
    },
    {
      "name": "add",
      "pub": false,
      "params": ["x", "y"],
      "resultType": "int",
      "body": {"kind": "binary", "op": "+",
        "left": {"kind": "param", "index": 0},
        "right": {"kind": "param", "index": 1}}
    }
  ]
}
```

JSON Schema: `schemas/scalar-ir-v1.schema.json`, Draft 2020-12. JSON Schema does not encode referential integrity or signed-64-bit numeric range. The semantic validator is mandatory before code generation.

## Scope and guarantees

- Every expression has provisional `int` type. Structs, dynamic objects, floats, strings, effects, channels, exceptions and async constructs remain unsupported.
- Literal values use **canonical signed decimal strings** (including signed-i64 minimum); ESM uses `BigInt`, with provisional `BigInt.asIntN(64, ...)` arithmetic. This is not yet verified against Java/Truffle language semantics.
- `param.index` refers to the containing function's zero-based parameter list. `call.target` refers to the module's zero-based function list. All callee arities are checked.
- Every function, including private functions, is analyzed. Cyclic eager function calls are rejected because the current grammar has no conditionals. This is **not** a language-wide prohibition on recursion.
- Limits: 512 functions, 128 parameters/arguments, 30,000 expression nodes, max expression depth 256, signed 64-bit literal values.
- Unknown versions, integer models, opcodes and extra fields fail closed. Changing any semantics requires a new IR version or explicit profile negotiation.

## Trust and next gates

This format is neither an untrusted-code sandbox nor a shared-language semantics proof. Validation assumes ordinary JSON-like values; arbitrary JavaScript Proxy traps are not an isolation boundary. Generated ESM must be treated as trusted code and run only in a separately reviewed host with appropriate OS isolation for untrusted callers.

1. Have the Java/Truffle and LLVM maintainers review field meanings and sign off on a backend-neutral schema naming/versioning convention.
2. Validate real, pinned Java/Truffle scalar behavior for arithmetic, range, precedence and diagnostics; replace provisional semantics where they disagree.
3. Create shared positive/negative fixtures with content hashes; exercise `compileToIR -> compileIR -> execution` alongside real Java and LLVM executions in platform conformance.
4. Add source positions, stable symbol IDs, types, effect sets, ownership/borrow provenance, control-flow blocks and explicit await/select constructs incrementally in a **new** shared-IR version, rather than silently altering v1.
5. Record actual Node 22 CI jobs, exact source revisions and logs. A zero-step GitHub Actions job or an unverified mirror is **not** test evidence.
