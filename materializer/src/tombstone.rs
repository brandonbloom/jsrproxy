use crate::job::MaterializationJob;
use crate::publication::ArtifactFile;
use serde::Serialize;
use std::collections::BTreeMap;

const FAILURE_MODULE_PATH: &str = "_jsrproxy_materialization_failure.ts";

/// Stable, safe materialization-failure information visible to package clients.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TombstoneDiagnostic {
    pub id: String,
    pub failure_class: String,
    pub message: String,
    pub status_url: String,
}

/// A complete package artifact for an irreversible yanked failure version.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Tombstone {
    pub files: Vec<ArtifactFile>,
    pub exports: BTreeMap<String, String>,
}

#[derive(Serialize)]
struct TombstoneConfiguration<'a> {
    name: String,
    version: &'a str,
    exports: &'a BTreeMap<String, String>,
}

/// Builds a valid package that fails loudly when an exact yanked version is imported.
pub fn build_tombstone(
    job: &MaterializationJob,
    source_exports: Option<&BTreeMap<String, String>>,
    diagnostic: &TombstoneDiagnostic,
) -> Tombstone {
    let exports = source_exports
        .filter(|exports| !exports.is_empty())
        .map(|source| {
            source
                .keys()
                .map(|key| (key.clone(), format!("./{FAILURE_MODULE_PATH}")))
                .collect()
        })
        .unwrap_or_else(|| BTreeMap::from([(".".to_owned(), format!("./{FAILURE_MODULE_PATH}"))]));
    let configuration = TombstoneConfiguration {
        name: format!("@{}/{}", job.package.scope, job.package.name),
        version: &job.version,
        exports: &exports,
    };
    let mut config_bytes =
        serde_json::to_vec(&configuration).expect("tombstone configuration is serializable");
    config_bytes.push(b'\n');
    let error = format!(
        "jsrproxy materialization failed ({}, {}): {}. See {}",
        diagnostic.id, diagnostic.failure_class, diagnostic.message, diagnostic.status_url
    );
    let failure_module = format!(
        "throw new Error({});\n",
        serde_json::to_string(&error).expect("error is serializable")
    );
    Tombstone {
        files: vec![
            ArtifactFile {
                path: "deno.json".to_owned(),
                bytes: config_bytes,
            },
            ArtifactFile {
                path: FAILURE_MODULE_PATH.to_owned(),
                bytes: failure_module.into_bytes(),
            },
        ],
        exports,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::PackageIdentity;

    fn job() -> MaterializationJob {
        MaterializationJob {
            package: PackageIdentity {
                scope: "acme".into(),
                name: "widget".into(),
            },
            branch: "main".into(),
            commit_sha: "sha".into(),
            version: "1.1.42".into(),
        }
    }

    fn diagnostic() -> TombstoneDiagnostic {
        TombstoneDiagnostic {
            id: "mat-4gdh9".into(),
            failure_class: "missing-exports".into(),
            message: "the root configuration has no exports field".into(),
            status_url: "https://proxy.example/-/status/@acme/widget/1.1.42".into(),
        }
    }

    #[test]
    fn preserves_source_export_keys_and_fails_at_each_one() {
        let exports = BTreeMap::from([
            (".".into(), "./mod.ts".into()),
            ("./sub".into(), "./sub.ts".into()),
        ]);
        let tombstone = build_tombstone(&job(), Some(&exports), &diagnostic());
        assert_eq!(
            tombstone.exports["."],
            "./_jsrproxy_materialization_failure.ts"
        );
        assert_eq!(
            tombstone.exports["./sub"],
            "./_jsrproxy_materialization_failure.ts"
        );
        let config = std::str::from_utf8(&tombstone.files[0].bytes).unwrap();
        assert!(config.contains("@acme/widget"));
        assert!(config.contains("1.1.42"));
        let module = std::str::from_utf8(&tombstone.files[1].bytes).unwrap();
        assert!(module.contains("mat-4gdh9"));
        assert!(module.contains("/-/status/@acme/widget/1.1.42"));
    }

    #[test]
    fn provides_a_default_export_when_source_configuration_is_unavailable() {
        let tombstone = build_tombstone(&job(), None, &diagnostic());
        assert_eq!(
            tombstone.exports,
            BTreeMap::from([(".".into(), "./_jsrproxy_materialization_failure.ts".into())])
        );
    }
}
