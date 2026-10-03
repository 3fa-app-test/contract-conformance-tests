use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path};
use std::process::ExitCode;

use ores_portfolio_inventory::{Coverage, Inventory, load_inventory, validate_inventory};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ShardCoverage {
    Partial,
    Complete,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShardRegistry {
    version: u32,
    coverage: ShardCoverage,
    shards: Vec<ShardReference>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShardReference {
    owner: String,
    path: String,
    source: String,
    observation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryShard {
    version: u32,
    owner: String,
    observation: String,
    source: ShardSource,
    repositories: Vec<ShardRepository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShardSource {
    kind: String,
    pages: Vec<u64>,
    archived_excluded: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShardRepository {
    name_with_owner: String,
    lifecycle: String,
    observation: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ShardValidationSummary {
    schema: &'static str,
    coverage: &'static str,
    shard_count: usize,
    repository_count: usize,
    owner_count: usize,
}

fn main() -> ExitCode {
    let inventory = match load_inventory(Path::new("portfolio/inventory.json")) {
        Ok(inventory) => inventory,
        Err(error) => {
            eprintln!("portfolio shard validation failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(errors) = validate_inventory(&inventory) {
        for error in errors {
            eprintln!("portfolio shard validation refused invalid root inventory: {error}");
        }
        return ExitCode::FAILURE;
    }

    let registry = match load_registry(Path::new("portfolio/repository-shards.json")) {
        Ok(registry) => registry,
        Err(error) => {
            eprintln!("portfolio shard validation failed: {error}");
            return ExitCode::FAILURE;
        }
    };

    match validate_registry_and_shards(&inventory, &registry, Path::new(".")) {
        Ok(summary) => match serde_json::to_string_pretty(&summary) {
            Ok(output) => {
                println!("{output}");
                return ExitCode::SUCCESS;
            }
            Err(error) => {
                eprintln!("portfolio shard validation could not serialize summary: {error}");
                return ExitCode::FAILURE;
            }
        },
        Err(errors) => {
            for error in errors {
                eprintln!("portfolio shard validation failed: {error}");
            }
            return ExitCode::FAILURE;
        }
    }
}

fn load_registry(path: &Path) -> Result<ShardRegistry, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    return serde_json::from_str::<ShardRegistry>(&content)
        .map_err(|error| format!("could not parse {}: {error}", path.display()));
}

fn load_shard(path: &Path) -> Result<RepositoryShard, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    return serde_json::from_str::<RepositoryShard>(&content)
        .map_err(|error| format!("could not parse {}: {error}", path.display()));
}

fn validate_registry_and_shards(
    inventory: &Inventory,
    registry: &ShardRegistry,
    root: &Path,
) -> Result<ShardValidationSummary, Vec<String>> {
    let mut errors = Vec::new();

    if registry.version != 1 {
        errors.push(format!(
            "unsupported repository shard registry version {}; expected 1",
            registry.version
        ));
    }

    let expected_coverage = match inventory.coverage {
        Coverage::Partial => ShardCoverage::Partial,
        Coverage::Complete => ShardCoverage::Complete,
    };
    if registry.coverage != expected_coverage {
        errors.push("repository shard registry coverage must match root inventory coverage".to_owned());
    }

    let governed_owners = inventory
        .organizations
        .iter()
        .map(|organization| organization.login.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let root_repositories = inventory
        .repositories
        .iter()
        .map(|repository| repository.name_with_owner.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();

    let mut shard_paths = BTreeSet::new();
    let mut shard_owners = BTreeSet::new();
    let mut shard_repositories = BTreeSet::new();
    let mut repository_count = 0usize;

    for reference in &registry.shards {
        validate_reference(reference, &mut errors);

        let owner = reference.owner.to_ascii_lowercase();
        if !governed_owners.contains(&owner) {
            errors.push(format!(
                "repository shard owner `{}` is not a governed organization in portfolio/inventory.json",
                reference.owner
            ));
        }
        if !shard_owners.insert(owner.clone()) {
            errors.push(format!(
                "repository shard registry repeats owner `{}`",
                reference.owner
            ));
        }
        if !shard_paths.insert(reference.path.to_ascii_lowercase()) {
            errors.push(format!(
                "repository shard registry repeats path `{}`",
                reference.path
            ));
        }

        let path = root.join(&reference.path);
        let shard = match load_shard(&path) {
            Ok(shard) => shard,
            Err(error) => {
                errors.push(error);
                continue;
            }
        };
        validate_shard_header(reference, &shard, &mut errors);

        for repository in &shard.repositories {
            repository_count += 1;
            validate_shard_repository(
                reference,
                repository,
                &root_repositories,
                &mut shard_repositories,
                &mut errors,
            );
        }
    }

    if inventory.coverage == Coverage::Complete && repository_count > 0 {
        errors.push(format!(
            "complete inventory coverage forbids {repository_count} unclassified repository shard record(s)"
        ));
    }

    let summary = ShardValidationSummary {
        schema: "ores.portfolio-repository-shards-validation/v1",
        coverage: match registry.coverage {
            ShardCoverage::Partial => "partial",
            ShardCoverage::Complete => "complete",
        },
        shard_count: registry.shards.len(),
        repository_count,
        owner_count: shard_owners.len(),
    };

    if errors.is_empty() {
        return Ok(summary);
    }
    return Err(errors);
}

fn validate_reference(reference: &ShardReference, errors: &mut Vec<String>) {
    if reference.owner.trim().is_empty() {
        errors.push("repository shard owner must not be empty".to_owned());
    }
    if reference.source.trim().is_empty() {
        errors.push(format!(
            "repository shard `{}` must declare a discovery source",
            reference.path
        ));
    }
    if reference.observation != "uninspected" {
        errors.push(format!(
            "repository shard `{}` must remain `uninspected` until its repositories are promoted to full inventory records",
            reference.path
        ));
    }

    let path = Path::new(&reference.path);
    let safe_prefix = Path::new("portfolio/repository-shards");
    if path.is_absolute()
        || !path.starts_with(safe_prefix)
        || path.extension().and_then(|extension| extension.to_str()) != Some("json")
        || path.components().any(|component| matches!(component, Component::ParentDir))
    {
        errors.push(format!(
            "repository shard path `{}` must be a safe JSON path below portfolio/repository-shards/",
            reference.path
        ));
    }
}

fn validate_shard_header(
    reference: &ShardReference,
    shard: &RepositoryShard,
    errors: &mut Vec<String>,
) {
    if shard.version != 1 {
        errors.push(format!(
            "repository shard `{}` has unsupported version {}; expected 1",
            reference.path, shard.version
        ));
    }
    if !shard.owner.eq_ignore_ascii_case(&reference.owner) {
        errors.push(format!(
            "repository shard `{}` owner `{}` does not match registry owner `{}`",
            reference.path, shard.owner, reference.owner
        ));
    }
    if shard.observation != "uninspected" {
        errors.push(format!(
            "repository shard `{}` must use observation `uninspected`",
            reference.path
        ));
    }
    if shard.source.kind.trim().is_empty() {
        errors.push(format!(
            "repository shard `{}` must declare a non-empty source kind",
            reference.path
        ));
    }
    if shard.source.pages.is_empty() {
        errors.push(format!(
            "repository shard `{}` must record at least one discovery page",
            reference.path
        ));
    }
    if !shard.source.archived_excluded {
        errors.push(format!(
            "repository shard `{}` must explicitly exclude archived repositories from the active census",
            reference.path
        ));
    }
}

fn validate_shard_repository(
    reference: &ShardReference,
    repository: &ShardRepository,
    root_repositories: &BTreeSet<String>,
    shard_repositories: &mut BTreeSet<String>,
    errors: &mut Vec<String>,
) {
    let Some((owner, name)) = repository.name_with_owner.split_once('/') else {
        errors.push(format!(
            "repository shard `{}` contains malformed repository `{}`",
            reference.path, repository.name_with_owner
        ));
        return;
    };
    if name.trim().is_empty() || owner.trim().is_empty() || name.contains('/') {
        errors.push(format!(
            "repository shard `{}` contains malformed repository `{}`",
            reference.path, repository.name_with_owner
        ));
        return;
    }
    if !owner.eq_ignore_ascii_case(&reference.owner) {
        errors.push(format!(
            "repository shard `{}` repository `{}` does not belong to owner `{}`",
            reference.path, repository.name_with_owner, reference.owner
        ));
    }
    if repository.lifecycle != "unclassified" || repository.observation != "uninspected" {
        errors.push(format!(
            "repository shard `{}` repository `{}` must remain lifecycle `unclassified` and observation `uninspected`",
            reference.path, repository.name_with_owner
        ));
    }

    let normalized = repository.name_with_owner.to_ascii_lowercase();
    if root_repositories.contains(&normalized) {
        errors.push(format!(
            "repository shard `{}` duplicates full root inventory repository `{}`",
            reference.path, repository.name_with_owner
        ));
    }
    if !shard_repositories.insert(normalized) {
        errors.push(format!(
            "repository `{}` is duplicated across repository shards",
            repository.name_with_owner
        ));
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use ores_portfolio_inventory::load_inventory;

    use super::{load_registry, validate_registry_and_shards};

    #[test]
    fn bundled_repository_shards_are_valid_partial_census() {
        let inventory = load_inventory(Path::new("../../../portfolio/inventory.json"))
            .expect("load inventory");
        let registry = load_registry(Path::new("../../../portfolio/repository-shards.json"))
            .expect("load shard registry");
        let summary = validate_registry_and_shards(&inventory, &registry, Path::new("../../.."))
            .expect("validate repository shards");

        assert_eq!(summary.coverage, "partial");
        assert_eq!(summary.shard_count, 1);
        assert_eq!(summary.owner_count, 1);
        assert_eq!(summary.repository_count, 46);
    }
}
