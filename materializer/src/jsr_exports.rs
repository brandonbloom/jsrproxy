// Copyright 2024 the JSR authors. All rights reserved. MIT license.
//
// Adapted from https://github.com/jsr-io/jsr/blob/ba17475bff1bbb870ce015866d768284efa44d8c/api/src/tarball.rs
// See ../UPSTREAM.md for the adaptation record.

use serde_json::Value;
use std::collections::BTreeMap;

/// Validates JSR export-map syntax and returns its normalized entries.
pub fn exports_map_from_json(exports: Option<Value>) -> Result<BTreeMap<String, String>, String> {
    fn has_extension(value: &str) -> bool {
        value
            .rsplit('/')
            .next()
            .is_some_and(|part| part.contains('.'))
    }

    fn validate_key(key: &str) -> Result<(), String> {
        if key == "." {
            return Ok(());
        }
        if !key.starts_with("./") {
            let suggestion = if key.starts_with('/') {
                format!(".{key}")
            } else {
                format!("./{key}")
            };
            return Err(format!(
                "the key '{key}' must start with a ./, did you mean '{suggestion}'?"
            ));
        }
        if key.ends_with('/') {
            let suggestion = key.trim_end_matches('/');
            return Err(format!(
                "the key '{key}' must not end with '/', did you mean '{suggestion}'?"
            ));
        }
        if !key
            .chars()
            .all(|character| matches!(character, 'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '/' | '.'))
        {
            return Err(format!(
                "the key '{key}' contains invalid characters, only [a-z][A-Z][0-9]-_/. are allowed"
            ));
        }
        for part in key.split('/').skip(1) {
            if part.is_empty() || part.chars().all(|character| character == '.') {
                return Err(format!(
                    "the key '{key}' must not contain double slashes (//) or parts entirely of dots (.)."
                ));
            }
        }
        Ok(())
    }

    fn validate_value(key: &str, value: &str) -> Result<(), String> {
        if value.is_empty() {
            return Err(format!(
                "the path for {key} must be a non-empty relative path"
            ));
        }
        if !value.starts_with("./") {
            return Err(format!(
                "the path '{value}' for {key} could not be resolved as a relative path from the config file, did you mean './{value}'?"
            ));
        }
        if value.ends_with('/') || !has_extension(value) {
            return Err(format!(
                "the path '{value}' for {key} must not end in / and must have a file extension"
            ));
        }
        Ok(())
    }

    let exports = match exports {
        None => return Ok(BTreeMap::new()),
        Some(Value::String(value)) => {
            validate_value("the root export", &value)?;
            return Ok(BTreeMap::from([(".".to_owned(), value)]));
        }
        Some(Value::Object(map)) => map,
        Some(Value::Array(_) | Value::Bool(_) | Value::Number(_) | Value::Null) => {
            return Err("'exports' field must be a string or an object".to_owned());
        }
    };

    let mut result = BTreeMap::new();
    for (key, value) in exports {
        validate_key(&key)?;
        let Value::String(value) = value else {
            return Err(format!(
                "export '{key}' must be a string, invalid value: '{value}'"
            ));
        };
        validate_value(&format!("export '{key}'"), &value)?;
        result.insert(key, value);
    }
    Ok(result)
}
