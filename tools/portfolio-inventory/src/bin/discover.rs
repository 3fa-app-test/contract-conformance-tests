use std::collections::BTreeSet;
use std::path::Path;
use std::process::{Command, ExitCode};

use ores_portfolio_inventory::{Inventory, load_inventory, validate_inventory};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryReport {
    schema: &'static str,
    authenticated_login: String,
    discovered_organization_count: usize,
    discovered_repository_count: usize,
    missing_organizations: Vec<String>,
    missing_repositories: Vec<String>,
    inventory_organizations_not_observed: Vec<String>,
    inventory_repositories_not_observed: Vec<String>,
}

fn main() -> ExitCode {
    let path = Path::new("portfolio/inventory.json");
    let inventory = match load_inventory(path) {
        Ok(inventory) => inventory,
        Err(error) => {
            eprintln!("portfolio discovery failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(errors) = validate_inventory(&inventory) {
        for error in errors {
            eprintln!("portfolio discovery refused invalid inventory: {error}");
        }
        return ExitCode::FAILURE;
    }

    let authenticated_login = match gh_lines(&[
        "api".to_owned(),
        "user".to_owned(),
        "--jq".to_owned(),
        ".login".to_owned(),
    ]) {
        Ok(lines) if lines.len() == 1 => lines[0].clone(),
        Ok(lines) => {
            eprintln!(
                "portfolio discovery expected one authenticated login, received {}",
                lines.len()
            );
            return ExitCode::FAILURE;
        }
        Err(error) => {
            eprintln!("portfolio discovery failed: {error}");
            return ExitCode::FAILURE;
        }
    };

    let mut discovered_organizations = match gh_lines(&[
        "api".to_owned(),
        "--paginate".to_owned(),
        "/user/memberships/orgs?state=active&per_page=100".to_owned(),
        "--jq".to_owned(),
        ".[].organization.login".to_owned(),
    ]) {
        Ok(lines) => lines.into_iter().collect::<BTreeSet<_>>(),
        Err(error) => {
            eprintln!("portfolio discovery failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    discovered_organizations.insert(authenticated_login.clone());

    let mut discovered_repositories = BTreeSet::new();
    for owner in &discovered_organizations {
        let endpoint = if owner.eq_ignore_ascii_case(&authenticated_login) {
            "/user/repos?affiliation=owner&visibility=all&per_page=100".to_owned()
        } else {
            format!("/orgs/{owner}/repos?type=all&per_page=100")
        };
        let repositories = match gh_lines(&[
            "api".to_owned(),
            "--paginate".to_owned(),
            endpoint,
            "--jq".to_owned(),
            ".[] | select(.archived == false) | .full_name".to_owned(),
        ]) {
            Ok(lines) => lines,
            Err(error) => {
                eprintln!("portfolio discovery failed for `{owner}`: {error}");
                return ExitCode::FAILURE;
            }
        };
        for repository in repositories {
            discovered_repositories.insert(repository);
        }
    }

    let report = compare(&inventory, &authenticated_login, &discovered_organizations, &discovered_repositories);
    match serde_json::to_string_pretty(&report) {
        Ok(output) => {
            println!("{output}");
        }
        Err(error) => {
            eprintln!("portfolio discovery could not serialize report: {error}");
            return ExitCode::FAILURE;
        }
    }

    if !report.missing_organizations.is_empty() || !report.missing_repositories.is_empty() {
        return ExitCode::FAILURE;
    }
    return ExitCode::SUCCESS;
}

fn compare(
    inventory: &Inventory,
    authenticated_login: &str,
    discovered_organizations: &BTreeSet<String>,
    discovered_repositories: &BTreeSet<String>,
) -> DiscoveryReport {
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

    let discovered_organization_keys = discovered_organizations
        .iter()
        .map(|organization| organization.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let discovered_repository_keys = discovered_repositories
        .iter()
        .map(|repository| repository.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();

    let missing_organizations = discovered_organizations
        .iter()
        .filter(|organization| {
            !inventory_organizations.contains(&organization.to_ascii_lowercase())
        })
        .cloned()
        .collect::<Vec<_>>();
    let missing_repositories = discovered_repositories
        .iter()
        .filter(|repository| !inventory_repositories.contains(&repository.to_ascii_lowercase()))
        .cloned()
        .collect::<Vec<_>>();

    let inventory_organizations_not_observed = inventory
        .organizations
        .iter()
        .filter(|organization| {
            !discovered_organization_keys.contains(&organization.login.to_ascii_lowercase())
        })
        .map(|organization| organization.login.clone())
        .collect::<Vec<_>>();
    let inventory_repositories_not_observed = inventory
        .repositories
        .iter()
        .filter(|repository| {
            !discovered_repository_keys.contains(&repository.name_with_owner.to_ascii_lowercase())
        })
        .map(|repository| repository.name_with_owner.clone())
        .collect::<Vec<_>>();

    return DiscoveryReport {
        schema: "ores.portfolio-discovery/v1",
        authenticated_login: authenticated_login.to_owned(),
        discovered_organization_count: discovered_organizations.len(),
        discovered_repository_count: discovered_repositories.len(),
        missing_organizations,
        missing_repositories,
        inventory_organizations_not_observed,
        inventory_repositories_not_observed,
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

    use super::compare;

    fn inventory() -> Inventory {
        let source = include_str!("../../../../portfolio/inventory.json");
        let inventory = serde_json::from_str(source).expect("parse bundled inventory");
        return inventory;
    }

    #[test]
    fn discovery_reports_missing_orgs_and_repositories() {
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

        let report = compare(&inventory, "ORESoftware", &organizations, &repositories);
        assert_eq!(report.missing_organizations, vec!["new-org"]);
        assert_eq!(report.missing_repositories, vec!["new-org/new-repo"]);
    }
}
