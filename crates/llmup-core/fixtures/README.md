# Native Registry Fixtures

`registry-snapshot.json` is the unchanged 66-record offline registry snapshot
mechanically exported from the former `src/catalog/registry-snapshot.ts` on
2026-09-18. It is the shared maintenance input for the native enrichment command
and retained TypeScript compatibility tooling, not a replacement for
`data/models.json`. Update it only with sourced registry facts. Its raw model
shape remains the existing RawRegistryModel contract.

`enrichment-parity.json` freezes 90 full input/output cases from the TypeScript
`enrichCatalog` oracle as it existed at commit `f4c2c0d`, with clock
`2026-09-18T00:00:00.000Z`. Cases cover both modes, the whole curated catalog,
every snapshot model, duplicates/caps, license withdrawal, invalid updates,
unknown quantizations, future dates, sanitization, and curated-field retention.
Rust tests compare complete typed catalogs and exact diff arrays without Node.
Do not regenerate expected output from the Rust implementation under test.