# JS program-v2 lowering contract: namespaces, modules, matching and inheritance

Status: **experimental/opt-in**. This is NOT full Oreslang feature parity and does not replace the v1 scalar IR or the Java/Truffle language reference. Use:
```sh
node bin/oreslang-jsc.mjs --program-v2 --check path/to/source.ores
node bin/oreslang-jsc.mjs --program-v2 path/to/source.ores --out=/absolute/output.mjs
```
Or call `compileProgramV2(source)`. Standard `compile()` and trusted-package builder still use the older restricted scalar-v1 path until a reviewed typed-IR and host-ABI migration exists.

## File namespace vs runtime module

Oreslang flat file `namespace payments;` is compilation/package/type metadata. It must NOT become a JS object, global or ESM export. A namespace may appear once at the file beginning; dotted or nested namespaces are rejected.

Oreslang's named `define module math [as] ... end` is a runtime namespace, *not* the type-only source namespace. A source file can contain multiple flat modules, plus file-root functions. Inside a module, private functions are callable by unqualified name from that module; only `pub fnc` members become keys on the emitted module object. Qualified `math.foo(...)` calls are resolved statically by **name + caller-visible arity** to a function slot and do not perform dynamic JS property lookups. Several public `fnc` declarations with the same name but distinct arities become one module-object callable that dispatches on `args.length`; duplicate same-arity slots and mixed `fnc`/`routine` names fail closed. Root public function overloads use the same arity-dispatch rule.

Example input:
```ores
namespace payments;
define module math as
  pub fnc add(int a, int b): int { return a+b; }
  fnc internal(): int { return 7; }
end
pub fnc main(): int { return math.add(40,2); }
```

Conceptual ESM output:
```js
function _f0(a,b) { return BigInt.asIntN(64,a+b); } // typed args checked
function _f1() { return 7n; }
function _f2() { return _f0(40n,2n); }
const math = Object.create(null);
Object.defineProperty(math,'add',{value:_f0,enumerable:true,writable:false,configurable:false});
Object.freeze(math);
export {math, _f2 as main};
```

The current emitted object is frozen and has no `Object.prototype`. That is **correct only for the currently supported function-only modules**; future `pub let` / mutable state and `pub val` / readonly fields need dedicated typed cells/field accessors, initialization ordering and ownership enforcement. Simply freezing all module state would be incorrect. No nested module, import resolution, module contract, actor, class or arbitrary init hook support is claimed yet. A public `routine` inside a module is rejected rather than incorrectly reified into a JS function property.

## Freestanding integer control flow (additive v2 slice)

This backend also accepts **total-returning** integer functions containing bounded `if <int> <comparison> <int>; do ... else ... fi` and `return <int>;` statements. `else` is optional only when the remaining function control flow supplies a return on every path. The parser lowers the resulting control-flow tree to nested, statically typed conditional IR expressions. `<`, `>`, `<=`, `>=`, `==`, and `!=` compare signed i64 values; boolean comparisons are only valid as `if` conditions, never implicitly converted to Oreslang `int`. Paths with no return and unreachable trailing statements fail closed. Ordinary `let`, `while`, arbitrary statements, boolean operators, `void` returns, loops, and effects remain unsupported.

Program IR v2 extends its experimental expression variants with `compare` and `if`; the structural schema and runtime validator are updated in the same PR. The validator separately enforces `compare` as `bool` and both `if` branches as `int`, rejecting type-confused externally supplied IR before ESM generation. The IR is **not** promoted to a stable shared frontend contract by this extension.

This narrow slice is sufficient to compile the exact source of `oreslang-source.java/stdlib/core.ores` as a browser/Node-safe module with `--freestanding-core`; see [the tier and browser contract](FREESTANDING_CORE_BROWSER.md). It is **not** general hosted stdlib transpilation and does not weaken the Java/LLVM parity requirements.

## Scalar expression matches

Supported initial subset:
```ores
pub fnc classify(int n): int {
  return match n over
    on 0 -> { 10; }
    on 1 -> { 20; }
    on _ -> { 99; }
  end;
}
```

