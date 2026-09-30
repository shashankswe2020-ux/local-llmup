# Signed Catalog Operations

## Trust Setup

1. Generate a dedicated Ed25519 signing key using an approved local key-management
   tool. Keep the private 32-byte seed outside this repository. Never paste it
   into chat, issue bodies, logs, command arguments, or source files.
2. Replace `UNPROVISIONED` in
   `crates/rigspark-runtime/src/catalog_public_key.hex` with the corresponding
   32-byte public key encoded as 64 hexadecimal characters. Review that change
   and ship one catalog-capable application release. This initial release is
   necessary to establish trust; subsequent compatible catalog changes are data
   releases, not application releases.
3. Create the GitHub environment `catalog-signing`, restrict deployments to
   `main`, and require maintainer approval. Store the private seed as 64 hex
   characters in its `CATALOG_SIGNING_SEED` environment secret. Do this directly
   in GitHub; no assistant needs to read the secret.
4. Enable the **Publish Signed Catalog** workflow only after the public key is
   reviewed. The signer rejects a private/public key mismatch. Test keys in the
   test suite are public fixtures and must never become production trust keys.

## Publishing

Curate and review changes through the existing registry snapshot, bootstrap,
enrichment, and coverage process. Merge only validated model metadata to `main`.
Run **Publish Signed Catalog** manually from `main` and approve its protected
environment. No workflow triggers on a pull request, and publication does not
automatically admit upstream models.

The workflow tests catalog/signing contracts, signs the reviewed commit, and
publishes `catalog.json` to an immutable `catalog-r<run-number>` prerelease. It
then replaces the same file in the `catalog-v1` channel release. Both releases
use `--latest=false`, so catalog artifacts do not displace application releases.
Do not manually edit historical revision assets. GitHub administrators remain
responsible for enforcing repository/release permissions.

The fixed client URL is:

```text
https://github.com/shashankswe2020-ux/rigspark/releases/download/catalog-v1/catalog.json
```

The channel asset is mutable; its signed contents carry a monotonic revision.
Clients enforce revision monotonicity against local state and reject reusing a
revision with different contents. Do not reset workflow run numbering or move
publication to a new workflow without preserving that monotonic sequence.
Rerunning an already-published run refuses to overwrite its historical release;
start a new dispatch to publish a new revision.

For an offline signing rehearsal, use a separate test key and temporary output:

```sh
cargo catalog-sign --catalog-path reviewed-models.json \
  --key-file /secure/location/test-seed.hex \
  --public-key-file /secure/location/test-public.hex \
  --revision 1 --published-at 2026-09-30T00:00:00Z \
  --output catalog.json
```

The seed file must be owner-only on Unix. All inputs are bounded and output
creation refuses existing files. The command signs locally; it never publishes.

## Wire Format

The outer JSON object has exactly `payload` and `signature`. `payload` is a
UTF-8 JSON string whose exact bytes are signed; `signature` is 128 hex characters.
Its decoded JSON has `formatVersion: 1`, positive `revision`, RFC3339
`publishedAt`, and `catalog` (the model catalog JSON string). The catalog's
schema version and complete contents are therefore authenticated. Publication
must not predate catalog generation. Unknown fields and unsupported formats are
rejected, and downloads are limited to 16 MiB before parsing.

Verification uses
[ed25519-dalek 2.2 strict verification](https://docs.rs/ed25519-dalek/2.2.0/ed25519_dalek/struct.VerifyingKey.html#method.verify_strict).
The reported updated-snapshot digest hashes the exact signed payload. Bundled
snapshot digests hash the bundled catalog bytes; the source label distinguishes
the two. Transport allows HTTPS only, limits redirects to official GitHub asset
hosts, and applies connection/whole-request deadlines.

## Recovery and Limits

`~/.rigspark/catalog/snapshots.json` holds current and previous signed envelopes
and the highest accepted revision/digest. A single atomic replacement activates
an update; an OS file lock serializes CLI/GUI writers. A failed write leaves the
previous complete file in place. No conversation-memory migration is involved.

Invalid active signatures cause visible fallback to the previous verified
snapshot. Invalid whole-file state falls back to bundled data and blocks updates
because the rollback high-water mark cannot be trusted. Preserve the damaged
file for diagnosis and restore a known-good backup. Removing catalog state is a
manual trust reset and loses rollback protection; it is not an automatic repair.

Rollback protection is local, not tamper-proof storage: an attacker controlling
the user's files can restore an entire older cache or remove it. Signatures
authenticate content but do not prove the server returned the newest catalog;
an attacker can withhold updates. Catalog status exposes age/revision rather
than claiming current upstream completeness.

To undo bad metadata, publish corrected contents with a higher revision, not an
older signed artifact. Key compromise or rotation initially requires a new
application release with a reviewed public key, followed by a newly signed
catalog. Existing cached signatures then fail closed and fall back to bundled
data. Freeze publication and distribute a recovery release on key compromise.

This implementation does not change the model schema or independently update
performance datasets. A new architecture requiring unsupported schema or sizing
logic still needs an application release. New compatible models do not.