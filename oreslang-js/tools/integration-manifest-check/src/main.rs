use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::collections::BTreeMap;
use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;

const PROTOCOL: &str = "oreslang-ecosystem-integration";
const NOTE: &str = "Declared integration touchpoints only; no CI or runtime parity is asserted.";
const MAX_BYTES: usize = 4096;
const EXPECTED_KEYS: [&str; 7] = [
    "schemaVersion",
    "protocol",
    "repository",
    "role",
    "upstreams",
    "evidence",
    "note",
];

#[derive(Debug, Clone, PartialEq)]
enum StrictValue {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<StrictValue>),
    Object(BTreeMap<String, StrictValue>),
}

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct StrictVisitor;

        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictValue;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON value")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(StrictValue::Bool(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(StrictValue::Number(value.into()))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(StrictValue::Number(value.into()))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                serde_json::Number::from_f64(value)
                    .map(StrictValue::Number)
                    .ok_or_else(|| E::custom("non-finite JSON number"))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(StrictValue::String(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(StrictValue::String(value))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(StrictValue::Null)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(StrictValue::Null)
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element::<StrictValue>()? {
                    values.push(value);
                }
                Ok(StrictValue::Array(values))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, StrictValue>()? {
                    if values.insert(key.clone(), value).is_some() {
                        return Err(de::Error::custom(format!("duplicate JSON key: {key:?}")));
                    }
                }
                Ok(StrictValue::Object(values))
            }
        }

        deserializer.deserialize_any(StrictVisitor)
    }
}

fn expected_upstreams(repository: &str) -> Option<&'static [&'static str]> {
    match repository {
        "oreslang-source.java" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        "oreslang-source.llvm" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        "oreslang-source.wasm" => Some(&[
            "oreslang-source.llvm",
            "oreslang-target-profiles",
            "oreslang-wasm",
        ]),
        "oreslang-source.js" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        "oreslang-source.hdl" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        "oreslang-source.forge" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        "oreslang-source.net" => Some(&["oreslang-common-source", "oreslang-target-profiles"]),
        _ => None,
    }
}

fn parse_strict_json(raw: &[u8]) -> Result<StrictValue, String> {
    let decoded =
        std::str::from_utf8(raw).map_err(|_| "manifest must be valid UTF-8".to_owned())?;
    if decoded.starts_with('﻿') {
        return Err("UTF-8 BOM is prohibited".to_owned());
    }

    let mut deserializer = serde_json::Deserializer::from_str(decoded);
    let value = StrictValue::deserialize(&mut deserializer)
        .map_err(|error| format!("invalid JSON: {error}"))?;
    deserializer
        .end()
        .map_err(|error| format!("invalid JSON: {error}"))?;
    Ok(value)
}

fn string_value<'a>(
    object: &'a BTreeMap<String, StrictValue>,
    key: &str,
) -> Result<&'a str, String> {
    match object.get(key) {
        Some(StrictValue::String(value)) => Ok(value),
        _ => Err(format!("{key} must be a string")),
    }
}

fn verify_bytes(raw: &[u8], repository_name: &str) -> Result<(), String> {
    let expected = expected_upstreams(repository_name).ok_or("unknown source repository")?;
    if raw.is_empty() || raw.len() > MAX_BYTES {
        return Err("manifest is empty or oversized".to_owned());
    }

    let value = parse_strict_json(raw)?;
    let StrictValue::Object(object) = value else {
        return Err("manifest must contain exactly the seven declared keys".to_owned());
    };

    if object.len() != EXPECTED_KEYS.len()
        || EXPECTED_KEYS.iter().any(|key| !object.contains_key(*key))
    {
        return Err("manifest must contain exactly the seven declared keys".to_owned());
    }

    match object.get("schemaVersion") {
        Some(StrictValue::Number(number)) if number.as_u64() == Some(1) => {}
        _ => return Err("unsupported schema version".to_owned()),
    }

    if string_value(&object, "protocol")? != PROTOCOL {
        return Err("unsupported protocol".to_owned());
    }

    let expected_repository = format!("ores-truffle-oreslang/{repository_name}");
    if string_value(&object, "repository")? != expected_repository {
        return Err("repository identity mismatch".to_owned());
    }

    if string_value(&object, "role")? != "compiler" {
        return Err("unexpected integration role".to_owned());
    }

    let Some(StrictValue::Array(upstreams)) = object.get("upstreams") else {
        return Err("upstreams must be a string array".to_owned());
    };
    let actual: Result<Vec<&str>, String> = upstreams
        .iter()
        .map(|value| match value {
            StrictValue::String(text) => Ok(text.as_str()),
            _ => Err("upstreams must be a string array".to_owned()),
        })
        .collect();
    let actual = actual?;
    if actual.as_slice() != expected {
        return Err("unexpected, reordered, or duplicate upstream dependencies".to_owned());
    }

    if string_value(&object, "evidence")? != "not-attested" {
        return Err("unverified parity/CI attestation is forbidden".to_owned());
    }

    if string_value(&object, "note")? != NOTE {
        return Err("evidence disclaimer was changed".to_owned());
    }

    Ok(())
}

