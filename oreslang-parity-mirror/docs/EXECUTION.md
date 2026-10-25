# Execution and parity gate

The checked-in corpus is fail-closed. The default CI audits source presence and enumerates the 150 backend/case pairs. It makes no compiler-parity claim unless a case is explicitly validated and an exact backend adapter executes it.

## Rust-only tooling

Oreslang organization policy prohibits Python tooling. The parity harness is implemented in Rust under `tools/parity-runner`. Do not introduce Python, Python actions, or Python helper scripts.

## Exploratory execution

Each backend uses two command templates:

- `ORES_PARITY_<BACKEND>_COMPILE`
- `ORES_PARITY_<BACKEND>_RUN`

Tokens: `{source}`, `{artifact}`, `{workdir}`. Templates are split into argv without a shell. Supported backend names are LLVM, JAVA, WASM, DOTNET and JS.

Example:

```sh
export ORES_PARITY_JS_COMPILE='node /absolute/oreslang-source.js/bin/oreslang-jsc.mjs {source} --out={artifact}.mjs'
export ORES_PARITY_JS_RUN='node /absolute/run-esm-main.mjs {artifact}.mjs'
cargo run --manifest-path tools/parity-runner/Cargo.toml -- --execute --allow-unvalidated --output js-exploratory.json
```

Exploratory matching is **not** a parity pass.

## Promotion gate

A case becomes `validated` only after canonical syntax is confirmed against the reference frontend, its semantic oracle is independently reviewed, and the named feature is genuinely exercised. Negative tests require a diagnostic category, not merely nonzero exit status. Unsupported features, skips, timeouts, missing runners and infrastructure failures never count as passes.

For funded-runner fallback, mirror only an identical authorized Git tree into an approved test organization, verify tree/blob identity, prohibit secrets in untrusted workflows, and record exact compiler/runtime SHAs. Mirroring a private tree discloses it to the destination organization, so authorization is required.

## Known debt

Cases 24, 25, 29 and 30 are coverage placeholders and case 23 needs a precise actor-isolation violation. Several frontier cases need canonical grammar repair. The next stage replaces these with real semantic tests and adds backend-specific adapters.
