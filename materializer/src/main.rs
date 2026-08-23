//! Container process entry point.
//!
//! The HTTP job listener is introduced together with the GitHub source fetcher
//! so the PAT can travel from the Durable Object to the fetcher without ever
//! being serialized to durable storage or logs.

fn main() {
    eprintln!("jsrproxy-materializer requires a configured job listener");
}
