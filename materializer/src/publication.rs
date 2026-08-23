use crate::job::MaterializationJob;
use crate::media_type;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;

/// A rewritten package file, with bytes exactly as they will be served.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// The JSR manifest record for one file.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ManifestEntry {
    pub size: usize,
    pub checksum: String,
}

/// Immutable metadata written beside a published package version.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PackageMetadata {
    pub manifest: BTreeMap<String, ManifestEntry>,
    pub exports: BTreeMap<String, String>,
    #[serde(rename = "jsrproxy")]
    pub provenance: Provenance,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Provenance {
    pub branch: String,
    pub commit_sha: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct ReadyMarker<'a> {
    manifest_sha256: &'a str,
}

/// Result from a successful immutable publication.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicationResult {
    pub metadata: PackageMetadata,
    pub manifest_sha256: String,
    pub metadata_key: String,
    pub ready_marker_key: String,
}

/// Storage behavior required from the outbound Worker/R2 handler.
pub trait ArtifactStore {
    /// Creates a key once. An existing key is accepted only when its content hash matches.
    fn put_if_absent(&mut self, key: &str, bytes: &[u8], sha256: &str) -> Result<(), StoreError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StoreError {
    ExistingObjectHasDifferentHash { key: String },
    Unavailable(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExistingObjectHasDifferentHash { key } => {
                write!(formatter, "existing object has a different hash: {key}")
            }
            Self::Unavailable(message) => write!(formatter, "storage unavailable: {message}"),
        }
    }
}

impl std::error::Error for StoreError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PublicationError {
    InvalidPath(String),
    DuplicatePath(String),
    Storage(StoreError),
    Serialization(String),
}

impl fmt::Display for PublicationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath(path) => write!(formatter, "invalid package path: {path}"),
            Self::DuplicatePath(path) => write!(formatter, "duplicate package path: {path}"),
            Self::Storage(error) => error.fmt(formatter),
            Self::Serialization(message) => {
                write!(formatter, "metadata serialization failed: {message}")
            }
        }
    }
}

impl std::error::Error for PublicationError {}

///
/// Publishes immutable files and metadata, then the ready marker last.
///
/// A caller must mark the version ready in its Durable Object only after this
/// returns. On an error, partial objects remain unreachable because no ready
/// marker is written.
pub fn publish(
    store: &mut impl ArtifactStore,
    job: &MaterializationJob,
    files: impl IntoIterator<Item = ArtifactFile>,
    exports: BTreeMap<String, String>,
) -> Result<PublicationResult, PublicationError> {
    let base = package_key_prefix(job);
    let mut manifest = BTreeMap::new();

    for file in files {
        validate_path(&file.path)?;
        let checksum = sha256_hex(&file.bytes);
        let entry = ManifestEntry {
            size: file.bytes.len(),
            checksum: format!("sha256-{checksum}"),
        };
        if manifest.insert(file.path.clone(), entry).is_some() {
            return Err(PublicationError::DuplicatePath(file.path));
        }
        let key = format!("{base}/{}", file.path);
        store
            .put_if_absent(&key, &file.bytes, &checksum)
            .map_err(PublicationError::Storage)?;
    }

    let manifest_bytes = serde_json::to_vec(&manifest)
        .map_err(|error| PublicationError::Serialization(error.to_string()))?;
    let manifest_sha256 = sha256_hex(&manifest_bytes);
    let metadata = PackageMetadata {
        manifest,
        exports,
        provenance: Provenance {
            branch: job.branch.clone(),
            commit_sha: job.commit_sha.clone(),
        },
    };
    let metadata_bytes = serde_json::to_vec(&metadata)
        .map_err(|error| PublicationError::Serialization(error.to_string()))?;
    let metadata_key = format!("{base}_meta.json");
    store
        .put_if_absent(&metadata_key, &metadata_bytes, &sha256_hex(&metadata_bytes))
        .map_err(PublicationError::Storage)?;

    let marker = ReadyMarker {
        manifest_sha256: &manifest_sha256,
    };
    let marker_bytes = serde_json::to_vec(&marker)
        .map_err(|error| PublicationError::Serialization(error.to_string()))?;
    let ready_marker_key = format!("{base}.ready.json");
    store
        .put_if_absent(&ready_marker_key, &marker_bytes, &sha256_hex(&marker_bytes))
        .map_err(PublicationError::Storage)?;

    Ok(PublicationResult {
        metadata,
        manifest_sha256,
        metadata_key,
        ready_marker_key,
    })
}

