use crate::config::{SourceConfiguration, parse_root_configuration};
use crate::import_rewrite::rewrite_import_map_specifiers;
use crate::job::{MaterializationJob, MaterializationRequest, SourceRepository};
use crate::publication::{ArtifactFile, ArtifactStore, StoreError, publish};
use crate::tombstone::{TombstoneDiagnostic, build_tombstone};
use flate2::read::GzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::io::{Cursor, Read};
use tar::Archive;
use tiny_http::{Header, Method, Response, Server, StatusCode};

/// Mirrors the standard JSR publishing limit for a compressed package tarball.
const MAX_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024;
/// Mirrors the standard JSR publishing limit for one unpacked package file.
const MAX_SOURCE_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// Mirrors the standard JSR publishing limit for all unpacked package files.
const MAX_TOTAL_SOURCE_BYTES: u64 = 20 * 1024 * 1024;

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

    let body = match read_archive_body(request.as_reader()) {
        Ok(body) => body,
        Err(()) => return plain_response(400, "invalid materialization request"),
    };
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

fn read_archive_body(reader: &mut (impl Read + ?Sized)) -> Result<Vec<u8>, ()> {
    let mut body = Vec::new();
    reader
        .take(MAX_ARCHIVE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| ())?;
    if body.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(());
    }
    Ok(body)
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
    validate_output_limits(&files)?;
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
        *bytes = rewrite_import_map_specifiers(path, bytes, imports)?.into_bytes();
    }
    Ok(())
}

