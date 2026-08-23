use serde::{Deserialize, Serialize};
use std::fmt;

/// Identity allocated by the control plane before materialization begins.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageIdentity {
    pub scope: String,
    pub name: String,
}

/// Durable, credential-free input that may be persisted in a Durable Object.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializationJob {
    pub package: PackageIdentity,
    pub branch: String,
    pub commit_sha: String,
    pub version: String,
}

/// An in-memory bearer secret. Its `Debug` implementation never reveals it.
#[derive(Clone, Deserialize, Eq, PartialEq)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString(REDACTED)")
    }
}

/// Container input. The PAT is intentionally excluded from every serialized output.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializationRequest {
    pub job: MaterializationJob,
    #[serde(skip_serializing)]
    pub github_pat: SecretString,
    pub source: SourceRepository,
    pub status_url: String,
}

/// GitHub repository pinned by the control-plane job request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceRepository {
    pub owner: String,
    pub repository: String,
}
