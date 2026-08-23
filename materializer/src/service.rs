use crate::config::{SourceConfiguration, parse_root_configuration};
use crate::job::{MaterializationJob, MaterializationRequest, SourceRepository};
use crate::publication::{ArtifactFile, ArtifactStore, StoreError, publish};
use crate::tombstone::{TombstoneDiagnostic, build_tombstone};
use flate2::read::GzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::io::{Cursor, Read};
use tar::Archive;
use tiny_http::{Header, Method, Response, Server, StatusCode};

const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// Starts the Container-local HTTP listener used by the owning Durable Object.
pub fn serve() -> Result<(), std::io::Error> {
    let server = Server::http("0.0.0.0:8080").map_err(std::io::Error::other)?;
    for mut request in server.incoming_requests() {
        let response = handle(&mut request);
        let _ = request.respond(response);
    }
    Ok(())
}

fn handle(request: &mut tiny_http::Request) -> Response<Cursor<Vec<u8>>> {
    if request.method() == &Method::Get && request.url() == "/health" {
        return plain_response(200, "ok");
    }
    if request.method() != &Method::Post || request.url() != "/materialize-archive" {
        return plain_response(404, "not found");
    }

    let mut body = Vec::new();
    if request
        .as_reader()
        .take(MAX_ARCHIVE_BYTES + 1)
        .read_to_end(&mut body)
        .is_err()
        || body.len() as u64 > MAX_ARCHIVE_BYTES
    {
        return plain_response(400, "invalid materialization request");
    }
    let input = match materialization_input(request) {
        Ok(input)
            if valid_source_component(&input.source.owner)
                && valid_source_component(&input.source.repository) =>
        {
            input
        }
        _ => return plain_response(400, "invalid materialization request"),
    };

    match run_materialization(&input, body) {
        Ok(outcome) => json_response(200, &outcome),
        Err(error) => plain_response(503, &error.message()),
    }
}

fn run_materialization(
    input: &MaterializationRequest,
    archive: Vec<u8>,
) -> Result<MaterializationOutcome, MaterializationError> {
    match source_package(&archive, input) {
        Ok((files, exports)) => {
            let uploads = publish_artifacts(input, files, exports)?;
            Ok(MaterializationOutcome::Ready { uploads })
        }
        Err(failure) => {
            let diagnostic = failure.diagnostic(input);
            let tombstone = build_tombstone(
                &input.job,
                failure.exports.as_ref(),
                &TombstoneDiagnostic {
                    id: diagnostic.id.clone(),
                    failure_class: diagnostic.failure_class.clone(),
                    message: diagnostic.message.clone(),
                    status_url: input.status_url.clone(),
                },
            );
            let uploads = publish_artifacts(input, tombstone.files, tombstone.exports)?;
            Ok(MaterializationOutcome::Yanked {
                diagnostic,
                uploads,
            })
        }
    }
}

fn publish_artifacts(
    input: &MaterializationRequest,
    files: Vec<ArtifactFile>,
    exports: BTreeMap<String, String>,
) -> Result<Vec<BatchedArtifact>, MaterializationError> {
    let mut store = BatchedArtifactStore::default();
    publish(&mut store, &input.job, files, exports)
        .map_err(|error| MaterializationError::ArtifactPublicationUnavailable(error.to_string()))?;
    Ok(store.into_uploads())
}

