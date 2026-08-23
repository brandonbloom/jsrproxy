use crate::config::{SourceConfiguration, parse_root_configuration};
use crate::job::{MaterializationJob, MaterializationRequest, SourceRepository};
use crate::publication::{ArtifactFile, ArtifactStore, StoreError, publish};
use crate::tombstone::{TombstoneDiagnostic, build_tombstone};
use flate2::read::GzDecoder;
use reqwest::blocking::Client;
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
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(std::io::Error::other)?;
    for mut request in server.incoming_requests() {
        let response = handle(&mut request, &client);
        let _ = request.respond(response);
    }
    Ok(())
}

fn handle(request: &mut tiny_http::Request, client: &Client) -> Response<Cursor<Vec<u8>>> {
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

    match run_materialization(&input, body, client) {
        Ok(outcome) => json_response(200, &outcome),
        Err(error) => plain_response(503, &error.message()),
    }
}

fn run_materialization(
    input: &MaterializationRequest,
    archive: Vec<u8>,
    client: &Client,
) -> Result<MaterializationOutcome, MaterializationError> {
    match source_package(&archive, input) {
        Ok((files, exports)) => {
            let mut store = HttpArtifactStore { client };
            publish(&mut store, &input.job, files, exports)
                .map_err(|error| MaterializationError::ArtifactPublicationUnavailable(error.to_string()))?;
            Ok(MaterializationOutcome::Ready)
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
            let mut store = HttpArtifactStore { client };
            publish(&mut store, &input.job, tombstone.files, tombstone.exports)
                .map_err(|error| MaterializationError::ArtifactPublicationUnavailable(error.to_string()))?;
            Ok(MaterializationOutcome::Yanked { diagnostic })
        }
    }
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
        return Err(SourceFailure::new(
            "unsupported-import-map",
            "the initial materializer cannot rewrite a source import map",
            Some(config.exports),
        ));
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

struct HttpArtifactStore<'a> {
    client: &'a Client,
}

impl ArtifactStore for HttpArtifactStore<'_> {
    fn put_if_absent(&mut self, key: &str, bytes: &[u8], sha256: &str) -> Result<(), StoreError> {
        let response = self
            .client
            .put(format!("http://artifacts.r2/{key}"))
            .header("x-jsrproxy-sha256", sha256)
            .body(bytes.to_vec())
            .send()
            .map_err(|_| StoreError::Unavailable("artifact upload failed".to_owned()))?;
        match response.status().as_u16() {
            200 | 201 => Ok(()),
            409 => Err(StoreError::ExistingObjectHasDifferentHash {
                key: key.to_owned(),
            }),
            status => Err(StoreError::Unavailable(format!("artifact upload returned HTTP {status}"))),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum MaterializationOutcome {
    Ready,
    Yanked { diagnostic: CompletionDiagnostic },
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
            Self::ArtifactPublicationUnavailable(error) => format!("artifact publication unavailable: {error}"),
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
}
