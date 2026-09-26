use crate::server::{DeploymentMode, ServerRole};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

/// Startup-time policy for one concrete server process.
///
/// This is intentionally stricter than the compatibility descriptor: a
/// compatibility descriptor may advertise several supported deployment modes,
/// while one running process must select exactly one active mode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StartupPolicy {
    pub role: ServerRole,
    pub active_deployment_modes: Vec<DeploymentMode>,
    pub required_settings: Vec<String>,
    pub request_timeout_ms: u64,
    pub drain_timeout_ms: u64,
    pub security: StartupSecurityPolicy,
}

/// Security-sensitive startup switches are closed-world. Unknown fields are a
/// deserialization error rather than silently ignored forward compatibility.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StartupSecurityPolicy {
    pub require_tenant_authorization: bool,
    pub require_request_validation: bool,
    pub require_idempotency_for_writes: bool,
    pub require_private_admin_network: bool,
    pub require_separate_admin_database: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum StartupPolicyError {
    #[error("exactly one deployment mode must be active at process startup")]
    ContradictoryDeploymentModes,
    #[error("request and drain timeouts must both be positive")]
    InvalidTimeout,
    #[error("required setting names must be unique portable identifiers")]
    InvalidRequiredSetting,
    #[error("required startup setting is missing or blank: {0}")]
    MissingRequiredSetting(String),
    #[error("write-plane startup must require tenant authorization, request validation, and idempotency")]
    WriteSecurityBoundary,
    #[error("admin startup must require a private network and separate admin database")]
    AdminSecurityBoundary,
    #[error("non-admin startup may not claim admin-only network/database policy")]
    NonAdminSecurityBoundary,
}

impl StartupPolicy {
    pub fn validate(&self) -> Result<(), StartupPolicyError> {
        if self.active_deployment_modes.len() != 1 {
            return Err(StartupPolicyError::ContradictoryDeploymentModes);
        }
        if self.request_timeout_ms == 0 || self.drain_timeout_ms == 0 {
            return Err(StartupPolicyError::InvalidTimeout);
        }

        let mut required = HashSet::with_capacity(self.required_settings.len());
        for name in &self.required_settings {
            if !portable_setting_name(name) || !required.insert(name) {
                return Err(StartupPolicyError::InvalidRequiredSetting);
            }
        }

        if self.role.is_write_plane()
            && (!self.security.require_tenant_authorization
                || !self.security.require_request_validation
                || !self.security.require_idempotency_for_writes)
        {
            return Err(StartupPolicyError::WriteSecurityBoundary);
        }

        if self.role.is_admin()
            && (!self.security.require_private_admin_network
                || !self.security.require_separate_admin_database)
        {
            return Err(StartupPolicyError::AdminSecurityBoundary);
        }

        if !self.role.is_admin()
            && (self.security.require_private_admin_network
                || self.security.require_separate_admin_database)
        {
            return Err(StartupPolicyError::NonAdminSecurityBoundary);
        }
        return Ok(());
    }

    pub fn admit_settings(
        &self,
        settings: &HashMap<String, String>,
    ) -> Result<(), StartupPolicyError> {
        self.validate()?;
        for required in &self.required_settings {
            let present = settings
                .get(required)
                .is_some_and(|value| !value.trim().is_empty());
            if !present {
                return Err(StartupPolicyError::MissingRequiredSetting(required.clone()));
            }
        }
        return Ok(());
    }
}

fn portable_setting_name(value: &str) -> bool {
    return !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'.')
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api_policy() -> StartupPolicy {
        return StartupPolicy {
            role: ServerRole::Api,
            active_deployment_modes: vec![DeploymentMode::Standalone],
            required_settings: vec!["DATABASE_URL".to_owned(), "TENANT_ID".to_owned()],
            request_timeout_ms: 5_000,
            drain_timeout_ms: 15_000,
            security: StartupSecurityPolicy {
                require_tenant_authorization: true,
                require_request_validation: true,
                require_idempotency_for_writes: true,
                require_private_admin_network: false,
                require_separate_admin_database: false,
            },
        };
    }

    #[test]
    fn missing_required_setting_fails_before_startup() {
        let policy = api_policy();
        let settings = HashMap::from([("DATABASE_URL".to_owned(), "postgres://db".to_owned())]);
        assert_eq!(
            policy.admit_settings(&settings),
            Err(StartupPolicyError::MissingRequiredSetting(
                "TENANT_ID".to_owned()
            ))
        );
    }

    #[test]
    fn contradictory_deployment_modes_are_rejected() {
        let mut policy = api_policy();
        policy.active_deployment_modes =
            vec![DeploymentMode::Standalone, DeploymentMode::AwsLambda];
        assert_eq!(
            policy.validate(),
            Err(StartupPolicyError::ContradictoryDeploymentModes)
        );
    }

    #[test]
    fn unknown_security_sensitive_fields_are_rejected_by_deserialization() {
        let source = r#"{
            "role":"api",
            "active_deployment_modes":["standalone"],
            "required_settings":["DATABASE_URL"],
            "request_timeout_ms":5000,
            "drain_timeout_ms":15000,
            "security":{
                "require_tenant_authorization":true,
                "require_request_validation":true,
                "require_idempotency_for_writes":true,
                "require_private_admin_network":false,
                "require_separate_admin_database":false,
                "allow_auth_bypass":true
            }
        }"#;
        assert!(serde_json::from_str::<StartupPolicy>(source).is_err());
    }

    #[test]
    fn write_security_cannot_be_weakened() {
        let mut policy = api_policy();
        policy.security.require_idempotency_for_writes = false;
        assert_eq!(
            policy.validate(),
            Err(StartupPolicyError::WriteSecurityBoundary)
        );
    }

    #[test]
    fn admin_requires_private_network_and_separate_database() {
        let mut policy = api_policy();
        policy.role = ServerRole::AdminApi;
        policy.security.require_private_admin_network = true;
        policy.security.require_separate_admin_database = true;
        assert_eq!(policy.validate(), Ok(()));

        policy.security.require_private_admin_network = false;
        assert_eq!(
            policy.validate(),
            Err(StartupPolicyError::AdminSecurityBoundary)
        );
    }
}
