# ores-stack-pub-lib-core staging crate

This workspace crate stages the public contract that belongs in
`github.com/ores-stack/ores-stack-pub-lib-core`.

## Context ABI

ORES Stack owns only a small `InvocationContext`:

- request identity;
- optional trace identity;
- optional absolute deadline;
- attempt number.

User code owns everything else. A project can define:

```rust
struct AppContext {
    platform: InvocationContext,
    db: DatabasePool,
    cache: Cache,
}

impl ModuleContext for AppContext {
    fn invocation(&self) -> &InvocationContext {
        &self.platform
    }
}
```

A framework adapter or user-authored middleware layer may construct `AppContext`
before invoking the exported module. ORES Stack does not require a service
locator, dependency container, or framework-specific extension map.

`TypedModule::Context` is constrained by `ModuleContext`, which guarantees
that every exported module receives the versioned platform context while still
letting applications choose their own dependency-injection model.

The static module descriptor advertises `ores-stack.context/v1` so generated
entrypoints and runtimes can reject incompatible context ABIs before invoking
user code.
