//! Public compile-time contracts for ORES Stack user modules.
//!
//! The platform owns a small, versioned invocation context. Applications may
//! wrap that context with arbitrary dependencies and expose it through
//! [`ModuleContext`], keeping framework boilerplate small without making ORES
//! Stack a dependency-injection container.

pub const MODULE_SEMANTICS_V2: &str = "ores-stack.module-semantics/v2";
pub const CONTEXT_ABI_V1: &str = "ores-stack.context/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvocationContext {
    request_id: String,
    trace_id: Option<String>,
    deadline_unix_ms: Option<u64>,
    attempt: u32,
}

impl InvocationContext {
    pub fn new(request_id: impl Into<String>) -> Self {
        Self {
            request_id: request_id.into(),
            trace_id: None,
            deadline_unix_ms: None,
            attempt: 0,
        }
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn trace_id(&self) -> Option<&str> {
        self.trace_id.as_deref()
    }

    pub fn deadline_unix_ms(&self) -> Option<u64> {
        self.deadline_unix_ms
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn with_trace_id(mut self, trace_id: impl Into<String>) -> Self {
        self.trace_id = Some(trace_id.into());
        self
    }

    pub fn with_deadline_unix_ms(mut self, deadline_unix_ms: u64) -> Self {
        self.deadline_unix_ms = Some(deadline_unix_ms);
        self
    }

    pub fn with_attempt(mut self, attempt: u32) -> Self {
        self.attempt = attempt;
        self
    }
}

/// Minimal inversion-of-control boundary for user-authored contexts.
///
/// ORES Stack supplies the platform invocation metadata. Applications remain
/// free to attach database handles, caches, loggers, auth principals, or any
/// other dependencies to their own context type.
pub trait ModuleContext: Send + Sync + 'static {
    fn invocation(&self) -> &InvocationContext;
}

impl ModuleContext for InvocationContext {
    fn invocation(&self) -> &InvocationContext {
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ModuleKind {
    Lambda,
    Http,
    Rpc,
    Page,
    Middleware,
    Worker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InvocationMode {
    RequestResponse,
    Stream,
    Event,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConcurrencyModel {
    Concurrent,
    Serial,
    KeyedSerial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CancellationModel {
    Cooperative,
    Deadline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    Clock,
    Random,
    HttpClient,
    KeyValueRead,
    KeyValueWrite,
    DatabaseRead,
    DatabaseWrite,
    QueuePublish,
    QueueConsume,
    ObjectStorageRead,
    ObjectStorageWrite,
    SecretsRead,
    Spawn,
    FilesystemRead,
    FilesystemWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModulePolicy {
    pub invocation: InvocationMode,
    pub concurrency: ConcurrencyModel,
    pub cancellation: CancellationModel,
    pub default_timeout_ms: u64,
    pub max_concurrency: Option<u32>,
    pub idempotent: bool,
    pub retry_safe: bool,
}

impl ModulePolicy {
    pub const REQUEST_RESPONSE: Self = Self {
        invocation: InvocationMode::RequestResponse,
        concurrency: ConcurrencyModel::Concurrent,
        cancellation: CancellationModel::Deadline,
        default_timeout_ms: 0,
        max_concurrency: None,
        idempotent: false,
        retry_safe: false,
    };

    pub const EVENT: Self = Self {
        invocation: InvocationMode::Event,
        concurrency: ConcurrencyModel::Concurrent,
        cancellation: CancellationModel::Cooperative,
        default_timeout_ms: 0,
        max_concurrency: None,
        idempotent: false,
        retry_safe: false,
    };
}

pub trait ModuleKindMarker: Send + Sync + 'static {
    const KIND: ModuleKind;
    const INTERFACE: &'static str;
}

macro_rules! module_kind_marker {
    ($name:ident, $kind:ident, $interface:literal) => {
        #[derive(Debug, Clone, Copy, Default)]
        pub struct $name;

        impl ModuleKindMarker for $name {
            const KIND: ModuleKind = ModuleKind::$kind;
            const INTERFACE: &'static str = $interface;
        }
    };
}

module_kind_marker!(Lambda, Lambda, "ores-stack.lambda.v1");
module_kind_marker!(Http, Http, "ores-stack.http.v1");
module_kind_marker!(Rpc, Rpc, "ores-stack.rpc.v1");
module_kind_marker!(Page, Page, "ores-stack.page.v1");
module_kind_marker!(Middleware, Middleware, "ores-stack.middleware.v1");
module_kind_marker!(Worker, Worker, "ores-stack.worker.v1");

#[allow(async_fn_in_trait)]
pub trait TypedModule: Send + Sync + 'static {
    type Kind: ModuleKindMarker;
    type Input: Send;
    type Output: Send;
    type Error: Send;
    type Context: ModuleContext;

    const NAME: &'static str;
    const POLICY: ModulePolicy = ModulePolicy::REQUEST_RESPONSE;
    const CAPABILITIES: &'static [Capability] = &[];

    async fn handle(
        &self,
        context: &Self::Context,
        input: Self::Input,
    ) -> Result<Self::Output, Self::Error>;
}

pub const fn assert_module<T: TypedModule>() {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StaticModuleDescriptor {
    pub semantics_version: &'static str,
    pub context_abi: &'static str,
    pub kind: ModuleKind,
    pub name: &'static str,
    pub interface: &'static str,
    pub policy: ModulePolicy,
    pub capabilities: &'static [Capability],
}

pub const fn static_descriptor<T: TypedModule>() -> StaticModuleDescriptor {
    StaticModuleDescriptor {
        semantics_version: MODULE_SEMANTICS_V2,
        context_abi: CONTEXT_ABI_V1,
        kind: <T::Kind as ModuleKindMarker>::KIND,
        name: T::NAME,
        interface: <T::Kind as ModuleKindMarker>::INTERFACE,
        policy: T::POLICY,
        capabilities: T::CAPABILITIES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AppContext {
        platform: InvocationContext,
        database_name: String,
    }

    impl ModuleContext for AppContext {
        fn invocation(&self) -> &InvocationContext {
            &self.platform
        }
    }

    struct Hello;

    impl TypedModule for Hello {
        type Kind = Lambda;
        type Input = String;
        type Output = String;
        type Error = ();
        type Context = AppContext;

        const NAME: &'static str = "hello";
        const CAPABILITIES: &'static [Capability] = &[Capability::Clock, Capability::DatabaseRead];

        async fn handle(
            &self,
            context: &Self::Context,
            input: Self::Input,
        ) -> Result<Self::Output, Self::Error> {
            let _request_id = context.invocation().request_id();
            let _database = &context.database_name;
            Ok(input)
        }
    }

    #[test]
    fn user_context_wraps_platform_context() {
        assert_module::<Hello>();
        let context = AppContext {
            platform: InvocationContext::new("req-1")
                .with_trace_id("trace-1")
                .with_deadline_unix_ms(1234)
                .with_attempt(2),
            database_name: "primary".into(),
        };

        assert_eq!(context.invocation().request_id(), "req-1");
        assert_eq!(context.invocation().trace_id(), Some("trace-1"));
        assert_eq!(context.invocation().deadline_unix_ms(), Some(1234));
        assert_eq!(context.invocation().attempt(), 2);

        let descriptor = static_descriptor::<Hello>();
        assert_eq!(descriptor.context_abi, CONTEXT_ABI_V1);
        assert_eq!(descriptor.kind, ModuleKind::Lambda);
        assert_eq!(descriptor.interface, "ores-stack.lambda.v1");
    }
}