fn repository_root_from_args() -> Result<PathBuf, String> {
    let mut args = env::args_os().skip(1);
    match (args.next(), args.next(), args.next()) {
        (None, None, None) => env::current_dir().map_err(|error| error.to_string()),
        (Some(flag), Some(root), None) if flag == "--repository-root" => Ok(PathBuf::from(root)),
        _ => Err("usage: integration-manifest-check [--repository-root PATH]".to_owned()),
    }
}

fn verify_repository(root: &Path) -> Result<String, String> {
    let root =
        fs::canonicalize(root).map_err(|error| format!("repository root unavailable: {error}"))?;
    let repository_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("repository root has no UTF-8 name")?
        .to_owned();
    let manifest = root.join(".oreslang/integration.json");

    let metadata = fs::symlink_metadata(&manifest)
        .map_err(|error| format!("manifest missing or unreadable: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("manifest missing or symlinked".to_owned());
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err("manifest exceeds size limit".to_owned());
    }

    let raw = fs::read(&manifest).map_err(|error| format!("manifest unreadable: {error}"))?;
    verify_bytes(&raw, &repository_name)?;
    Ok(repository_name)
}

fn main() {
    let root = repository_root_from_args().unwrap_or_else(|error| {
        eprintln!("integration manifest DENIED: {error}");
        process::exit(2);
    });

    match verify_repository(&root) {
        Ok(repository_name) => {
            println!(
                "integration declaration verified: {repository_name}; evidence remains not-attested"
            );
        }
        Err(error) => {
            eprintln!("integration manifest DENIED: {error}");
            process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_manifest(repository: &str) -> Vec<u8> {
        let upstreams = expected_upstreams(repository).unwrap();
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "protocol": PROTOCOL,
            "repository": format!("ores-truffle-oreslang/{repository}"),
            "role": "compiler",
            "upstreams": upstreams,
            "evidence": "not-attested",
            "note": NOTE,
        }))
        .unwrap()
    }

    fn assert_reject(raw: &[u8], repository: &str) {
        assert!(
            verify_bytes(raw, repository).is_err(),
            "payload unexpectedly accepted: {}",
            String::from_utf8_lossy(raw)
        );
    }

    #[test]
    fn all_seven_backends_are_accepted() {
        for repository in [
            "oreslang-source.java",
            "oreslang-source.llvm",
            "oreslang-source.wasm",
            "oreslang-source.js",
            "oreslang-source.hdl",
            "oreslang-source.forge",
            "oreslang-source.net",
        ] {
            verify_bytes(&valid_manifest(repository), repository).unwrap();
        }
    }

    #[test]
    fn real_local_manifest_is_valid() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let raw = fs::read(root.join(".oreslang/integration.json")).unwrap();
        verify_bytes(&raw, "oreslang-source.js").unwrap();
    }

    #[test]
    fn duplicate_key_is_rejected() {
        assert_reject(
            br#"{"schemaVersion":1,"schemaVersion":1,"protocol":"oreslang-ecosystem-integration","repository":"ores-truffle-oreslang/oreslang-source.java","role":"compiler","upstreams":["oreslang-common-source","oreslang-target-profiles"],"evidence":"not-attested","note":"Declared integration touchpoints only; no CI or runtime parity is asserted."}"#,
            "oreslang-source.java",
        );
    }

    #[test]
    fn unsupported_repo_is_rejected() {
        assert_reject(
            &valid_manifest("oreslang-source.java"),
            "oreslang-source.invented",
        );
    }

    #[test]
    fn repository_mismatch_is_rejected() {
        assert_reject(
            &valid_manifest("oreslang-source.llvm"),
            "oreslang-source.java",
        );
    }

    #[test]
    fn evidence_claim_is_rejected() {
        for claim in ["passed", "attested", "verified"] {
            let mut value: serde_json::Value =
                serde_json::from_slice(&valid_manifest("oreslang-source.java")).unwrap();
            value["evidence"] = json!(claim);
            assert_reject(&serde_json::to_vec(&value).unwrap(), "oreslang-source.java");
        }
    }

    #[test]
    fn upstream_injection_reordering_and_duplicates_are_rejected() {
        let cases = [
            json!([]),
            json!(["oreslang-target-profiles", "oreslang-common-source"]),
            json!(["oreslang-common-source", "oreslang-common-source"]),
            json!(["../oreslang-target-profiles"]),
            json!([
                "oreslang-common-source",
                "oreslang-target-profiles",
                "other"
            ]),
        ];
        for upstreams in cases {
            let mut value: serde_json::Value =
                serde_json::from_slice(&valid_manifest("oreslang-source.java")).unwrap();
            value["upstreams"] = upstreams;
            assert_reject(&serde_json::to_vec(&value).unwrap(), "oreslang-source.java");
        }
    }

    #[test]
    fn unknown_and_missing_fields_are_rejected() {
        let mut unknown: serde_json::Value =
            serde_json::from_slice(&valid_manifest("oreslang-source.java")).unwrap();
        unknown["runtimeParity"] = json!(true);
        assert_reject(
            &serde_json::to_vec(&unknown).unwrap(),
            "oreslang-source.java",
        );

        let mut missing: serde_json::Value =
            serde_json::from_slice(&valid_manifest("oreslang-source.java")).unwrap();
        missing.as_object_mut().unwrap().remove("note");
        assert_reject(
            &serde_json::to_vec(&missing).unwrap(),
            "oreslang-source.java",
        );
    }

    #[test]
    fn schema_bool_invalid_constants_oversize_utf8_and_bom_are_rejected() {
        let mut bool_schema: serde_json::Value =
            serde_json::from_slice(&valid_manifest("oreslang-source.java")).unwrap();
        bool_schema["schemaVersion"] = json!(true);
        assert_reject(
            &serde_json::to_vec(&bool_schema).unwrap(),
            "oreslang-source.java",
        );
        assert_reject(br#"{"schemaVersion":NaN}"#, "oreslang-source.java");
        assert_reject(&vec![b' '; MAX_BYTES + 1], "oreslang-source.java");
        assert_reject(&[0xff], "oreslang-source.java");

        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend(valid_manifest("oreslang-source.java"));
        assert_reject(&bom, "oreslang-source.java");
    }

    #[test]
    fn noncanonical_note_is_rejected() {
        let mut value: serde_json::Value =
            serde_json::from_slice(&valid_manifest("oreslang-source.java")).unwrap();
        value["note"] = json!("CI parity is asserted.");
        assert_reject(&serde_json::to_vec(&value).unwrap(), "oreslang-source.java");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_manifest_is_rejected() {
        use std::os::unix::fs::symlink;

        let base = env::temp_dir().join(format!(
            "oreslang-integration-manifest-test-{}",
            process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("oreslang-source.java");
        fs::create_dir_all(root.join(".oreslang")).unwrap();
        let external = base.join("external.json");
        fs::write(&external, valid_manifest("oreslang-source.java")).unwrap();
        symlink(&external, root.join(".oreslang/integration.json")).unwrap();

        let result = verify_repository(&root);
        let _ = fs::remove_dir_all(&base);
        assert!(result.is_err());
    }
}
