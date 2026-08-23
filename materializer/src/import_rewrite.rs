// Copyright 2024 the JSR authors. All rights reserved. MIT license.
//
// Adapted from jsr-io/jsr api/src/npm/import_transform.rs at
// ba17475bff1bbb870ce015866d768284efa44d8c. The local rewriter resolves only
// this package's import-map aliases; it does not implement JSR's npm emission.

use deno_ast::swc::ast::{
    CallExpr, Callee, ExportAll, Expr, ExprOrSpread, ImportDecl, Lit, NamedExport, Str,
    TsImportType,
};
use deno_ast::swc::ecma_visit::{VisitMut, VisitMutWith};
use deno_ast::{
    EmitOptions, MediaType, ModuleSpecifier, ParseParams, SourceMap, SourceMapOption, emit,
    parse_module,
};
use std::collections::BTreeMap;

/// Rewrites only actual module-specifier AST nodes, never comments or ordinary strings.
pub fn rewrite_import_map_specifiers(
    path: &str,
    bytes: &[u8],
    imports: &BTreeMap<String, String>,
) -> Result<String, String> {
    let source =
        std::str::from_utf8(bytes).map_err(|_| format!("source file {path} is not UTF-8"))?;
    let specifier = ModuleSpecifier::parse(&format!("file:///{path}"))
        .map_err(|error| format!("source file {path} has an invalid module specifier: {error}"))?;
    let parsed = parse_module(ParseParams {
        specifier,
        text: source.into(),
        media_type: media_type(path),
        capture_tokens: false,
        scope_analysis: false,
        maybe_syntax: None,
    })
    .map_err(|error| format!("source file {path} could not be parsed: {error}"))?;
    let mut program = parsed.program_ref().to_owned();
    let comments = parsed.comments().as_single_threaded();
    let source_map = SourceMap::single(path.to_owned(), source.to_owned());
    parsed.globals().with(|_| {
        program.visit_mut_with(&mut ImportMapRewriter { path, imports });
        let emitted = emit(
            (&program).into(),
            &comments,
            &source_map,
            &EmitOptions {
                source_map: SourceMapOption::None,
                source_map_file: None,
                source_map_base: None,
                inline_sources: false,
                remove_comments: false,
            },
        )
        .map_err(|error| format!("source file {path} could not be emitted: {error}"))?;
        Ok(emitted.text)
    })
}

struct ImportMapRewriter<'a> {
    path: &'a str,
    imports: &'a BTreeMap<String, String>,
}

impl ImportMapRewriter<'_> {
    fn rewrite(&self, specifier: &str) -> String {
        let candidate = self
            .imports
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
            return relative_specifier(self.path, &format!("{target}{suffix}"));
        }
        format!("{target}{suffix}")
    }
}

impl VisitMut for ImportMapRewriter<'_> {
    fn visit_mut_import_decl(&mut self, node: &mut ImportDecl) {
        node.visit_mut_children_with(self);
        if let Some(value) = node.src.value.as_str() {
            node.src = Box::new(self.rewrite(value).into());
        }
    }

    fn visit_mut_named_export(&mut self, node: &mut NamedExport) {
        node.visit_mut_children_with(self);
        if let Some(src) = &node.src
            && let Some(value) = src.value.as_str()
        {
            node.src = Some(Box::new(self.rewrite(value).into()));
        }
    }

    fn visit_mut_export_all(&mut self, node: &mut ExportAll) {
        node.visit_mut_children_with(self);
        if let Some(value) = node.src.value.as_str() {
            node.src = Box::new(self.rewrite(value).into());
        }
    }

    fn visit_mut_ts_import_type(&mut self, node: &mut TsImportType) {
        node.visit_mut_children_with(self);
        if let Some(value) = node.arg.value.as_str() {
            node.arg = self.rewrite(value).into();
        }
    }

    fn visit_mut_call_expr(&mut self, node: &mut CallExpr) {
        node.visit_mut_children_with(self);
        if let Callee::Import(_) = node.callee
            && let Some(argument) = node.args.first()
            && let Expr::Lit(Lit::Str(string)) = *argument.expr.clone()
            && let Some(value) = string.value.as_str()
        {
            node.args[0] = ExprOrSpread {
                spread: None,
                expr: Box::new(Expr::Lit(Lit::Str(Str {
                    span: string.span,
                    value: self.rewrite(value).into(),
                    raw: None,
                }))),
            };
        }
    }
}

fn media_type(path: &str) -> MediaType {
    if path.ends_with(".tsx") {
        MediaType::Tsx
    } else if path.ends_with(".mts") {
        MediaType::Mts
    } else if path.ends_with(".cts") {
        MediaType::Cts
    } else if path.ends_with(".ts") {
        MediaType::TypeScript
    } else if path.ends_with(".jsx") {
        MediaType::Jsx
    } else if path.ends_with(".mjs") {
        MediaType::Mjs
    } else if path.ends_with(".cjs") {
        MediaType::Cjs
    } else {
        MediaType::JavaScript
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_module_nodes_without_touching_comments_or_ordinary_strings() {
        let source = r#"
// import value from "~/comment.ts";
const label = "~/string.ts";
export { value } from "~/value.ts";
const lazy = import("~/lazy.ts", { with: { type: "json" } });
type Value = import("~/types.ts").Value;
"#;
        let output = rewrite_import_map_specifiers(
            "src/mod.ts",
            source.as_bytes(),
            &BTreeMap::from([("~/".into(), "./src/".into())]),
        )
        .unwrap();
        assert!(output.contains("~/comment.ts"));
        assert!(output.contains("~/string.ts"));
        assert!(output.contains("./value.ts"));
        assert!(output.contains("./lazy.ts"));
        assert!(output.contains("./types.ts"));
        assert!(output.contains("with: {"));
    }
}
