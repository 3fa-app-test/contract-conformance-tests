# Oreslang compiler parity testing

A shared 30-program conformance corpus for Java/GraalVM, LLVM, WebAssembly, .NET Native AOT, and the JavaScript transpiler.

The suite is deliberately fail-closed. The same `.ores` bytes must be presented to every backend. Unsupported features, infrastructure failures, unclassified negative diagnostics, or backend-specific source rewrites are never counted as parity passes.

The current corpus is organized as a feature ladder from scalar arithmetic through control-flow, diagnostics, ownership, cleanup/async/channels and actor isolation/lifecycle. See `docs/TEST_MATRIX.md`, `docs/EXECUTION.md`, and `manifest.json`.

Tooling follows the Oreslang Rust-only tooling policy; Python is prohibited.