/// Returns the content type attached by the Worker when serving this file.
pub fn content_type(path: &str) -> &'static str {
    media_type::for_path(path)
}

fn package_key_prefix(job: &MaterializationJob) -> String {
    format!(
        "synthetic/{}/{}/{}",
        job.package.scope, job.package.name, job.version
    )
}

fn validate_path(path: &str) -> Result<(), PublicationError> {
    if path.is_empty()
        || path.starts_with('/')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(PublicationError::InvalidPath(path.to_owned()));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::{PackageIdentity, SecretString};
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore {
        objects: HashMap<String, (Vec<u8>, String)>,
        writes: Vec<String>,
    }

    impl ArtifactStore for MemoryStore {
        fn put_if_absent(
            &mut self,
            key: &str,
            bytes: &[u8],
            sha256: &str,
        ) -> Result<(), StoreError> {
            if let Some((_, existing_hash)) = self.objects.get(key) {
                return if existing_hash == sha256 {
                    Ok(())
                } else {
                    Err(StoreError::ExistingObjectHasDifferentHash {
                        key: key.to_owned(),
                    })
                };
            }
            self.objects
                .insert(key.to_owned(), (bytes.to_vec(), sha256.to_owned()));
            self.writes.push(key.to_owned());
            Ok(())
        }
    }

    fn job() -> MaterializationJob {
        MaterializationJob {
            package: PackageIdentity {
                scope: "acme".into(),
                name: "widget".into(),
            },
            branch: "main".into(),
            commit_sha: "0123456789abcdef".into(),
            version: "0.1.42".into(),
        }
    }

    #[test]
    fn publishes_served_bytes_then_metadata_then_ready_marker() {
        let mut store = MemoryStore::default();
        let result = publish(
            &mut store,
            &job(),
            [ArtifactFile {
                path: "mod.ts".into(),
                bytes: b"export const answer: number = 42;\n".to_vec(),
            }],
            BTreeMap::from([(".".into(), "./mod.ts".into())]),
        )
        .unwrap();

        assert_eq!(
            result.metadata.manifest["mod.ts"].checksum,
            "sha256-5bebe5892144e93811698b7ea8f0b449227c33d057fd3c08294e32e94fe2524a"
        );
        assert_eq!(content_type("mod.ts"), "application/typescript");
        assert_eq!(store.writes.last(), Some(&result.ready_marker_key));
        assert!(store.objects.contains_key(&result.metadata_key));
    }

    #[test]
    fn accepts_idempotent_writes_and_rejects_collisions() {
        let mut store = MemoryStore::default();
        let files = [ArtifactFile {
            path: "mod.ts".into(),
            bytes: b"export {};".to_vec(),
        }];
        publish(&mut store, &job(), files.clone(), BTreeMap::new()).unwrap();
        publish(&mut store, &job(), files, BTreeMap::new()).unwrap();
        let error = publish(
            &mut store,
            &job(),
            [ArtifactFile {
                path: "mod.ts".into(),
                bytes: b"export const changed = true;".to_vec(),
            }],
            BTreeMap::new(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            PublicationError::Storage(StoreError::ExistingObjectHasDifferentHash { .. })
        ));
    }

    #[test]
    fn rejects_paths_that_escape_the_package() {
        let error = publish(
            &mut MemoryStore::default(),
            &job(),
            [ArtifactFile {
                path: "../secret.ts".into(),
                bytes: vec![],
            }],
            BTreeMap::new(),
        )
        .unwrap_err();
        assert_eq!(error, PublicationError::InvalidPath("../secret.ts".into()));
    }

    #[test]
    fn redacts_the_pat_in_debug_output() {
        let request = crate::job::MaterializationRequest {
            job: job(),
            github_pat: SecretString::new("github_pat_secret"),
        };
        assert!(!format!("{request:?}").contains("github_pat_secret"));
    }
}