fn materialization_input(
    request: &tiny_http::Request,
) -> Result<MaterializationRequest, serde_json::Error> {
    let context = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("x-jsrproxy-materialization"))
        .map(|header| header.value.as_str())
        .unwrap_or_default();
    let context = serde_json::from_str::<ArchiveMaterializationContext>(context)?;
    Ok(MaterializationRequest {
        job: context.job,
        source: context.source,
        status_url: context.status_url,
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveMaterializationContext {
    job: MaterializationJob,
    source: SourceRepository,
    status_url: String,
}

fn source_package(
    archive: &[u8],
    input: &MaterializationRequest,
) -> Result<(Vec<ArtifactFile>, BTreeMap<String, String>), SourceFailure> {
    let mut files = unpack_archive(archive)?;
    let config_path = if files.contains_key("deno.json") {
        "deno.json"
    } else if files.contains_key("jsr.json") {
        "jsr.json"
    } else {
        return Err(SourceFailure::new(
            "missing-root-config",
            "the repository has no root deno.json or jsr.json",
            None,
        ));
    };
    let config = parse_root_configuration(&files[config_path])
        .map_err(|error| SourceFailure::new("invalid-root-config", error.to_string(), None))?;
    if !config.imports.is_empty() {
        rewrite_source_imports(&mut files, &config.imports).map_err(|message| {
            SourceFailure::new(
                "unrewritable-import-map",
                message,
                Some(config.exports.clone()),
            )
        })?;
    }
    for path in config.exports.values() {
        let path = path.trim_start_matches("./");
        if !files.contains_key(path) {
            return Err(SourceFailure::new(
                "missing-export-file",
                format!("the exported file {path} is absent from the recorded Git tree"),
                Some(config.exports),
            ));
        }
    }

    files.remove("deno.json");
    files.remove("jsr.json");
    let package_config = emitted_configuration(input, &config).map_err(|_| {
        SourceFailure::new(
            "invalid-root-config",
            "the root configuration could not be rewritten",
            Some(config.exports.clone()),
        )
    })?;
    files.insert("deno.json".to_owned(), package_config);
    Ok((
        files
            .into_iter()
            .map(|(path, bytes)| ArtifactFile { path, bytes })
            .collect(),
        config.exports,
    ))
}

fn rewrite_source_imports(
    files: &mut BTreeMap<String, Vec<u8>>,
    imports: &BTreeMap<String, String>,
) -> Result<(), String> {
    for (path, bytes) in files.iter_mut() {
        if !matches!(
            path.rsplit_once('.').map(|(_, extension)| extension),
            Some("ts" | "mts" | "cts" | "tsx" | "js" | "mjs" | "cjs" | "jsx")
        ) {
            continue;
        }
        *bytes = rewrite_module_specifiers(path, bytes, imports)?.into_bytes();
    }
    Ok(())
}

fn rewrite_module_specifiers(
    path: &str,
    bytes: &[u8],
    imports: &BTreeMap<String, String>,
) -> Result<String, String> {
    let source =
        std::str::from_utf8(bytes).map_err(|_| format!("source file {path} is not UTF-8"))?;
    let mut aliases: Vec<&str> = imports.keys().map(String::as_str).collect();
    aliases.sort_by_key(|alias| std::cmp::Reverse(alias.len()));
    let mut rewritten = source.to_owned();
    for alias in aliases {
        let replacement = rewrite_specifier(path, alias, imports);
        if alias.ends_with('/') {
            rewritten = rewritten.replace(&format!("\"{alias}"), &format!("\"{replacement}"));
            rewritten = rewritten.replace(&format!("'{alias}"), &format!("'{replacement}"));
        } else {
            rewritten = rewritten.replace(&format!("\"{alias}\""), &format!("\"{replacement}\""));
            rewritten = rewritten.replace(&format!("'{alias}'"), &format!("'{replacement}'"));
        }
    }
    Ok(rewritten)
}

fn rewrite_specifier(
    source_path: &str,
    specifier: &str,
    imports: &BTreeMap<String, String>,
) -> String {
    let candidate = imports
        .iter()
        .filter_map(|(alias, target)| {
            let suffix = if alias.ends_with('/') {
                specifier.strip_prefix(alias)
            } else if specifier == alias {
                Some("")
            } else {
                None
            }?;
            Some((alias.len(), target, suffix))
        })
        .max_by_key(|(length, _, _)| *length);
    let Some((_, target, suffix)) = candidate else {
        return specifier.to_owned();
    };
    if let Some(target) = target.strip_prefix("./") {
        return relative_specifier(source_path, &format!("{target}{suffix}"));
    }
    format!("{target}{suffix}")
}

fn relative_specifier(source_path: &str, target_path: &str) -> String {
    let source: Vec<&str> = source_path.split('/').collect();
    let source_directory = &source[..source.len().saturating_sub(1)];
    let target: Vec<&str> = target_path.split('/').collect();
    let shared = source_directory
        .iter()
        .zip(&target)
        .take_while(|(left, right)| left == right)
        .count();
    let mut components = Vec::new();
    components.extend(std::iter::repeat_n("..", source_directory.len() - shared));
    components.extend(&target[shared..]);
    let value = components.join("/");
    if value.starts_with("..") {
        value
    } else {
        format!("./{value}")
    }
}

fn unpack_archive(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, SourceFailure> {
    let decoder = GzDecoder::new(bytes);
    let mut archive = Archive::new(decoder);
    let mut files = BTreeMap::new();
    for entry in archive.entries().map_err(|_| {
        SourceFailure::new(
            "invalid-source-archive",
            "GitHub returned an unreadable source archive",
            None,
        )
    })? {
        let entry = entry.map_err(|_| {
            SourceFailure::new(
                "invalid-source-archive",
                "GitHub returned an unreadable source archive",
                None,
            )
        })?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(|_| {
            SourceFailure::new(
                "invalid-source-archive",
                "GitHub returned an invalid source path",
                None,
            )
        })?;
        let path = path.to_string_lossy();
        let mut parts = path.split('/');
        let _archive_root = parts.next();
        let relative: Vec<&str> = parts.collect();
        if relative.is_empty() {
            continue;
        }
        if relative
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
        {
            return Err(SourceFailure::new(
                "invalid-source-archive",
                "GitHub returned an unsafe source path",
                None,
            ));
        }
        let relative = relative.join("/");
        let mut contents = Vec::new();
        entry
            .take(MAX_SOURCE_FILE_BYTES + 1)
            .read_to_end(&mut contents)
            .map_err(|_| {
                SourceFailure::new(
                    "invalid-source-archive",
                    "GitHub returned an unreadable source file",
                    None,
                )
            })?;
        if contents.len() as u64 > MAX_SOURCE_FILE_BYTES {
            return Err(SourceFailure::new(
                "source-file-too-large",
                "a source file exceeds the materializer limit",
                None,
            ));
        }
        if files.insert(relative.clone(), contents).is_some() {
            return Err(SourceFailure::new(
                "invalid-source-archive",
                "GitHub returned duplicate source paths",
                None,
            ));
        }
    }
    Ok(files)
}

fn emitted_configuration(
    input: &MaterializationRequest,
    config: &SourceConfiguration,
) -> Result<Vec<u8>, serde_json::Error> {
    #[derive(Serialize)]
    struct Configuration<'a> {
        name: String,
        version: &'a str,
        exports: &'a BTreeMap<String, String>,
    }
    let mut bytes = serde_json::to_vec(&Configuration {
        name: format!("@{}/{}", input.job.package.scope, input.job.package.name),
        version: &input.job.version,
        exports: &config.exports,
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn valid_source_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[derive(Default)]
struct BatchedArtifactStore {
    uploads: Vec<BatchedArtifact>,
}

#[derive(Serialize)]
struct BatchedArtifact {
    key: String,
    sha256: String,
    body: String,
}

impl ArtifactStore for BatchedArtifactStore {
    fn put_if_absent(&mut self, key: &str, bytes: &[u8], sha256: &str) -> Result<(), StoreError> {
        self.uploads.push(BatchedArtifact {
            key: key.to_owned(),
            sha256: sha256.to_owned(),
            body: base64_encode(bytes),
        });
        Ok(())
    }
}

impl BatchedArtifactStore {
    fn into_uploads(self) -> Vec<BatchedArtifact> {
        self.uploads
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        encoded.push(ALPHABET[(first >> 2) as usize] as char);
        encoded.push(ALPHABET[((first & 0b0000_0011) << 4 | second >> 4) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            ALPHABET[((second & 0b0000_1111) << 2 | third >> 6) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            ALPHABET[(third & 0b0011_1111) as usize] as char
        } else {
            '='
        });
    }
    encoded
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum MaterializationOutcome {
    Ready {
        uploads: Vec<BatchedArtifact>,
    },
    Yanked {
        diagnostic: CompletionDiagnostic,
        uploads: Vec<BatchedArtifact>,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletionDiagnostic {
    id: String,
    failure_class: String,
    message: String,
}

enum MaterializationError {
    ArtifactPublicationUnavailable(String),
}

impl MaterializationError {
    fn message(&self) -> String {
        match self {
            Self::ArtifactPublicationUnavailable(error) => {
                format!("artifact publication unavailable: {error}")
            }
        }
    }
}

#[derive(Debug)]
struct SourceFailure {
    failure_class: &'static str,
    message: String,
    exports: Option<BTreeMap<String, String>>,
}

impl SourceFailure {
    fn new(
        failure_class: &'static str,
        message: impl Into<String>,
        exports: Option<BTreeMap<String, String>>,
    ) -> Self {
        Self {
            failure_class,
            message: message.into(),
            exports,
        }
    }

    fn diagnostic(&self, input: &MaterializationRequest) -> CompletionDiagnostic {
        let mut digest = Sha256::new();
        digest.update(input.job.version.as_bytes());
        digest.update(self.failure_class.as_bytes());
        digest.update(self.message.as_bytes());
        let id = format!("mat-{:x}", digest.finalize());
        CompletionDiagnostic {
            id: id[..16].to_owned(),
            failure_class: self.failure_class.to_owned(),
            message: self.message.clone(),
        }
    }
}

impl fmt::Display for MaterializationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message())
    }
}

fn plain_response(status: u16, body: &str) -> Response<Cursor<Vec<u8>>> {
    response(
        status,
        body.as_bytes().to_vec(),
        "text/plain; charset=utf-8",
    )
}

fn json_response(status: u16, value: &impl Serialize) -> Response<Cursor<Vec<u8>>> {
    match serde_json::to_vec(value) {
        Ok(body) => response(status, body, "application/json"),
        Err(_) => plain_response(500, "materialization unavailable"),
    }
}

fn response(status: u16, body: Vec<u8>, content_type: &str) -> Response<Cursor<Vec<u8>>> {
    let mut response = Response::from_data(body).with_status_code(StatusCode(status));
    response.add_header(
        Header::from_bytes("content-type", content_type).expect("static header is valid"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::{MaterializationJob, PackageIdentity, SourceRepository};
    use flate2::{Compression, write::GzEncoder};
    use tar::Builder;

    fn request() -> MaterializationRequest {
        MaterializationRequest {
            job: MaterializationJob {
                package: PackageIdentity {
                    scope: "acme".into(),
                    name: "widget".into(),
                },
                branch: "main".into(),
                commit_sha: "abc".into(),
                version: "0.1.42".into(),
            },
            source: SourceRepository {
                owner: "acme".into(),
                repository: "widget".into(),
            },
            status_url: "https://proxy.invalid/-/status/@acme/widget".into(),
        }
    }

    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut tar = Builder::new(encoder);
        for (path, contents) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, format!("repo-sha/{path}"), *contents)
                .unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn rewrites_a_simple_root_configuration() {
        let result = source_package(
            &archive(&[
                ("deno.json", br#"{"exports":"./mod.ts"}"#),
                ("mod.ts", b"export const answer = 42;\n"),
            ]),
            &request(),
        )
        .unwrap();
        assert_eq!(result.1, BTreeMap::from([(".".into(), "./mod.ts".into())]));
        let config = result
            .0
            .iter()
            .find(|file| file.path == "deno.json")
            .unwrap();
        assert_eq!(
            std::str::from_utf8(&config.bytes).unwrap(),
            "{\"name\":\"@acme/widget\",\"version\":\"0.1.42\",\"exports\":{\".\":\"./mod.ts\"}}\n"
        );
    }

    #[test]
    fn reports_missing_exports_as_a_deterministic_failure() {
        let failure = source_package(&archive(&[("deno.json", br#"{"imports":{}}"#)]), &request())
            .unwrap_err();
        assert_eq!(failure.failure_class, "invalid-root-config");
        assert!(failure.message.contains("no exports"));
    }

    #[test]
    fn rewrites_import_map_specifiers_for_external_and_internal_dependencies() {
        let result = source_package(
            &archive(&[
                (
                    "deno.json",
                    br#"{"exports":"./src/cli/index.ts","imports":{"@std/assert":"jsr:@std/assert@1.0.19","~/":"./src/"}}"#,
                ),
                (
                    "src/cli/index.ts",
                    b"import { assert } from '@std/assert';\nimport { value } from '~/value.ts';\nexport { assert, value };\n",
                ),
                ("src/value.ts", b"export const value = true;\n"),
            ]),
            &request(),
        )
        .unwrap();
        let entrypoint = result
            .0
            .iter()
            .find(|file| file.path == "src/cli/index.ts")
            .unwrap();
        assert_eq!(
            std::str::from_utf8(&entrypoint.bytes).unwrap(),
            "import { assert } from 'jsr:@std/assert@1.0.19';\nimport { value } from '../value.ts';\nexport { assert, value };\n"
        );
    }
}