An equivalent compact spelling omits `over`; `else` may replace `on _`. The scalar subject and arms are `int` only. The compiler requires a final wildcard/else, rejects duplicate literal arms and unreachable arms following wildcard, evaluates the subject once, and emits a `switch` with an immediate `return` from each branch. This preserves branch laziness and prevents fallthrough. The int equality currently uses strict BigInt equality under the **provisional** signed-64 model pending Java parity.

**Do not** apply this scalar lowering blindly to structural, tagged union, Option/Result, destructuring or class patterns. Oreslang value equality of composite values, binding scopes, guards, ordered arm selection, exhaustiveness and source-location diagnostics require a typed decision-tree IR. `match` expressions and `do match` statements must remain distinct; statement-arm `return` cannot be treated as the return of an enclosing expression IIFE. `do match`, `switch`, enum/struct/type patterns and guards remain unsupported here and must fail closed.

The v2 scalar grammar still rejects all recursion, even conditionally terminating recursion, until bounded execution/fuel and proper continuation semantics are implemented. This is **not** an Oreslang-wide restriction.

## Multiple inheritance is not JS prototype-list precedence

Reference-language rule for `define class Child extends A, B implements I, J as`:
- A method slot is **name + caller-visible arity**, not a signature chosen by argument type.
- A genuine diamond sharing one original declaration is one contribution.
- If unrelated parent declarations contribute the same slot, **the child must declare an explicit override**. Parent order never picks a winner.
- Public inherited method slots must remain public when overridden.
- Distinct inherited fields may not collide; a diamond reaching the **same** field declaration is not a duplicate.
- Inheritance cycles are errors.

`planMultipleInheritance()` implements this bounded conflict/field/cycle/arity audit for explicit trusted class descriptors. `materializeMethodOnlyClass()` can compose method-only instances into one null-prototype JS method table, dispatch by arity and use private nominal instance brands that keep unrelated factories distinct. It rejects all storage fields, constructors, private methods and other unsupported layouts rather than generating misleading JavaScript.

**Important limitations:** native `instanceof` does NOT represent multiple nominal parent classes; Oreslang must use its own compiler-controlled nominal `is type` checks. Native `super`, JavaScript private fields, implicit bound methods and first-parent-wins mixins do not provide Oreslang MI semantics. Future class lowering must handle field layout/constructors exactly once in a diamond, receiver-polymorphic `self`, explicit super target resolution, virtual slot dispatch, interface proofs, visibility, ownership and hot reload generations. The method-only materializer is an early proof, not general class transpilation.

## Security and release gates

- Generated JS is **not an untrusted-code sandbox**. Module objects are not capabilities or isolation domains.
- All cross-module references are compile-time resolved in this subset. Arbitrary JS module imports, dynamic property calls and host globals are rejected.
- No source namespace is emitted as a runtime object. No arbitrary Oreslang code runs during parsing.
- Source/token/expression/function budgets and strict grammar are enforced; arithmetic remains provisional signed-i64 BigInt.
- v2 does **not** yet have a versioned shared typed IR schema, cross-backend feature-conformance execution, imported module graph linker, source maps, or host ABI support for namespace exports.
- Do not route v2 module exports through `buildPackage()`/`invokeTrustedModule()` v1: that ABI permits only signed-i64 function entrypoints, not module objects.

Required next vertical slices:
1. Define a backend-neutral, digest-pinned typed program IR with module exports/imports and file-namespace metadata separated, then make Java/LLVM/JS generate/consume equivalent fixtures.
2. Define typed match decision trees with exhaustiveness proof and non-scalar value equality.
3. Implement full class layout + nominal inheritance graph + constructor and field initialization + private dispatch before enabling class syntax.
4. Add runtime module fields and graph-aware staged module initialization, respecting cyclic import barriers.
5. Execute exact-revision Node and Java/LLVM differential tests with actual CI runner steps/logs. Zero-step Actions failures do not count as tests.

Audit gate: exported file-root routines must remain direct-call-only and cannot be ESM values.

