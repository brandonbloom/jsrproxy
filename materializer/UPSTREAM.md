# Upstream ledger

This crate contains narrow adaptations of upstream code rather than an upstream
service. Each entry records the exact reviewed source and local changes.

## JSR export-map validation

- Upstream: [`jsr-io/jsr` `api/src/tarball.rs`](https://github.com/jsr-io/jsr/blob/ba17475bff1bbb870ce015866d768284efa44d8c/api/src/tarball.rs), commit `ba17475bff1bbb870ce015866d768284efa44d8c`.
- License: MIT; the upstream copyright and license notice are retained in
  `src/jsr_exports.rs`.
- Local file: `src/jsr_exports.rs`.
- Adaptation: retain `exports_map_from_json` validation and replace JSR's
  `IndexMap` and database `ExportsMap` with `BTreeMap`; omit publishing-service
  integration and upstream tests that depend on that service.
- Update procedure: compare this function with the recorded upstream commit and
  its successor, port relevant behavior deliberately, retain the license notice,
  and extend local tests before updating this record.

## JSR package-size and archive-safety rules

- Upstream: [`jsr-io/jsr` `api/src/tarball.rs`](https://github.com/jsr-io/jsr/blob/ba17475bff1bbb870ce015866d768284efa44d8c/api/src/tarball.rs), commit `ba17475bff1bbb870ce015866d768284efa44d8c`.
- License: MIT.
- Local file: `src/service.rs`.
- Adaptation: use JSR's standard 20 MiB compressed-tarball, per-file, and total
  package limits; reject non-file archive entries and case-insensitive duplicate
  paths before package materialization. This is a narrow adaptation for GitHub's
  single-root source archives, not a copy of JSR's publishing-service code.
- Update procedure: compare limits and validation behavior with the recorded
  upstream source before changing them, then extend local archive tests.
