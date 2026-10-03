use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::process::{Command, ExitCode};

use ores_portfolio_inventory::{Inventory, Lifecycle, load_inventory, validate_inventory};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GovernanceRegistry {
    #[serde(rename = "$schema")]
    schema: String,
    version: u32,
    coverage: GovernanceCoverage,
    organizations: Vec<GovernanceDisposition>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum GovernanceCoverage {
    Partial,
    Complete,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GovernanceDisposition {
    login: String,
    disposition: Disposition,
    observation: GovernanceObservation,
    reason: String,
    linear: GovernanceLinearReference,
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
struct GovernanceLinearReference {
    project: Option<String>,
    issue: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReconciliationReport {
    schema: &'static str,
    authority: &'static str,
    privacy: &'static str,
    authenticated_login: String,
    discovered_organization_count: usize,
    governed_organization_count: usize,
    dispositioned_organization_count: usize,
    discovered_repository_count: usize,
    missing_organization_stubs: Vec<OrganizationStub>,
    unresolved_governance_organizations: Vec<String>,
    governed_organizations_not_observed: Vec<String>,
    inaccessible_governed_organizations: Vec<String>,
    missing_repository_stubs: Vec<RepositoryStub>,
    governed_repositories_not_observed: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OrganizationStub {
    login: String,
    kind: &'static str,
    observation: &'static str,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RepositoryStub {
    name_with_owner: String,
    lifecycle: &'static str,
    role: &'static str,
    observation: &'static str,
    contract_authorities: Vec<String>,
    dependencies: Vec<DependencyStub>,
    release: ReleaseStub,
    languages: Vec<String>,
    runtime_surfaces: Vec<String>,
    test_organization: Option<String>,
    deployment_consumers: Vec<String>,
    linear: LinearStub,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DependencyStub {
    target: String,
    kind: String,
    source: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReleaseStub {
    mechanism: &'static str,
    authority: &'static str,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LinearStub {
    project: Option<String>,
    issue: Option<String>,
}

fn main() -> ExitCode {
    let inventory_path = Path::new("portfolio/inventory.json");
    let governance_path = Path::new("portfolio/governance.json");

    let inventory = match load_inventory(inventory_path) {
        Ok(inventory) => inventory,
        Err(error) => {
            eprintln!("portfolio reconciliation failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(errors) = validate_inventory(&inventory) {
        for error in errors {
            eprintln!("portfolio reconciliation refused invalid inventory: {error}");
        }
        return ExitCode::FAILURE;
    }

    let governance = match load_governance(governance_path) {
        Ok(governance) => governance,
        Err(error) => {
            eprintln!("portfolio reconciliation failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(errors) = validate_governance_shape(&inventory, &governance) {
        for error in errors {
            eprintln!("portfolio reconciliation refused invalid governance: {error}");
        }
        return ExitCode::FAILURE;
    }

    let authenticated_login = match authenticated_login() {
        Ok(login) => login,
        Err(error) => {
            eprintln!("portfolio reconciliation failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    let discovered_organizations = match discover_organizations(&authenticated_login) {
        Ok(organizations) => organizations,
        Err(error) => {
            eprintln!("portfolio reconciliation failed: {error}");
            return ExitCode::FAILURE;
        }
    };

    let governed_organizations = inventory
        .organizations
        .iter()
        .map(|organization| organization.login.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();

    let mut inaccessible_governed_organizations = Vec::new();
    let mut enumerated_governed_organizations = BTreeSet::new();
    let mut discovered_repositories = BTreeSet::new();
    for owner in &discovered_organizations {
        let normalized_owner = owner.to_ascii_lowercase();
        if !governed_organizations.contains(&normalized_owner) {
            continue;
        }

        match discover_repositories(owner, &authenticated_login) {
            Ok(repositories) => {
                enumerated_governed_organizations.insert(normalized_owner);
                discovered_repositories.extend(repositories);
            }
            Err(error) => {
                eprintln!(
                    "portfolio reconciliation could not inspect governed organization `{owner}`: {error}"
                );
                inaccessible_governed_organizations.push(owner.clone());
            }
        }
    }

    let report = propose(
        &inventory,
        &governance,
        &authenticated_login,
        &discovered_organizations,
        &discovered_repositories,
        &enumerated_governed_organizations,
        inaccessible_governed_organizations,
    );
    match serde_json::to_string_pretty(&report) {
        Ok(output) => {
            println!("{output}");
        }
        Err(error) => {
            eprintln!("portfolio reconciliation could not serialize report: {error}");
            return ExitCode::FAILURE;
        }
    }

    if !report.missing_organization_stubs.is_empty()
        || !report.unresolved_governance_organizations.is_empty()
        || !report.governed_organizations_not_observed.is_empty()
        || !report.inaccessible_governed_organizations.is_empty()
        || !report.missing_repository_stubs.is_empty()
        || !report.governed_repositories_not_observed.is_empty()
    {
        return ExitCode::FAILURE;
    }
    return ExitCode::SUCCESS;
}

fn load_governance(path: &Path) -> Result<GovernanceRegistry, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let governance = serde_json::from_str::<GovernanceRegistry>(&content)
        .map_err(|error| format!("could not parse {}: {error}", path.display()))?;
    return Ok(governance);
}

fn validate_governance_shape(
    inventory: &Inventory,
    governance: &GovernanceRegistry,
) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    if governance.version != 1 {
        errors.push(format!(
            "unsupported governance version {}; expected 1",
            governance.version
        ));
    }
    if governance.schema.trim().is_empty() {
        errors.push("governance $schema must not be empty".to_owned());
    }

    let governed = inventory
        .organizations
        .iter()
        .map(|organization| organization.login.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let mut dispositioned = BTreeSet::new();
    let mut unresolved_count = 0;

    for organization in &governance.organizations {
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
                "organization `{login}` cannot be both governed and dispositioned"
            ));
        }
        if !dispositioned.insert(normalized) {
            errors.push(format!(
                "duplicate governance organization `{login}` (case-insensitive)"
            ));
        }
        if organization.reason.trim().is_empty() {
            errors.push(format!(
                "governance organization `{login}` must include a reason"
            ));
        }
        if let Some(project) = organization.linear.project.as_deref() {
            if project.trim().is_empty() {
                errors.push(format!(
                    "governance organization `{login}` has an empty Linear project selector"
                ));
            }
        }
        if let Some(issue) = organization.linear.issue.as_deref() {
            if issue.trim().is_empty() {
                errors.push(format!(
                    "governance organization `{login}` has an empty Linear issue selector"
                ));
            }
        }

        match organization.disposition {
            Disposition::Unresolved => {
                unresolved_count += 1;
                if organization.observation == GovernanceObservation::Inaccessible {
                    errors.push(format!(
                        "unresolved organization `{login}` cannot use inaccessible observation"
                    ));
                }
            }
            Disposition::Excluded | Disposition::Historical => {
                if organization.observation == GovernanceObservation::Inaccessible {
                    errors.push(format!(
                        "organization `{login}` must use inaccessible disposition for inaccessible observation"
                    ));
                }
            }
            Disposition::Inaccessible => {
                if organization.observation != GovernanceObservation::Inaccessible {
                    errors.push(format!(
                        "inaccessible organization `{login}` must use inaccessible observation"
                    ));
                }
            }
        }
    }

    if governance.coverage == GovernanceCoverage::Complete && unresolved_count > 0 {
        errors.push(format!(
            "complete governance coverage forbids {unresolved_count} unresolved organization disposition(s)"
        ));
    }

    if errors.is_empty() {
        return Ok(());
    }
    return Err(errors);
}

fn authenticated_login() -> Result<String, String> {
    let lines = gh_lines(&[
        "api".to_owned(),
        "user".to_owned(),
        "--jq".to_owned(),
        ".login".to_owned(),
    ])?;
    if lines.len() != 1 {
        return Err(format!(
            "expected one authenticated login, received {}",
            lines.len()
        ));
    }
    return Ok(lines[0].clone());
}

fn discover_organizations(authenticated_login: &str) -> Result<BTreeSet<String>, String> {
    let mut organizations = gh_lines(&[
        "api".to_owned(),
        "--paginate".to_owned(),
        "/user/memberships/orgs?state=active&per_page=100".to_owned(),
        "--jq".to_owned(),
        ".[].organization.login".to_owned(),
    ])?
    .into_iter()
    .collect::<BTreeSet<_>>();
    organizations.insert(authenticated_login.to_owned());
    return Ok(organizations);
}

fn discover_repositories(owner: &str, authenticated_login: &str) -> Result<Vec<String>, String> {
    let endpoint = if owner.eq_ignore_ascii_case(authenticated_login) {
        "/user/repos?affiliation=owner&visibility=all&per_page=100".to_owned()
    } else {
        format!("/orgs/{owner}/repos?type=all&per_page=100")
    };
    return gh_lines(&[
        "api".to_owned(),
        "--paginate".to_owned(),
        endpoint,
        "--jq".to_owned(),
        ".[] | select(.archived == false) | .full_name".to_owned(),
    ]);
}

fn propose(
    inventory: &Inventory,
    governance: &GovernanceRegistry,
    authenticated_login: &str,
    discovered_organizations: &BTreeSet<String>,
    discovered_repositories: &BTreeSet<String>,
    enumerated_governed_organizations: &BTreeSet<String>,
    mut inaccessible_governed_organizations: Vec<String>,
) -> ReconciliationReport {
    let inventory_organizations = inventory
        .organizations
        .iter()
        .map(|organization| organization.login.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let inventory_repositories = inventory
        .repositories
        .iter()
        .map(|repository| repository.name_with_owner.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let governance_by_login = governance
        .organizations
        .iter()
        .map(|organization| {
            (
                organization.login.to_ascii_lowercase(),
                organization.disposition,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let discovered_organizations_normalized = discovered_organizations
        .iter()
        .map(|organization| organization.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let discovered_repositories_normalized = discovered_repositories
        .iter()
        .map(|repository| repository.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();

    let missing_organization_stubs = discovered_organizations
        .iter()
        .filter(|organization| {
            let normalized = organization.to_ascii_lowercase();
            !inventory_organizations.contains(&normalized)
                && !governance_by_login.contains_key(&normalized)
        })
        .map(|organization| OrganizationStub {
            login: organization.clone(),
            kind: "unclassified",
            observation: "uninspected",
        })
        .collect::<Vec<_>>();

    let unresolved_governance_organizations = governance
        .organizations
        .iter()
        .filter(|organization| organization.disposition == Disposition::Unresolved)
        .map(|organization| organization.login.clone())
        .collect::<Vec<_>>();

    let governed_organizations_not_observed = inventory
        .organizations
        .iter()
        .filter(|organization| {
            !discovered_organizations_normalized.contains(&organization.login.to_ascii_lowercase())
        })
        .map(|organization| organization.login.clone())
        .collect::<Vec<_>>();

    let missing_repository_stubs = discovered_repositories
        .iter()
        .filter(|repository| !inventory_repositories.contains(&repository.to_ascii_lowercase()))
        .map(|repository| RepositoryStub {
            name_with_owner: repository.clone(),
            lifecycle: "unclassified",
            role: "unclassified",
            observation: "uninspected",
            contract_authorities: Vec::new(),
            dependencies: Vec::new(),
            release: ReleaseStub {
                mechanism: "unknown",
                authority: "uninspected",
            },
            languages: Vec::new(),
            runtime_surfaces: Vec::new(),
            test_organization: None,
            deployment_consumers: Vec::new(),
            linear: LinearStub {
                project: None,
                issue: None,
            },
        })
        .collect::<Vec<_>>();

    let governed_repositories_not_observed = inventory
        .repositories
        .iter()
        .filter(|repository| repository.lifecycle == Lifecycle::Maintained)
        .filter_map(|repository| {
            let owner = repository.name_with_owner.split('/').next()?;
            if !enumerated_governed_organizations.contains(&owner.to_ascii_lowercase()) {
                return None;
            }
            if discovered_repositories_normalized
                .contains(&repository.name_with_owner.to_ascii_lowercase())
            {
                return None;
            }
            return Some(repository.name_with_owner.clone());
        })
        .collect::<Vec<_>>();

    inaccessible_governed_organizations
        .sort_by_key(|organization| organization.to_ascii_lowercase());
    inaccessible_governed_organizations
        .dedup_by(|left, right| left.eq_ignore_ascii_case(right));

    return ReconciliationReport {
        schema: "ores.portfolio-reconciliation/v2",
        authority: "review-only-evidence",
        privacy: "access-controlled",
        authenticated_login: authenticated_login.to_owned(),
        discovered_organization_count: discovered_organizations.len(),
        governed_organization_count: inventory.organizations.len(),
        dispositioned_organization_count: governance.organizations.len(),
        discovered_repository_count: discovered_repositories.len(),
        missing_organization_stubs,
        unresolved_governance_organizations,
        governed_organizations_not_observed,
        inaccessible_governed_organizations,
        missing_repository_stubs,
        governed_repositories_not_observed,
    };
}

fn gh_lines(arguments: &[String]) -> Result<Vec<String>, String> {
    let output = Command::new("gh")
        .args(arguments)
        .output()
        .map_err(|error| format!("could not execute gh: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "gh {} failed with {}: {}",
            arguments.join(" "),
            output.status,
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("gh returned non-UTF-8 output: {error}"))?;
    let lines = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    return Ok(lines);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use ores_portfolio_inventory::Inventory;

    use super::{
        Disposition, GovernanceCoverage, GovernanceDisposition, GovernanceLinearReference,
        GovernanceObservation, GovernanceRegistry, propose,
    };

    fn inventory() -> Inventory {
        let source = include_str!("../../../../portfolio/inventory.json");
        let inventory = serde_json::from_str(source).expect("parse bundled inventory");
        return inventory;
    }

    fn governance() -> GovernanceRegistry {
        return GovernanceRegistry {
            schema: "./governance.schema.json".to_owned(),
            version: 1,
            coverage: GovernanceCoverage::Partial,
            organizations: vec![
                GovernanceDisposition {
                    login: "already-unresolved".to_owned(),
                    disposition: Disposition::Unresolved,
                    observation: GovernanceObservation::Observed,
                    reason: "test".to_owned(),
                    linear: GovernanceLinearReference {
                        project: None,
                        issue: None,
                    },
                },
                GovernanceDisposition {
                    login: "explicitly-excluded".to_owned(),
                    disposition: Disposition::Excluded,
                    observation: GovernanceObservation::Observed,
                    reason: "test".to_owned(),
                    linear: GovernanceLinearReference {
                        project: None,
                        issue: None,
                    },
                },
            ],
        };
    }

    #[test]
    fn reconciliation_separates_missing_dispositioned_and_governed_evidence() {
        let inventory = inventory();
        let governance = governance();
        let organizations = [
            "ORESoftware".to_owned(),
            "new-org".to_owned(),
            "already-unresolved".to_owned(),
            "explicitly-excluded".to_owned(),
        ]
        .into_iter()
        .collect::<BTreeSet<_>>();
        let repositories = [
            "ORESoftware/ores-cli".to_owned(),
            "ORESoftware/new-repo".to_owned(),
        ]
        .into_iter()
        .collect::<BTreeSet<_>>();
        let enumerated = ["oresoftware".to_owned()]
            .into_iter()
            .collect::<BTreeSet<_>>();

        let report = propose(
            &inventory,
            &governance,
            "ORESoftware",
            &organizations,
            &repositories,
            &enumerated,
            Vec::new(),
        );

        assert_eq!(report.authority, "review-only-evidence");
        assert_eq!(report.privacy, "access-controlled");
        assert_eq!(report.missing_organization_stubs.len(), 1);
        assert_eq!(report.missing_organization_stubs[0].login, "new-org");
        assert_eq!(report.unresolved_governance_organizations, vec!["already-unresolved"]);
        assert_eq!(report.missing_repository_stubs.len(), 1);
        assert_eq!(
            report.missing_repository_stubs[0].name_with_owner,
            "ORESoftware/new-repo"
        );
        assert!(
            report
                .missing_repository_stubs
                .iter()
                .all(|repository| repository.runtime_surfaces.is_empty())
        );
    }
}
