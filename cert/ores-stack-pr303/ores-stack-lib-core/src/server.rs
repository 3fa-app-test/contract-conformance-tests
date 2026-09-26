//! Shared compile-time and runtime contracts for ORES Stack Rust servers.
//!
//! The hosting boundary is intentionally separate from operation logic: an
//! [`OperationHandler`] owns domain request/response behavior while a
//! [`HostAdapter`] owns provider/runtime translation (standalone HTTP,
//! Scintilla, AWS Lambda, or GCP Cloud Run/CloudEvents).
//!
//! Handler admission is static. Request types must be deserializable, response
//! types serializable, contexts thread-safe, and errors real `std::error::Error`
//! values. This intentionally rejects loosely typed hosting callbacks.
//!
//! ```compile_fail
//! use ores_stack_lib_core::server::{assert_operation_handler, OperationHandler};
//!
//! struct Bad;
//!
//! impl OperationHandler for Bad {
//!     type Request = String;
//!     type Response = String;
//!     type Error = String; // String does not implement std::error::Error.
//!     type Context = ();
//!
//!     async fn handle(
//!         &self,
//!         _context: &Self::Context,
//!         _request: Self::Request,
//!     ) -> Result<Self::Response, Self::Error> {
//!         Ok(String::new())
//!     }
//! }
//!
//! assert_operation_handler::<Bad>();
//! ```

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{collections::HashSet, error::Error};
use thiserror::Error;

pub const SERVER_COMPATIBILITY_V1: &str = "ores-stack.server-compatibility/v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ServerRole {
    Web,
    Api,
    AdminWeb,
    AdminApi,
}

impl ServerRole {
    pub const fn is_admin(self) -> bool {
        return matches!(self, Self::AdminWeb | Self::AdminApi);
    }

