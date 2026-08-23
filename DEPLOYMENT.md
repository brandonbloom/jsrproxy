# Deployment checklist

1. Create the `jsrproxy-artifacts` production R2 bucket and the
   `jsrproxy-artifacts-preview` staging bucket in the target Cloudflare account.
2. Set the Worker secret used to derive non-reversible PAT fingerprints:

   ```sh
   npx wrangler secret put AUTH_FINGERPRINT_SECRET
   ```

3. Set `JSRPROXY_CONFIG` as a Worker secret or environment variable. Its
   `trusted_github_users` list and `scopes` map are deployment-owned data.
4. Run `npm test`, `npm run check`, and `cargo test --workspace`.
5. Install and start Docker, then deploy a staging Worker with
   `npx wrangler deploy --env staging` after adding the staging account and
   route. Wrangler builds and publishes `materializer/Dockerfile` as part of
   that deployment.

The Container job runner and GitHub source materializer must be completed
before this project can serve a newly observed repository revision.