fn unpack_archive(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, SourceFailure> {
    let decoder = GzDecoder::new(bytes);
    let mut archive = Archive::new(decoder);
    let mut files = BTreeMap::new();
    let mut archive_root: Option<String> = None;
    let mut case_insensitive_paths = HashMap::new();
    let mut total_size = 0_u64;
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
        let path = entry.path_bytes();
        let path = std::str::from_utf8(&path).map_err(|_| {
            SourceFailure::new(
                "invalid-source-archive",
                "GitHub returned a source path that is not UTF-8",
                None,
            )
        })?;
        let path = path.trim_end_matches('/');
        let mut parts = path.split('/');
        let root = parts
            .next()
            .filter(|part| !part.is_empty())
            .ok_or_else(|| {
                SourceFailure::new(
                    "invalid-source-archive",
                    "GitHub returned a source path without an archive root",
                    None,
                )
            })?;
        if matches!(root, "." | "..") {
            return Err(SourceFailure::new(
                "invalid-source-archive",
                "GitHub returned an unsafe archive root",
                None,
            ));
        }
        if let Some(expected_root) = &archive_root {
            if expected_root != root {
                return Err(SourceFailure::new(
                    "invalid-source-archive",
                    "GitHub returned source files from multiple archive roots",
                    None,
                ));
            }
        } else {
            archive_root = Some(root.to_owned());
        }
        let relative: Vec<&str> = parts.collect();
        if relative.is_empty() {
            if entry.header().entry_type().is_file() {
                return Err(SourceFailure::new(
                    "invalid-source-archive",
                    "GitHub returned a source file at the archive root",
                    None,
                ));
            }
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
        validate_package_path(&relative)?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err(SourceFailure::new(
                "invalid-source-archive",
                "GitHub returned a source archive containing a link or unsupported entry",
                None,
            ));
        }
        let size = entry.header().size().map_err(|_| {
            SourceFailure::new(
                "invalid-source-archive",
                "GitHub returned an unreadable source file header",
                None,
            )
        })?;
        if size > MAX_SOURCE_FILE_BYTES {
            return Err(SourceFailure::new(
                "source-file-too-large",
                "a source file exceeds the materializer limit",
                None,
            ));
        }
        total_size = total_size.checked_add(size).ok_or_else(|| {
            SourceFailure::new(
                "source-package-too-large",
                "the source package exceeds the materializer limit",
                None,
            )
        })?;
        if total_size > MAX_TOTAL_SOURCE_BYTES {
            return Err(SourceFailure::new(
                "source-package-too-large",
                "the source package exceeds the materializer limit",
                None,
            ));
        }
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
        if contents.len() as u64 != size {
            return Err(SourceFailure::new(
                "invalid-source-archive",
                "GitHub returned a truncated source file",
                None,
            ));
        }
        let case_insensitive = relative.to_lowercase();
        if let Some(existing) = case_insensitive_paths.insert(case_insensitive, relative.clone()) {
            return Err(SourceFailure::new(
                "invalid-source-archive",
                format!(
                    "GitHub returned case-insensitive duplicate source paths: {existing} and {relative}"
                ),
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

fn validate_output_limits(files: &BTreeMap<String, Vec<u8>>) -> Result<(), SourceFailure> {
    let mut case_insensitive_paths = HashMap::new();
    let total_size = files.iter().try_fold(0_u64, |total, (path, contents)| {
        validate_package_path(path)?;
        let case_insensitive = path.to_ascii_lowercase();
        if let Some(existing) = case_insensitive_paths.insert(case_insensitive, path) {
            return Err(SourceFailure::new(
                "invalid-source-archive",
                format!(
                    "generated package has case-insensitive duplicate paths: {existing} and {path}"
                ),
                None,
            ));
        }
        let size = contents.len() as u64;
        if size > MAX_SOURCE_FILE_BYTES {
            return Err(SourceFailure::new(
                "source-file-too-large",
                "a generated package file exceeds the materializer limit",
                None,
            ));
        }
        total.checked_add(size).ok_or_else(|| {
            SourceFailure::new(
                "source-package-too-large",
                "the generated package exceeds the materializer limit",
                None,
            )
        })
    })?;
    if total_size > MAX_TOTAL_SOURCE_BYTES {
        return Err(SourceFailure::new(
            "source-package-too-large",
            "the generated package exceeds the materializer limit",
            None,
        ));
    }
    Ok(())
}

fn validate_package_path(path: &str) -> Result<(), SourceFailure> {
    let components: Vec<&str> = path.split('/').collect();
    let valid_component = |component: &str| {
        component.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'$' | b'('
                        | b')'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'@'
                        | b'['
                        | b']'
                        | b'_'
                        | b'{'
                        | b'}'
                        | b'~'
                )
        })
    };
    let reserved = [
        "aux", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "con",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9", "nul", "prn",
    ];
    let invalid = path.len() > 154
        || components.is_empty()
        || components.iter().any(|component| {
            component.is_empty()
                || matches!(*component, "." | "..")
                || component.ends_with('.')
                || !valid_component(component)
                || reserved.contains(
                    &component
                        .rsplit_once('.')
                        .map_or(*component, |(name, _)| name)
                        .to_ascii_lowercase()
                        .as_str(),
                )
        })
        || components
            .last()
            .is_some_and(|component| component.len() > 95)
        || components.first().is_some_and(|component| {
            component.eq_ignore_ascii_case(".git") || component.eq_ignore_ascii_case("_dist")
        });
    if invalid {
        return Err(SourceFailure::new(
            "invalid-source-archive",
            format!("source path is outside the accepted JSR publishing subset: {path}"),
            None,
        ));
    }
    Ok(())
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
    fn rejects_case_insensitive_duplicate_source_paths() {
        let failure = source_package(
            &archive(&[
                ("deno.json", br#"{"exports":"./mod.ts"}"#),
                ("mod.ts", b"export {};\n"),
                ("Mod.ts", b"export {};\n"),
            ]),
            &request(),
        )
        .unwrap_err();
        assert_eq!(failure.failure_class, "invalid-source-archive");
        assert!(failure.message.contains("case-insensitive duplicate"));
    }

    #[test]
    fn accepts_github_style_directory_headers() {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut tar = Builder::new(encoder);
        let mut directory = tar::Header::new_gnu();
        directory.set_entry_type(tar::EntryType::Directory);
        directory.set_size(0);
        directory.set_mode(0o755);
        directory.set_cksum();
        tar.append_data(&mut directory, "repo-sha/", std::io::empty())
            .unwrap();
        let contents = br#"{"exports":"./mod.ts"}"#;
        let mut file = tar::Header::new_gnu();
        file.set_size(contents.len() as u64);
        file.set_mode(0o644);
        file.set_cksum();
        tar.append_data(&mut file, "repo-sha/deno.json", &contents[..])
            .unwrap();
        let contents = b"export {};\n";
        let mut file = tar::Header::new_gnu();
        file.set_size(contents.len() as u64);
        file.set_mode(0o644);
        file.set_cksum();
        tar.append_data(&mut file, "repo-sha/mod.ts", &contents[..])
            .unwrap();
        let archive = tar.into_inner().unwrap().finish().unwrap();

        assert!(source_package(&archive, &request()).is_ok());
    }

    #[test]
    fn rejects_compressed_archives_over_the_limit() {
        let body = vec![0; MAX_ARCHIVE_BYTES as usize + 1];
        assert_eq!(read_archive_body(&mut Cursor::new(body)), Err(()));
    }

    #[test]
    fn rejects_source_files_over_the_limit() {
        let contents = vec![0; MAX_SOURCE_FILE_BYTES as usize + 1];
        let failure = unpack_archive(&archive(&[("mod.ts", &contents)])).unwrap_err();
        assert_eq!(failure.failure_class, "source-file-too-large");
    }

    #[test]
    fn rejects_generated_packages_over_the_total_limit() {
        let files = BTreeMap::from([
            (
                "first.ts".to_owned(),
                vec![0; MAX_TOTAL_SOURCE_BYTES as usize / 2],
            ),
            (
                "second.ts".to_owned(),
                vec![0; MAX_TOTAL_SOURCE_BYTES as usize / 2 + 1],
            ),
        ]);
        let failure = validate_output_limits(&files).unwrap_err();
        assert_eq!(failure.failure_class, "source-package-too-large");
    }

    #[test]
    fn rejects_paths_outside_the_jsr_publishing_subset() {
        let failure = source_package(
            &archive(&[
                ("deno.json", br#"{"exports":"./mod.ts"}"#),
                ("src/has space.ts", b"export {};\n"),
                ("mod.ts", b"export {};\n"),
            ]),
            &request(),
        )
        .unwrap_err();
        assert_eq!(failure.failure_class, "invalid-source-archive");
        assert!(failure.message.contains("accepted JSR publishing subset"));
    }

    #[test]
    fn rejects_case_collisions_created_by_the_emitted_configuration() {
        let failure = source_package(
            &archive(&[
                ("jsr.json", br#"{"exports":"./mod.ts"}"#),
                ("Deno.json", b"{}\n"),
                ("mod.ts", b"export {};\n"),
            ]),
            &request(),
        )
        .unwrap_err();
        assert_eq!(failure.failure_class, "invalid-source-archive");
        assert!(
            failure
                .message
                .contains("generated package has case-insensitive duplicate")
        );
    }

    #[test]
    fn rejects_links_in_source_archives() {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut tar = Builder::new(encoder);
        let contents = br#"{"exports":"./mod.ts"}"#;
        let mut file = tar::Header::new_gnu();
        file.set_size(contents.len() as u64);
        file.set_mode(0o644);
        file.set_cksum();
        tar.append_data(&mut file, "repo-sha/deno.json", &contents[..])
            .unwrap();
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_size(0);
        link.set_link_name("mod.ts").unwrap();
        link.set_cksum();
        tar.append_data(&mut link, "repo-sha/link.ts", std::io::empty())
            .unwrap();
        let archive = tar.into_inner().unwrap().finish().unwrap();

        let failure = source_package(&archive, &request()).unwrap_err();
        assert_eq!(failure.failure_class, "invalid-source-archive");
        assert!(failure.message.contains("link or unsupported entry"));
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
            "import { assert } from \"jsr:@std/assert@1.0.19\";\nimport { value } from \"../value.ts\";\nexport { assert, value };\n"
        );
    }
}
