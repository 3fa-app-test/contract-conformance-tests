use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

use ores_portfolio_inventory::{Inventory, load_inventory, validate_inventory};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GovernanceRegistry {
    #[serde(rename = "$schema")]
    schema: String,
    version: u32,
    coverage: Coverage,
    organizations: Vec<OrganizationDisposition>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Coverage {
    Partial,
    Complete,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrganizationDisposition {
    login: String,
    disposition: Disposition,
    observation: GovernanceObservation,
    reason: String,
    linear: LinearReference,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Disposition {
    Unresolved,
    Excluded,
    Historical,
    Inaccessible,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum GovernanceObservation {
    Observed,
    Uninspected,
    Inaccessible,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LinearReference {
    project: Option<String>,
    issue: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GovernanceSummary {
    schema: &'static str,
    coverage: &'static str,
    governed_organization_count: usize,
    disposition_count: usize,
    unresolved_count: usize,
    excluded_count: usize,
    historical_count: usize,
    inaccessible_count: usize,
}

fn main() -> ExitCode {
    let inventory_path = Path::new("portfolio/inventory.json");
    let governance_path = Path::new("portfolio/governance.json");

    let inventory = match load_inventory(inventory_path) {
        Ok(inventory) => inventory,
        Err(error) => {
            eprintln!("portfolio governance validation failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(errors) = validate_inventory(&inventory) {
        for error in errors {
            eprintln!("portfolio governance refused invalid inventory: {error}");
        }
        return ExitCode::FAILURE;
    }

    let registry = match load_registry(governance_path) {
        Ok(registry) => registry,
        Err(error) => {
            eprintln!("portfolio governance validation failed: {error}");
            return ExitCode::FAILURE;
        }
    };

    match validate_registry(&inventory, &registry) {
        Ok(summary) => match serde_json::to_string_pretty(&summary) {
            Ok(output) => {
                println!("{output}");
                return ExitCode::SUCCESS;
            }
            Err(error) => {
                eprintln!("portfolio governance could not serialize summary: {error}");
                return ExitCode::FAILURE;
            }
        },
        Err(errors) => {
            for error in errors {
                eprintln!("portfolio governance validation failed: {error}");
            }
            return ExitCode::FAILURE;
        }
    }
}

fn load_registry(path: &Path) -> Result<GovernanceRegistry, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let registry = serde_json::from_str::<GovernanceRegistry>(&content)
        .map_err(|error| format!("could not parse {}: {error}", path.display()))?;
    return Ok(registry);
}

fn validate_registry(
    inventory: &Inventory,
    registry: &GovernanceRegistry,
) -> Result<GovernanceSummary, Vec<String>> {
    let mut errors = Vec::new();

    if registry.version != 1 {
        errors.push(format!(
            "unsupported governance version {}; expected 1",
            registry.version
        ));
    }
    if registry.schema.trim().is_empty() {
        errors.push("governance $schema must not be empty".to_owned());
    }

    let governed = inventory
        .organizations
        .iter()
        .map(|organization| organization.login.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let mut dispositions = BTreeSet::new();

    let mut unresolved_count = 0;
    let mut excluded_count = 0;
    let mut historical_count = 0;
    let mut inaccessible_count = 0;

    for organization in &registry.organizations {
        let login = organization.login.trim();
        if login.is_empty() {
            errors.push("governance organization login must not be empty".to_owned());
            continue;
        }
        if login.contains('/') {
            errors.push(format!(
                "governance organization login `{login}` must not contain a slash"
            ));
            continue;
        }

        let normalized = login.to_ascii_lowercase();
        if governed.contains(&normalized) {
            errors.push(format!(
                "organization `{login}` cannot be both governed by inventory.json and listed in governance dispositions"
            ));
        }
        if !dispositions.insert(normalized) {
            errors.push(format!(
                "duplicate governance organization `{login}` (case-insensitive)"
            ));
        }
        if organization.reason.trim().is_empty() {
            errors.push(format!(
                "governance organization `{login}` must include a non-empty reason"
            ));
        }

        match organization.disposition {
            Disposition::Unresolved => {
                unresolved_count += 1;
                if organization.observation == GovernanceObservation::Inaccessible {
                    errors.push(format!(
                        "unresolved organization `{login}` cannot use inaccessible observation; use inaccessible disposition instead"
                    ));
                }
            }
            Disposition::Excluded => {
                excluded_count += 1;
                if organization.observation == GovernanceObservation::Inaccessible {
                    errors.push(format!(
                        "excluded organization `{login}` cannot use inaccessible observation; use inaccessible disposition instead"
                    ));
                }
            }
            Disposition::Historical => {
                historical_count += 1;
                if organization.observation == GovernanceObservation::Inaccessible {
                    errors.push(format!(
                        "historical organization `{login}` cannot use inaccessible observation; use inaccessible disposition instead"
                    ));
                }
            }
            Disposition::Inaccessible => {
                inaccessible_count += 1;
                if organization.observation != GovernanceObservation::Inaccessible {
                    errors.push(format!(
                        "inaccessible organization `{login}` must use inaccessible observation"
                    ));
                }
            }
        }

        validate_linear_reference(login, &organization.linear, &mut errors);
    }

    if registry.coverage == Coverage::Complete && unresolved_count > 0 {
        errors.push(format!(
            "complete governance coverage forbids {unresolved_count} unresolved organization disposition(s)"
        ));
    }

    let summary = GovernanceSummary {
        schema: "ores.portfolio-governance-validation/v1",
        coverage: match registry.coverage {
            Coverage::Partial => "partial",
            Coverage::Complete => "complete",
        },
        governed_organization_count: governed.len(),
        disposition_count: registry.organizations.len(),
        unresolved_count,
        excluded_count,
        historical_count,
        inaccessible_count,
    };

    if errors.is_empty() {
        return Ok(summary);
    }
    return Err(errors);
}

fn validate_linear_reference(
    login: &str,
    linear: &LinearReference,
    errors: &mut Vec<String>,
) {
    if let Some(project) = linear.project.as_deref() {
        if project.trim().is_empty() {
            errors.push(format!(
                "governance organization `{login}` contains an empty Linear project selector"
            ));
        }
    }
    if let Some(issue) = linear.issue.as_deref() {
        if issue.trim().is_empty() {
            errors.push(format!(
                "governance organization `{login}` contains an empty Linear issue selector"
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Coverage, Disposition, GovernanceObservation, GovernanceRegistry, LinearReference,
        OrganizationDisposition, validate_registry,
    };
    use ores_portfolio_inventory::Inventory;

    fn inventory() -> Inventory {
        let source = include_str!("../../../../portfolio/inventory.json");
        let inventory = serde_json::from_str(source).expect("parse bundled inventory");
        return inventory;
    }

    fn registry() -> GovernanceRegistry {
        let source = include_str!("../../../../portfolio/governance.json");
        let registry = serde_json::from_str(source).expect("parse bundled governance registry");
        return registry;
    }

    #[test]
    fn bundled_governance_registry_is_semantically_valid() {
        let inventory = inventory();
        let registry = registry();
        let summary = validate_registry(&inventory, &registry).expect("validate governance");
        assert_eq!(summary.coverage, "partial");
        assert!(summary.unresolved_count > 0);
    }

    #[test]
    fn overlap_with_governed_inventory_is_rejected() {
        let inventory = inventory();
        let mut registry = registry();
        registry.organizations.push(OrganizationDisposition {
            login: inventory.organizations[0].login.clone(),
            disposition: Disposition::Unresolved,
            observation: GovernanceObservation::Observed,
            reason: "regression".to_owned(),
            linear: LinearReference {
                project: None,
                issue: None,
            },
        });
        let errors = validate_registry(&inventory, &registry).expect_err("overlap must fail");
        assert!(errors.iter().any(|error| error.contains("both governed")));
    }

    #[test]
    fn complete_coverage_rejects_unresolved_dispositions() {
        let inventory = inventory();
        let mut registry = registry();
        registry.coverage = Coverage::Complete;
        let errors = validate_registry(&inventory, &registry).expect_err("unresolved must fail");
        assert!(errors.iter().any(|error| error.contains("forbids")));
    }

    #[test]
    fn inaccessible_disposition_requires_inaccessible_observation() {
        let inventory = inventory();
        let mut registry = registry();
        registry.organizations[0].disposition = Disposition::Inaccessible;
        registry.organizations[0].observation = GovernanceObservation::Observed;
        let errors = validate_registry(&inventory, &registry).expect_err("mismatch must fail");
        assert!(
            errors
                .iter()
                .any(|error| error.contains("must use inaccessible observation"))
        );
    }
}
