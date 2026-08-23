use crate::jsr_exports::exports_map_from_json;
use serde::Deserialize;
use serde_json::Value;
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
    exports: Option<Value>,
    #[serde(default)]
    imports: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigError {
    InvalidJson(String),
    MissingExports,
    EmptyExports,
    InvalidExports(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJson(error) => write!(formatter, "invalid root configuration: {error}"),
            Self::MissingExports => formatter.write_str("root configuration has no exports field"),
            Self::EmptyExports => formatter.write_str("root configuration exports is empty"),
            Self::InvalidExports(error) => formatter.write_str(error),
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
    if raw.exports.is_none() {
        return Err(ConfigError::MissingExports);
    }
    let exports = exports_map_from_json(raw.exports).map_err(ConfigError::InvalidExports)?;
    if exports.is_empty() {
        return Err(ConfigError::EmptyExports);
    }
    Ok(SourceConfiguration {
        exports,
        imports: raw.imports,
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
            Err(ConfigError::InvalidExports(_))
        ));
    }

    #[test]
    fn rejects_export_maps_that_jsr_rejects() {
        let error = parse_root_configuration(br#"{"exports":{"bad":"./mod.ts"}}"#).unwrap_err();
        assert_eq!(
            error.to_string(),
            "the key 'bad' must start with a ./, did you mean './bad'?"
        );
        let error = parse_root_configuration(br#"{"exports":"./mod"}"#).unwrap_err();
        assert_eq!(
            error.to_string(),
            "the path './mod' for the root export must not end in / and must have a file extension"
        );
    }
}
