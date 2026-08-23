//! Container process entry point.
//!
//! The process receives a source archive and credential-free materialization context.

fn main() {
    if let Err(error) = jsrproxy_materializer::service::serve() {
        eprintln!("jsrproxy materializer failed to listen: {error}");
        std::process::exit(1);
    }
}
