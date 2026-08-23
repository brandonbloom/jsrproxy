use serde::Deserialize;
use std::collections::BTreeMap;
use std::fmt;

/// The root configuration information materialization needs before walking a graph.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceConfiguration {
    pub exports: BTreeMap<String, String>,
    pub imports: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct RawConfiguration {
    exports: Option<RawExports>,
    #[serde(default)]
    imports: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawExports {
    String(String),
    Map(BTreeMap<String, String>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigError {
    InvalidJson(String),
    MissingExports,
    EmptyExports,
    InvalidExportKey(String),
    InvalidExportPath { key: String, path: String },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson(error) => write!(formatter, "invalid root configuration: {error}"),
            Self::MissingExports => formatter.write_str("root configuration has no exports field"),
            Self::EmptyExports => formatter.write_str("root configuration exports is empty"),
            Self::InvalidExportKey(key) => write!(formatter, "invalid export key: {key}"),
            Self::InvalidExportPath { key, path } => {
                write!(
                    formatter,
                    "export {key} has an invalid relative path: {path}"
                )
            }
        }
    }
}

impl std::error::Error for ConfigError {}

/// Parses either `deno.json` or `jsr.json` at the repository root.
///
/// Workspace settings are deliberately ignored: jsrproxy exposes one root
/// package and cannot reproduce workspace-member resolution remotely.
pub fn parse_root_configuration(bytes: &[u8]) -> Result<SourceConfiguration, ConfigError> {
    let raw: RawConfiguration = serde_json::from_slice(bytes)
        .map_err(|error| ConfigError::InvalidJson(error.to_string()))?;
    let exports = match raw.exports {
        Some(RawExports::String(path)) => BTreeMap::from([(".".to_owned(), path)]),
        Some(RawExports::Map(exports)) => exports,
        None => return Err(ConfigError::MissingExports),
    };
    if exports.is_empty() {
        return Err(ConfigError::EmptyExports);
    }
    for (key, path) in &exports {
        if key != "." && !key.starts_with("./") {
            return Err(ConfigError::InvalidExportKey(key.clone()));
        }
        if !is_relative_path(path) {
            return Err(ConfigError::InvalidExportPath {
                key: key.clone(),
                path: path.clone(),
            });
        }
    }
    Ok(SourceConfiguration {
        exports,
        imports: raw.imports,
    })
}

fn is_relative_path(path: &str) -> bool {
    path.strip_prefix("./").is_some_and(|remainder| {
        !remainder.is_empty()
            && !remainder
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_string_and_object_exports() {
        let string = parse_root_configuration(br#"{"exports":"./mod.ts"}"#).unwrap();
        assert_eq!(
            string.exports,
            BTreeMap::from([(".".into(), "./mod.ts".into())])
        );

        let object = parse_root_configuration(
            br##"{"exports":{".":"./mod.ts","./sub":"./src/sub.ts"},"imports":{"#x":"./x.ts"}}"##,
        )
        .unwrap();
        assert_eq!(object.exports.len(), 2);
        assert_eq!(object.imports["#x"], "./x.ts");
    }

    #[test]
    fn rejects_missing_or_escaping_exports() {
        assert_eq!(
            parse_root_configuration(br#"{}"#).unwrap_err(),
            ConfigError::MissingExports
        );
        assert!(matches!(
            parse_root_configuration(br#"{"exports":"../mod.ts"}"#),
            Err(ConfigError::InvalidExportPath { .. })
        ));
    }
}