    pub const fn is_write_plane(self) -> bool {
        return matches!(self, Self::Api | Self::AdminApi);
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentMode {
    Standalone,
    Scintilla,
    AwsLambda,
    GcpCloudRun,
    GcpCloudRunFunctions,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ServerCapability {
    Http,
    Streaming,
    WebSockets,
    Events,
    BackgroundJobs,
    DatabaseRead,
    DatabaseWrite,
    QueuePublish,
    QueueConsume,
    ObjectStorageRead,
    ObjectStorageWrite,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CredentialPlane {
    ReadOnly,
    Write,
    Admin,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NetworkExposure {
    Public,
    Private,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerEntrypoints {
    pub standalone: String,
    pub function: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerHealthContract {
    pub liveness_path: String,
    pub readiness_path: String,
    pub dependency_failures_remove_readiness: bool,
    pub dependency_failures_remove_liveness: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerLifecycleContract {
    pub bounded_drain: bool,
    pub cancellation_propagation: bool,
    pub startup_validation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerAccessContract {
    pub credential_plane: CredentialPlane,
    pub network_exposure: NetworkExposure,
    pub tenant_authorization_required: bool,
    pub request_validation_required: bool,
    pub idempotency_required_for_writes: bool,
    pub separate_admin_database: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerCompatibilityDescriptor {
    pub contract_version: String,
    pub role: ServerRole,
    pub binary_target: String,
    pub config_contract: String,
    pub entrypoints: ServerEntrypoints,
    pub health: ServerHealthContract,
    pub lifecycle: ServerLifecycleContract,
    pub access: ServerAccessContract,
    pub deployment_modes: Vec<DeploymentMode>,
    pub capabilities: Vec<ServerCapability>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ServerCompatibilityError {
    #[error("unsupported server compatibility contract version")]
    Version,
    #[error("binary target must be a non-empty portable target name")]
    BinaryTarget,
    #[error("configuration contract identity must be non-empty")]
    ConfigContract,
    #[error("standalone and function entrypoints must be non-empty")]
    Entrypoints,
    #[error("liveness and readiness paths must be absolute HTTP paths")]
    HealthPath,
    #[error("liveness and readiness paths must be distinct")]
    HealthPathCollision,
    #[error("dependency failures may not remove liveness in the canonical server contract")]
    DependencyLiveness,
    #[error("server lifecycle must validate startup, propagate cancellation, and bound draining")]
    Lifecycle,
    #[error("server must declare at least one deployment mode")]
    DeploymentModes,
    #[error("server deployment mode list contains duplicates")]
    DuplicateDeploymentMode,
    #[error("server capability list contains duplicates")]
    DuplicateCapability,
    #[error("API/write-plane server must declare database_write, queue_publish, or object_storage_write")]
    WriteCapability,
    #[error("web/read-plane servers may not declare mutation capabilities")]
    ReadPlaneMutation,
    #[error("server credential plane does not match its web/api/admin role")]
    CredentialBoundary,
    #[error("admin servers must be private and non-admin servers must remain on the public service plane")]
    NetworkBoundary,
    #[error(
        "write-plane servers require tenant authorization, request validation, and idempotency"
    )]
    WriteAdmission,
    #[error(
        "admin servers require a separate admin database and non-admin servers may not claim one"
    )]
    AdminDatabaseBoundary,
}

fn portable_target(value: &str) -> bool {
    return !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'));
}

fn absolute_health_path(value: &str) -> bool {
    return value.starts_with('/') && value.len() > 1 && !value.chars().any(char::is_whitespace);
}

fn is_mutation_capability(capability: &ServerCapability) -> bool {
    return matches!(
        capability,
        ServerCapability::DatabaseWrite
            | ServerCapability::QueuePublish
            | ServerCapability::ObjectStorageWrite
    );
}

impl ServerCompatibilityDescriptor {
    pub fn validate(&self) -> Result<(), ServerCompatibilityError> {
        if self.contract_version != SERVER_COMPATIBILITY_V1 {
            return Err(ServerCompatibilityError::Version);
        }
        if !portable_target(&self.binary_target) {
            return Err(ServerCompatibilityError::BinaryTarget);
        }
        if self.config_contract.trim().is_empty() {
            return Err(ServerCompatibilityError::ConfigContract);
        }
        if self.entrypoints.standalone.trim().is_empty()
            || self.entrypoints.function.trim().is_empty()
        {
            return Err(ServerCompatibilityError::Entrypoints);
        }
        if !absolute_health_path(&self.health.liveness_path)
            || !absolute_health_path(&self.health.readiness_path)
        {
            return Err(ServerCompatibilityError::HealthPath);
        }
        if self.health.liveness_path == self.health.readiness_path {
            return Err(ServerCompatibilityError::HealthPathCollision);
        }
        if self.health.dependency_failures_remove_liveness {
            return Err(ServerCompatibilityError::DependencyLiveness);
        }
        if !self.lifecycle.bounded_drain
            || !self.lifecycle.cancellation_propagation
            || !self.lifecycle.startup_validation
        {
            return Err(ServerCompatibilityError::Lifecycle);
        }
        if self.deployment_modes.is_empty() {
            return Err(ServerCompatibilityError::DeploymentModes);
        }

        let mut modes = HashSet::with_capacity(self.deployment_modes.len());
        if self
            .deployment_modes
            .iter()
            .any(|mode| !modes.insert(*mode))
        {
            return Err(ServerCompatibilityError::DuplicateDeploymentMode);
        }
        let mut capabilities = HashSet::with_capacity(self.capabilities.len());
        if self
            .capabilities
            .iter()
            .any(|capability| !capabilities.insert(*capability))
        {
            return Err(ServerCompatibilityError::DuplicateCapability);
        }

        let has_mutation_capability = self.capabilities.iter().any(is_mutation_capability);
        if self.role.is_write_plane() && !has_mutation_capability {
            return Err(ServerCompatibilityError::WriteCapability);
        }
        if !self.role.is_write_plane() && has_mutation_capability {
            return Err(ServerCompatibilityError::ReadPlaneMutation);
        }

        let expected_credential_plane = match self.role {
            ServerRole::Web => CredentialPlane::ReadOnly,
            ServerRole::Api => CredentialPlane::Write,
            ServerRole::AdminWeb | ServerRole::AdminApi => CredentialPlane::Admin,
        };
        if self.access.credential_plane != expected_credential_plane {
            return Err(ServerCompatibilityError::CredentialBoundary);
        }

        let expected_network_exposure = if self.role.is_admin() {
            NetworkExposure::Private
        } else {
            NetworkExposure::Public
        };
        if self.access.network_exposure != expected_network_exposure {
            return Err(ServerCompatibilityError::NetworkBoundary);
        }

        if self.role.is_write_plane()
            && (!self.access.tenant_authorization_required
                || !self.access.request_validation_required
                || !self.access.idempotency_required_for_writes)
        {
            return Err(ServerCompatibilityError::WriteAdmission);
        }

        if self.role.is_admin() != self.access.separate_admin_database {
            return Err(ServerCompatibilityError::AdminDatabaseBoundary);
        }
        return Ok(());
    }
}

/// Static contract each server binary supplies to the ORES Stack admission
/// layer. Hosting adapters can project this once and compare it to deployment
/// manifests before opening readiness.
pub trait ServerDefinition: Send + Sync + 'static {
    const ROLE: ServerRole;
    const BINARY_TARGET: &'static str;
    const CONFIG_CONTRACT: &'static str;
    const STANDALONE_ENTRYPOINT: &'static str;
    const FUNCTION_ENTRYPOINT: &'static str;
    const LIVENESS_PATH: &'static str;
    const READINESS_PATH: &'static str;
    const DEPLOYMENT_MODES: &'static [DeploymentMode];
    const CAPABILITIES: &'static [ServerCapability];

    const DEPENDENCY_FAILURES_REMOVE_READINESS: bool = true;
    const DEPENDENCY_FAILURES_REMOVE_LIVENESS: bool = false;
    const BOUNDED_DRAIN: bool = true;
    const CANCELLATION_PROPAGATION: bool = true;
    const STARTUP_VALIDATION: bool = true;
    const TENANT_AUTHORIZATION_REQUIRED: bool = true;
    const REQUEST_VALIDATION_REQUIRED: bool = true;
    const IDEMPOTENCY_REQUIRED_FOR_WRITES: bool = true;

    fn access_contract() -> ServerAccessContract {
        let credential_plane = match Self::ROLE {
            ServerRole::Web => CredentialPlane::ReadOnly,
            ServerRole::Api => CredentialPlane::Write,
            ServerRole::AdminWeb | ServerRole::AdminApi => CredentialPlane::Admin,
        };
        let network_exposure = if Self::ROLE.is_admin() {
            NetworkExposure::Private
        } else {
            NetworkExposure::Public
        };
        return ServerAccessContract {
            credential_plane,
            network_exposure,
            tenant_authorization_required: Self::TENANT_AUTHORIZATION_REQUIRED,
            request_validation_required: Self::REQUEST_VALIDATION_REQUIRED,
            idempotency_required_for_writes: Self::IDEMPOTENCY_REQUIRED_FOR_WRITES,
            separate_admin_database: Self::ROLE.is_admin(),
        };
    }
}

pub fn descriptor_for_server<T: ServerDefinition>() -> ServerCompatibilityDescriptor {
    return ServerCompatibilityDescriptor {
        contract_version: SERVER_COMPATIBILITY_V1.to_owned(),
        role: T::ROLE,
        binary_target: T::BINARY_TARGET.to_owned(),
        config_contract: T::CONFIG_CONTRACT.to_owned(),
        entrypoints: ServerEntrypoints {
            standalone: T::STANDALONE_ENTRYPOINT.to_owned(),
            function: T::FUNCTION_ENTRYPOINT.to_owned(),
        },
        health: ServerHealthContract {
            liveness_path: T::LIVENESS_PATH.to_owned(),
            readiness_path: T::READINESS_PATH.to_owned(),
            dependency_failures_remove_readiness: T::DEPENDENCY_FAILURES_REMOVE_READINESS,
            dependency_failures_remove_liveness: T::DEPENDENCY_FAILURES_REMOVE_LIVENESS,
        },
        lifecycle: ServerLifecycleContract {
            bounded_drain: T::BOUNDED_DRAIN,
            cancellation_propagation: T::CANCELLATION_PROPAGATION,
            startup_validation: T::STARTUP_VALIDATION,
        },
        access: T::access_contract(),
        deployment_modes: T::DEPLOYMENT_MODES.to_vec(),
        capabilities: T::CAPABILITIES.to_vec(),
    };
}

/// Host-independent operation logic. This is the boundary that standalone,
/// Scintilla, AWS Lambda, and GCP adapters share.
#[allow(async_fn_in_trait)]
pub trait OperationHandler: Send + Sync + 'static {
    type Request: DeserializeOwned + Send + 'static;
    type Response: Serialize + Send + 'static;
    type Error: Error + Send + Sync + 'static;
    type Context: Send + Sync + 'static;

    async fn handle(
        &self,
        context: &Self::Context,
        request: Self::Request,
    ) -> Result<Self::Response, Self::Error>;
}

/// Hosting-only adapter. Provider translation is generic over a handler and
/// cannot change the domain operation types declared by that handler.
#[allow(async_fn_in_trait)]
pub trait HostAdapter<H>: Send + Sync + 'static
where
    H: OperationHandler,
{
    type Invocation: Send + 'static;
    type Output: Send + 'static;
    type Error: Error + Send + Sync + 'static;

    async fn invoke(
        &self,
        handler: &H,
        context: &H::Context,
        invocation: Self::Invocation,
    ) -> Result<Self::Output, Self::Error>;
}

/// Zero-cost compile-time assertion used by generated servers and adapters.
pub const fn assert_operation_handler<T: OperationHandler>() {}

/// Zero-cost compile-time assertion that a host adapter can host the exact
/// statically admitted handler type.
pub const fn assert_host_adapter<H, A>()
where
    H: OperationHandler,
    A: HostAdapter<H>,
{
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{convert::Infallible, fmt};

    #[derive(Debug, Serialize, Deserialize)]
    struct Request {
        value: String,
    }

    #[derive(Debug, Serialize)]
    struct Response {
        value: String,
    }

    #[derive(Debug)]
    struct HandlerError;

    impl fmt::Display for HandlerError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            return formatter.write_str("handler error");
        }
    }

    impl Error for HandlerError {}

    struct Handler;

    impl OperationHandler for Handler {
        type Request = Request;
        type Response = Response;
        type Error = HandlerError;
        type Context = ();

        async fn handle(
            &self,
            _context: &Self::Context,
            request: Self::Request,
        ) -> Result<Self::Response, Self::Error> {
            return Ok(Response {
                value: request.value,
            });
        }
    }

    struct Standalone;

    impl HostAdapter<Handler> for Standalone {
        type Invocation = Request;
        type Output = Response;
        type Error = Infallible;

        async fn invoke(
            &self,
            handler: &Handler,
            context: &<Handler as OperationHandler>::Context,
            invocation: Self::Invocation,
        ) -> Result<Self::Output, Self::Error> {
            let response = handler
                .handle(context, invocation)
                .await
                .expect("fixture handler must succeed");
            return Ok(response);
        }
    }

    struct ApiServer;

    impl ServerDefinition for ApiServer {
        const ROLE: ServerRole = ServerRole::Api;
        const BINARY_TARGET: &'static str = "catalog-api-server";
        const CONFIG_CONTRACT: &'static str = "catalog.server-config/v1";
        const STANDALONE_ENTRYPOINT: &'static str = "catalog_api_server::main";
        const FUNCTION_ENTRYPOINT: &'static str = "catalog_api_server::function";
        const LIVENESS_PATH: &'static str = "/health/live";
        const READINESS_PATH: &'static str = "/health/ready";
        const DEPLOYMENT_MODES: &'static [DeploymentMode] = &[
            DeploymentMode::Standalone,
            DeploymentMode::Scintilla,
            DeploymentMode::AwsLambda,
            DeploymentMode::GcpCloudRun,
        ];
        const CAPABILITIES: &'static [ServerCapability] = &[
            ServerCapability::Http,
            ServerCapability::DatabaseRead,
            ServerCapability::DatabaseWrite,
        ];
    }

    struct WebServer;

    impl ServerDefinition for WebServer {
        const ROLE: ServerRole = ServerRole::Web;
        const BINARY_TARGET: &'static str = "catalog-web-server";
        const CONFIG_CONTRACT: &'static str = "catalog.server-config/v1";
        const STANDALONE_ENTRYPOINT: &'static str = "catalog_web_server::main";
        const FUNCTION_ENTRYPOINT: &'static str = "catalog_web_server::function";
        const LIVENESS_PATH: &'static str = "/health/live";
        const READINESS_PATH: &'static str = "/health/ready";
        const DEPLOYMENT_MODES: &'static [DeploymentMode] = &[DeploymentMode::Standalone];
        const CAPABILITIES: &'static [ServerCapability] =
            &[ServerCapability::Http, ServerCapability::DatabaseRead];
    }

    struct AdminApiServer;

    impl ServerDefinition for AdminApiServer {
        const ROLE: ServerRole = ServerRole::AdminApi;
        const BINARY_TARGET: &'static str = "catalog-admin-api-server";
        const CONFIG_CONTRACT: &'static str = "catalog.admin-server-config/v1";
        const STANDALONE_ENTRYPOINT: &'static str = "catalog_admin_api_server::main";
        const FUNCTION_ENTRYPOINT: &'static str = "catalog_admin_api_server::function";
        const LIVENESS_PATH: &'static str = "/health/live";
        const READINESS_PATH: &'static str = "/health/ready";
        const DEPLOYMENT_MODES: &'static [DeploymentMode] = &[DeploymentMode::Standalone];
        const CAPABILITIES: &'static [ServerCapability] = &[
            ServerCapability::Http,
            ServerCapability::DatabaseRead,
            ServerCapability::DatabaseWrite,
        ];
    }

