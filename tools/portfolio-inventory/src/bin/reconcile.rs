use std::collections::BTreeSet;
use std::path::Path;
use std::process::{Command, ExitCode};

use ores_portfolio_inventory::{Inventory, load_inventory, validate_inventory};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReconciliationReport {
    schema: &'static str,
    authority: &'static str,
    privacy: &'static str,
    authenticated_login: String,
    discovered_organization_count: usize,
    discovered_repository_count: usize,
    inaccessible_organizations: Vec<String>,
    missing_organization_stubs: Vec<OrganizationStub>,
    missing_repository_stubs: Vec<RepositoryStub>,
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
    let path = Path::new("portfolio/inventory.json");
    let inventory = match load_inventory(path) {
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

    let mut inaccessible_organizations = Vec::new();
    let mut discovered_repositories = BTreeSet::new();
    for owner in &discovered_organizations {
        match discover_repositories(owner, &authenticated_login) {
            Ok(repositories) => {
                discovered_repositories.extend(repositories);
            }
            Err(error) => {
                eprintln!("portfolio reconciliation could not inspect `{owner}`: {error}");
                inaccessible_organizations.push(owner.clone());
            }
        }
    }

    let report = propose(
        &inventory,
        &authenticated_login,
        &discovered_organizations,
        &discovered_repositories,
        inaccessible_organizations,
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

    if !report.inaccessible_organizations.is_empty()
        || !report.missing_organization_stubs.is_empty()
        || !report.missing_repository_stubs.is_empty()
    {
        return ExitCode::FAILURE;
    }
    return ExitCode::SUCCESS;
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
    authenticated_login: &str,
    discovered_organizations: &BTreeSet<String>,
    discovered_repositories: &BTreeSet<String>,
    mut inaccessible_organizations: Vec<String>,
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

    let missing_organization_stubs = discovered_organizations
        .iter()
        .filter(|organization| {
            !inventory_organizations.contains(&organization.to_ascii_lowercase())
        })
        .map(|organization| OrganizationStub {
            login: organization.clone(),
            kind: "unclassified",
            observation: "uninspected",
        })
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

    inaccessible_organizations.sort_by_key(|organization| organization.to_ascii_lowercase());
    inaccessible_organizations.dedup_by(|left, right| left.eq_ignore_ascii_case(right));

    return ReconciliationReport {
        schema: "ores.portfolio-reconciliation/v1",
        authority: "review-only-evidence",
        privacy: "access-controlled",
        authenticated_login: authenticated_login.to_owned(),
        discovered_organization_count: discovered_organizations.len(),
        discovered_repository_count: discovered_repositories.len(),
        inaccessible_organizations,
        missing_organization_stubs,
        missing_repository_stubs,
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

    use super::propose;

    fn inventory() -> Inventory {
        let source = include_str!("../../../../portfolio/inventory.json");
        let inventory = serde_json::from_str(source).expect("parse bundled inventory");
        return inventory;
    }

    #[test]
    fn reconciliation_proposes_review_only_unclassified_stubs() {
        let inventory = inventory();
        let organizations = ["ORESoftware".to_owned(), "new-org".to_owned()]
            .into_iter()
            .collect::<BTreeSet<_>>();
        let repositories = [
            "ORESoftware/ores-cli".to_owned(),
            "new-org/new-repo".to_owned(),
        ]
        .into_iter()
        .collect::<BTreeSet<_>>();

        let report = propose(
            &inventory,
            "ORESoftware",
            &organizations,
            &repositories,
            Vec::new(),
        );

        assert_eq!(report.authority, "review-only-evidence");
        assert_eq!(report.privacy, "access-controlled");
        assert_eq!(report.missing_organization_stubs.len(), 1);
        assert_eq!(report.missing_organization_stubs[0].login, "new-org");
        assert_eq!(report.missing_organization_stubs[0].kind, "unclassified");
        assert_eq!(report.missing_repository_stubs.len(), 1);
        assert_eq!(
            report.missing_repository_stubs[0].name_with_owner,
            "new-org/new-repo"
        );
        assert_eq!(report.missing_repository_stubs[0].lifecycle, "unclassified");
        assert_eq!(report.missing_repository_stubs[0].role, "unclassified");
        assert!(report.missing_repository_stubs[0].runtime_surfaces.is_empty());
    }
}
