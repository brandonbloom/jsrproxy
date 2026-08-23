//! Container process entry point.
//!
//! The request body is the only path by which a caller PAT reaches the process.
//! It is never persisted or written to stdout/stderr.

fn main() {
    if let Err(error) = jsrproxy_materializer::service::serve() {
        eprintln!("jsrproxy materializer failed to listen: {error}");
        std::process::exit(1);
    }
}