    #[test]
    fn handler_and_host_are_statically_admitted() {
        assert_operation_handler::<Handler>();
        assert_host_adapter::<Handler, Standalone>();
    }

    #[test]
    fn server_definition_projects_to_valid_runtime_contract() {
        let descriptor = descriptor_for_server::<ApiServer>();
        assert_eq!(descriptor.validate(), Ok(()));
        assert_eq!(descriptor.role, ServerRole::Api);
        assert!(descriptor.lifecycle.bounded_drain);
        assert!(descriptor.health.dependency_failures_remove_readiness);
        assert!(!descriptor.health.dependency_failures_remove_liveness);
        assert_eq!(descriptor.access.credential_plane, CredentialPlane::Write);
        assert_eq!(descriptor.access.network_exposure, NetworkExposure::Public);
    }

    #[test]
    fn web_plane_is_read_only_and_public() {
        let descriptor = descriptor_for_server::<WebServer>();
        assert_eq!(descriptor.validate(), Ok(()));
        assert_eq!(
            descriptor.access.credential_plane,
            CredentialPlane::ReadOnly
        );
        assert_eq!(descriptor.access.network_exposure, NetworkExposure::Public);
        assert!(!descriptor.access.separate_admin_database);

        let mut invalid = descriptor;
        invalid.capabilities.push(ServerCapability::DatabaseWrite);
        assert_eq!(
            invalid.validate(),
            Err(ServerCompatibilityError::ReadPlaneMutation),
        );
    }

