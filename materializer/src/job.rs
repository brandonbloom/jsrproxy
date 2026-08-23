use serde::{Deserialize, Serialize};

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

/// Credential-free Container input derived by the Worker after it fetches source bytes.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializationRequest {
    pub job: MaterializationJob,
    pub source: SourceRepository,
    pub status_url: String,
}

/// GitHub repository pinned by the control-plane job request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceRepository {
    pub owner: String,
    pub repository: String,
}
