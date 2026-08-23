/// Returns the registry media type for a published path.
///
/// TypeScript must not use a generic MIME database: many map `.ts` to MPEG
/// transport-stream video, which bypasses Deno's type stripping.
pub fn for_path(path: &str) -> &'static str {
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or_default();
    match extension {
        "ts" | "mts" | "cts" | "tsx" => "application/typescript",
        "js" | "mjs" | "cjs" | "jsx" => "application/javascript",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "map" => "application/json",
        "md" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