    #[test]
    fn api_plane_requires_write_credentials_authorization_validation_and_idempotency() {
        let mut descriptor = descriptor_for_server::<ApiServer>();
        descriptor.access.credential_plane = CredentialPlane::ReadOnly;
        assert_eq!(
            descriptor.validate(),
            Err(ServerCompatibilityError::CredentialBoundary),
        );

        let mut descriptor = descriptor_for_server::<ApiServer>();
        descriptor.access.idempotency_required_for_writes = false;
        assert_eq!(
            descriptor.validate(),
            Err(ServerCompatibilityError::WriteAdmission),
        );
    }

    #[test]
    fn admin_plane_is_private_credential_isolated_and_uses_separate_database() {
        let descriptor = descriptor_for_server::<AdminApiServer>();
        assert_eq!(descriptor.validate(), Ok(()));
        assert_eq!(descriptor.access.credential_plane, CredentialPlane::Admin);
        assert_eq!(descriptor.access.network_exposure, NetworkExposure::Private);
        assert!(descriptor.access.separate_admin_database);

        let mut public_admin = descriptor.clone();
        public_admin.access.network_exposure = NetworkExposure::Public;
        assert_eq!(
            public_admin.validate(),
            Err(ServerCompatibilityError::NetworkBoundary),
        );

        let mut shared_database = descriptor;
        shared_database.access.separate_admin_database = false;
        assert_eq!(
            shared_database.validate(),
            Err(ServerCompatibilityError::AdminDatabaseBoundary),
        );
    }

    #[test]
    fn liveness_and_readiness_must_be_distinct() {
        let mut descriptor = descriptor_for_server::<ApiServer>();
        descriptor.health.readiness_path = descriptor.health.liveness_path.clone();
        assert_eq!(
            descriptor.validate(),
            Err(ServerCompatibilityError::HealthPathCollision),
        );
    }

    #[test]
    fn write_plane_must_declare_a_write_capability() {
        let mut descriptor = descriptor_for_server::<ApiServer>();
        descriptor.capabilities = vec![ServerCapability::Http, ServerCapability::DatabaseRead];
        assert_eq!(
            descriptor.validate(),
            Err(ServerCompatibilityError::WriteCapability),
        );
    }
}
