//! Native materialization primitives shared by the Container HTTP process and
//! its tests. GitHub fetching and Deno's publish-specifier rewriting are added
//! behind the same job boundary; this crate already owns immutable publication.

pub mod config;
pub mod job;
pub mod media_type;
pub mod publication;
pub mod tombstone;

pub use job::{MaterializationJob, MaterializationRequest, PackageIdentity, SecretString};
pub use publication::{
    ArtifactFile, ArtifactStore, ManifestEntry, PackageMetadata, PublicationError,
    PublicationResult, publish,
};
pub use tombstone::{Tombstone, TombstoneDiagnostic, build_tombstone};
