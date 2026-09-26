use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Inventory {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub version: u32,
    pub coverage: Coverage,
    pub authorities: Authorities,
    pub organizations: Vec<Organization>,
    pub repositories: Vec<Repository>,
    pub pr_dependencies: Vec<PrDependency>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Coverage {
    Partial,
    Complete,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authorities {
    pub topology_classification: String,
    pub ownership_acceptance: String,
    pub live_source_state: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Organization {
    pub login: String,
    pub kind: OrganizationKind,
    pub observation: Observation,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrganizationKind {
    Product,
    Test,
    Shared,
    ControlPlane,
    Personal,
    Dummy,
    Platform,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Observation {
    Inspected,
    Uninspected,
    Inaccessible,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Repository {
    pub name_with_owner: String,
    pub lifecycle: Lifecycle,
    pub role: String,
    pub observation: Observation,
    pub contract_authorities: Vec<String>,
    pub dependencies: Vec<Dependency>,
    pub release: Release,
    pub languages: Vec<String>,
    #[serde(default)]
    pub runtime_surfaces: Option<Vec<String>>,
    pub test_organization: Option<String>,
    pub deployment_consumers: Vec<String>,
    pub linear: LinearReference,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Unclassified,
    Maintained,
    Experimental,
    Archived,
    Retired,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dependency {
    pub target: String,
    pub kind: String,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub mechanism: String,
    pub authority: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinearReference {
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrDependency {
    pub pr: String,
    pub depends_on: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationSummary {
    pub schema: &'static str,
    pub coverage: &'static str,
    pub organization_count: usize,
    pub repository_count: usize,
    pub maintained_repository_count: usize,
    pub unclassified_repository_count: usize,
    pub uninspected_organization_count: usize,
    pub inaccessible_organization_count: usize,
    pub uninspected_repository_count: usize,
    pub inaccessible_repository_count: usize,
    pub repositories_missing_runtime_surface_review_count: usize,
    pub pr_dependency_count: usize,
}

pub fn load_inventory(path: &Path) -> Result<Inventory, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let inventory = serde_json::from_str::<Inventory>(&content)
        .map_err(|error| format!("could not parse {}: {error}", path.display()))?;
    return Ok(inventory);
}

pub fn load_and_validate(path: &Path) -> Result<ValidationSummary, Vec<String>> {
    let inventory = match load_inventory(path) {
        Ok(inventory) => inventory,
        Err(error) => {
            return Err(vec![error]);
        }
    };
    return validate_inventory(&inventory);
}

pub fn validate_inventory(inventory: &Inventory) -> Result<ValidationSummary, Vec<String>> {
    let mut errors = Vec::new();
    validate_header(inventory, &mut errors);

    let organizations = organization_set(inventory, &mut errors);
    let repositories = repository_set(inventory, &organizations, &mut errors);

    validate_repository_edges(inventory, &organizations, &repositories, &mut errors);
    validate_pr_dependencies(inventory, &repositories, &mut errors);
    validate_complete_coverage(inventory, &mut errors);

    let summary = ValidationSummary {
        schema: "ores.portfolio-inventory-validation/v1",
        coverage: match inventory.coverage {
            Coverage::Partial => "partial",
            Coverage::Complete => "complete",
        },
        organization_count: inventory.organizations.len(),
        repository_count: inventory.repositories.len(),
        maintained_repository_count: inventory
            .repositories
            .iter()
            .filter(|repository| repository.lifecycle == Lifecycle::Maintained)
            .count(),
        unclassified_repository_count: inventory
            .repositories
            .iter()
            .filter(|repository| repository.lifecycle == Lifecycle::Unclassified)
            .count(),
        uninspected_organization_count: inventory
            .organizations
            .iter()
            .filter(|organization| organization.observation == Observation::Uninspected)
            .count(),
        inaccessible_organization_count: inventory
            .organizations
            .iter()
            .filter(|organization| organization.observation == Observation::Inaccessible)
            .count(),
        uninspected_repository_count: inventory
            .repositories
            .iter()
            .filter(|repository| repository.observation == Observation::Uninspected)
            .count(),
        inaccessible_repository_count: inventory
            .repositories
            .iter()
            .filter(|repository| repository.observation == Observation::Inaccessible)
            .count(),
        repositories_missing_runtime_surface_review_count: inventory
            .repositories
            .iter()
            .filter(|repository| repository.lifecycle == Lifecycle::Maintained)
            .filter(|repository| repository.runtime_surfaces.is_none())
            .count(),
        pr_dependency_count: inventory.pr_dependencies.len(),
    };

    if errors.is_empty() {
        return Ok(summary);
    }
    return Err(errors);
}

fn validate_header(inventory: &Inventory, errors: &mut Vec<String>) {
    if inventory.version != 1 {
        errors.push(format!(
            "unsupported inventory version {}; expected 1",
            inventory.version
        ));
    }
    if inventory.schema.trim().is_empty() {
        errors.push("$schema must not be empty".to_owned());
    }
    if inventory.authorities.topology_classification != "portfolio/inventory.json" {
        errors.push(
            "authorities.topologyClassification must be portfolio/inventory.json".to_owned(),
        );
    }
    if inventory.authorities.ownership_acceptance != "linear" {
        errors.push("authorities.ownershipAcceptance must be linear".to_owned());
    }
    if inventory.authorities.live_source_state != "github" {
        errors.push("authorities.liveSourceState must be github".to_owned());
    }
}

fn organization_set(inventory: &Inventory, errors: &mut Vec<String>) -> BTreeSet<String> {
    let mut organizations = BTreeSet::new();
    for organization in &inventory.organizations {
        let login = organization.login.trim();
        if login.is_empty() {
            errors.push("organization login must not be empty".to_owned());
            continue;
        }
        if login.contains('/') {
            errors.push(format!(
                "organization login `{login}` must not contain a slash"
            ));
            continue;
        }
        if !organizations.insert(login.to_ascii_lowercase()) {
            errors.push(format!(
                "duplicate organization login `{login}` (case-insensitive)"
            ));
        }
    }
    return organizations;
}

fn repository_set(
    inventory: &Inventory,
    organizations: &BTreeSet<String>,
    errors: &mut Vec<String>,
) -> BTreeSet<String> {
    let mut repositories = BTreeSet::new();
    for repository in &inventory.repositories {
        let Some((owner, _)) = split_repository_ref(&repository.name_with_owner) else {
            errors.push(format!(
                "repository `{}` must use owner/name format",
                repository.name_with_owner
            ));
            continue;
        };
        if !organizations.contains(&owner.to_ascii_lowercase()) {
            errors.push(format!(
                "repository `{}` has owner `{owner}` missing from organizations",
                repository.name_with_owner
            ));
        }
        if repository.lifecycle == Lifecycle::Maintained {
            validate_maintained_repository(repository, errors);
        } else if repository.lifecycle == Lifecycle::Unclassified {
            validate_unclassified_repository(repository, errors);
        }
        if !repositories.insert(repository.name_with_owner.to_ascii_lowercase()) {
            errors.push(format!(
                "duplicate repository `{}` (case-insensitive)",
                repository.name_with_owner
            ));
        }
    }
    return repositories;
}

fn validate_maintained_repository(repository: &Repository, errors: &mut Vec<String>) {
    if repository.role.trim().is_empty() {
        errors.push(format!(
            "maintained repository `{}` must have a non-empty role",
            repository.name_with_owner
        ));
    }
    if repository.role.eq_ignore_ascii_case("unclassified") {
        errors.push(format!(
            "maintained repository `{}` cannot retain unclassified role",
            repository.name_with_owner
        ));
    }
    if repository.release.mechanism.trim().is_empty() {
        errors.push(format!(
            "maintained repository `{}` must declare a release mechanism",
            repository.name_with_owner
        ));
    }
    if repository.release.authority.trim().is_empty() {
        errors.push(format!(
            "maintained repository `{}` must declare a release authority",
            repository.name_with_owner
        ));
    }
    validate_unique_strings(
        &repository.contract_authorities,
        &repository.name_with_owner,
        "contractAuthorities",
        errors,
    );
    validate_unique_strings(
        &repository.languages,
        &repository.name_with_owner,
        "languages",
        errors,
    );
    if let Some(runtime_surfaces) = repository.runtime_surfaces.as_deref() {
        validate_unique_strings(
            runtime_surfaces,
            &repository.name_with_owner,
            "runtimeSurfaces",
            errors,
        );
    }
    validate_unique_strings(
        &repository.deployment_consumers,
        &repository.name_with_owner,
        "deploymentConsumers",
        errors,
    );
}

fn validate_unclassified_repository(repository: &Repository, errors: &mut Vec<String>) {
    if repository.role != "unclassified" {
        errors.push(format!(
            "unclassified repository `{}` must use role `unclassified` until semantic review",
            repository.name_with_owner
        ));
    }
    if repository.observation == Observation::Inspected {
        errors.push(format!(
            "unclassified repository `{}` cannot be marked inspected",
            repository.name_with_owner
        ));
    }
    if !repository.dependencies.is_empty()
        || !repository.contract_authorities.is_empty()
        || !repository.languages.is_empty()
        || repository.runtime_surfaces.is_some()
        || repository.test_organization.is_some()
        || !repository.deployment_consumers.is_empty()
        || repository.linear.project.is_some()
        || repository.linear.issue.is_some()
    {
        errors.push(format!(
            "unclassified repository `{}` must not invent semantic metadata before review",
            repository.name_with_owner
        ));
    }
    if repository.release.mechanism != "unknown" || repository.release.authority != "uninspected" {
        errors.push(format!(
            "unclassified repository `{}` must use unknown/uninspected release metadata",
            repository.name_with_owner
        ));
    }
}

fn validate_unique_strings(
    values: &[String],
    repository: &str,
    field: &str,
    errors: &mut Vec<String>,
) {
    let mut seen = BTreeSet::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            errors.push(format!(
                "repository `{repository}` contains an empty {field} entry"
            ));
            continue;
        }
        if !seen.insert(trimmed.to_ascii_lowercase()) {
            errors.push(format!(
                "repository `{repository}` contains duplicate {field} entry `{trimmed}`"
            ));
        }
    }
}

fn validate_repository_edges(
    inventory: &Inventory,
    organizations: &BTreeSet<String>,
    repositories: &BTreeSet<String>,
    errors: &mut Vec<String>,
) {
    for repository in &inventory.repositories {
        if let Some(test_organization) = repository.test_organization.as_deref() {
            if !organizations.contains(&test_organization.to_ascii_lowercase()) {
                errors.push(format!(
                    "repository `{}` references missing test organization `{test_organization}`",
                    repository.name_with_owner
                ));
            }
        }

        let mut dependencies = BTreeSet::new();
        for dependency in &repository.dependencies {
            if split_repository_ref(&dependency.target).is_none() {
                errors.push(format!(
                    "repository `{}` has malformed dependency target `{}`",
                    repository.name_with_owner, dependency.target
                ));
                continue;
            }
            let target = dependency.target.to_ascii_lowercase();
            if target == repository.name_with_owner.to_ascii_lowercase() {
                errors.push(format!(
                    "repository `{}` cannot depend on itself",
                    repository.name_with_owner
                ));
            }
            if !repositories.contains(&target) {
                errors.push(format!(
                    "repository `{}` dependency `{}` is missing from the inventory",
                    repository.name_with_owner, dependency.target
                ));
            }
            if dependency.kind.trim().is_empty() {
                errors.push(format!(
                    "repository `{}` dependency `{}` has an empty kind",
                    repository.name_with_owner, dependency.target
                ));
            }
            if dependency.source.trim().is_empty() {
                errors.push(format!(
                    "repository `{}` dependency `{}` has an empty source",
                    repository.name_with_owner, dependency.target
                ));
            }
            let edge_key = format!("{}\u{0}{}", target, dependency.kind.to_ascii_lowercase());
            if !dependencies.insert(edge_key) {
                errors.push(format!(
                    "repository `{}` contains duplicate dependency `{}` kind `{}`",
                    repository.name_with_owner, dependency.target, dependency.kind
                ));
            }
        }
    }
}

fn validate_pr_dependencies(
    inventory: &Inventory,
    repositories: &BTreeSet<String>,
    errors: &mut Vec<String>
) {
    let mut declared_prs = BTreeSet::new();
    for dependency in &inventory.pr_dependencies {
        let Some(pr_repository_name) = pr_repository(&dependency.pr) else {
            errors.push(format!("malformed PR reference `{}`", dependency.pr));
            continue;
        };
        if !repositories.contains(&pr_repository_name.to_ascii_lowercase()) {
            errors.push(format!(
                "PR `{}` references repository `{pr_repository_name}` missing from the inventory",
                dependency.pr
            ));
        }
        if dependency.reason.trim().is_empty() {
            errors.push(format!(
                "PR dependency `{}` must include a reason",
                dependency.pr
            ));
        }
        if !declared_prs.insert(dependency.pr.to_ascii_lowercase()) {
            errors.push(format!(
                "duplicate PR dependency declaration `{}`",
                dependency.pr
            ));
        }

        let mut prerequisites = BTreeSet::new();
        for prerequisite in &dependency.depends_on {
            let Some(prerequisite_repository) = pr_repository(prerequisite) else {
                errors.push(format!("malformed PR reference `{prerequisite}`"));
                continue;
            };
            if !repositories.contains(&prerequisite_repository.to_ascii_lowercase()) {
                errors.push(format!(
                    "PR prerequisite `{prerequisite}` references repository `{prerequisite_repository}` missing from the inventory"
                ));
            }
            if prerequisite.eq_ignore_ascii_case(&dependency.pr) {
                errors.push(format!(
                    "PR `{}` cannot depend on itself",
                    dependency.pr
                ));
            }
            if !prerequisites.insert(prerequisite.to_ascii_lowercase()) {
                errors.push(format!(
                    "PR `{}` repeats prerequisite `{prerequisite}`",
                    dependency.pr
                ));
            }
        }
        if dependency.depends_on.is_empty() {
            errors.push(format!(
                "PR dependency `{}` must contain at least one prerequisite",
                dependency.pr
            ));
        }
    }
}

fn validate_complete_coverage(inventory: &Inventory, errors: &mut Vec<String>) {
    if inventory.coverage != Coverage::Complete {
        return;
    }

    for organization in &inventory.organizations {
        if organization.observation != Observation::Inspected {
            errors.push(format!(
                "complete coverage requires organization `{}` to be inspected",
                organization.login
            ));
        }
    }
    for repository in &inventory.repositories {
        if repository.lifecycle == Lifecycle::Unclassified {
            errors.push(format!(
                "complete coverage forbids unclassified repository `{}`",
                repository.name_with_owner
            ));
        }
        if repository.lifecycle == Lifecycle::Maintained
            && repository.observation != Observation::Inspected
        {
            errors.push(format!(
                "complete coverage requires maintained repository `{}` to be inspected",
                repository.name_with_owner
            ));
        }
        if repository.lifecycle == Lifecycle::Maintained
            && repository.release.mechanism.eq_ignore_ascii_case("unknown")
        {
            errors.push(format!(
                "complete coverage forbids unknown release mechanism for maintained repository `{}`",
                repository.name_with_owner
            ));
        }
        if repository.lifecycle == Lifecycle::Maintained && repository.runtime_surfaces.is_none() {
            errors.push(format!(
                "complete coverage requires runtimeSurfaces review for maintained repository `{}`",
                repository.name_with_owner
            ));
        }
    }
}

fn split_repository_ref(value: &str) -> Option<(&str, &str)> {
    let mut components = value.split('/');
    let owner = components.next()?;
    let repository = components.next()?;
    if components.next().is_some() || owner.trim().is_empty() || repository.trim().is_empty() {
        return None;
    }
    return Some((owner, repository));
}

fn pr_repository(value: &str) -> Option<&str> {
    let (repository, number) = value.rsplit_once('#')?;
    split_repository_ref(repository)?;
    let number = number.parse::<u64>().ok()?;
    if number == 0 {
        return None;
    }
    return Some(repository);
}

#[cfg(test)]
mod tests {
    use super::{Coverage, Dependency, Inventory, Lifecycle, Observation, validate_inventory};

    fn bundled_inventory() -> Inventory {
        let source = include_str!("../../../portfolio/inventory.json");
        let inventory = serde_json::from_str(source).expect("parse bundled inventory");
        return inventory;
    }

    #[test]
    fn bundled_inventory_is_semantically_valid() {
        let inventory = bundled_inventory();
        let summary = validate_inventory(&inventory).expect("validate bundled inventory");
        assert_eq!(summary.coverage, "partial");
        assert!(summary.repository_count > 10);
        assert!(summary.uninspected_organization_count > 0);
        assert!(summary.repositories_missing_runtime_surface_review_count > 0);
    }

    #[test]
    fn duplicate_repository_is_rejected() {
        let mut inventory = bundled_inventory();
        inventory.repositories.push(inventory.repositories[0].clone());
        let errors = validate_inventory(&inventory).expect_err("duplicate must fail");
        assert!(errors.iter().any(|error| error.contains("duplicate repository")));
    }

    #[test]
    fn dangling_dependency_is_rejected() {
        let mut inventory = bundled_inventory();
        inventory.repositories[0].dependencies.push(Dependency {
            target: "missing-org/missing-repo".to_owned(),
            kind: "test".to_owned(),
            source: "regression".to_owned(),
        });
        let errors = validate_inventory(&inventory).expect_err("dangling edge must fail");
        assert!(
            errors
                .iter()
                .any(|error| error.contains("missing from the inventory"))
        );
    }

    #[test]
    fn malformed_pr_reference_is_rejected() {
        let mut inventory = bundled_inventory();
        inventory.pr_dependencies[0].depends_on = vec!["not-a-pr".to_owned()];
        let errors = validate_inventory(&inventory).expect_err("malformed PR must fail");
        assert!(errors.iter().any(|error| error.contains("malformed PR reference")));
    }

    #[test]
    fn uninspected_state_is_valid_only_while_coverage_is_partial() {
        let mut inventory = bundled_inventory();
        inventory.organizations[0].observation = Observation::Uninspected;
        validate_inventory(&inventory).expect("partial coverage permits uninspected state");

        inventory.coverage = Coverage::Complete;
        let errors = validate_inventory(&inventory).expect_err("complete coverage must fail");
        assert!(
            errors
                .iter()
                .any(|error| error.contains("requires organization"))
        );
    }

    #[test]
    fn complete_coverage_requires_runtime_surface_review() {
        let mut inventory = bundled_inventory();
        inventory.coverage = Coverage::Complete;
        let errors = validate_inventory(&inventory).expect_err("missing runtime review must fail");
        assert!(errors.iter().any(|error| error.contains("runtimeSurfaces")));
    }

    #[test]
    fn unclassified_repository_is_partial_only_and_metadata_empty() {
        let mut inventory = bundled_inventory();
        let mut repository = inventory.repositories[0].clone();
        repository.name_with_owner = "ORESoftware/discovered-repository".to_owned();
        repository.lifecycle = Lifecycle::Unclassified;
        repository.role = "unclassified".to_owned();
        repository.observation = Observation::Uninspected;
        repository.contract_authorities.clear();
        repository.dependencies.clear();
        repository.release.mechanism = "unknown".to_owned();
        repository.release.authority = "uninspected".to_owned();
        repository.languages.clear();
        repository.runtime_surfaces = None;
        repository.test_organization = None;
        repository.deployment_consumers.clear();
        repository.linear.project = None;
        repository.linear.issue = None;
        inventory.repositories.push(repository);

        let summary = validate_inventory(&inventory).expect("partial permits unclassified");
        assert_eq!(summary.unclassified_repository_count, 1);

        inventory.coverage = Coverage::Complete;
        let errors = validate_inventory(&inventory).expect_err("complete must reject unclassified");
        assert!(errors.iter().any(|error| error.contains("unclassified repository")));
    }
}
