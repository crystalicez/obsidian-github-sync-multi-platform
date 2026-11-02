# D235 — Authenticate original journal key after cold start

Date: 2026-11-02. Release gate blocked; Wizard Run Preview-only.

## Boundary and evidence

D234 can read a destination Shadow Index from disk but without the original journal key, the D233 Settings Intent and D234 routing marker are unauthenticated hints. D235 retrieves the original key from old passphrase SecretStorage and a verified immutable **Frozen Backup** branch, not the mutable old Source or new Destination.

The new read-only `inspectV4ReencryptionColdStartJournalKey` checks the physical Sync Fence, full native Settings, Source/Shadow Index, D183 candidate identity and D234 route; requires both stored passphrases; verifies GitHub physical repository, exact frozen branch ref, original pinned commit and tree hashes; traverses immutable tree and blob objects using `readImmutableGitFile` and validates each Git blob SHA. It decodes the original V4 config and derives the original PBKDF2 journal key (with bounded KDF settings). It decrypts the pinned old encrypted Git HEAD, then authenticates both D233 Settings-Intent HMAC and D234 routing HMAC. Source HEAD's last writer can be another device. On exit, it clears keyring byte arrays best-effort. A final read checks repository/ref, original and new secrets, and routing marker again.

A good result is `authenticated-local-route-still-fenced`; wrong passphrase, missing key, altered Git object, ref/reader mutation or changed local Settings returns `manual-recovery-required`. Every report keeps Sync, remote writes, rollback, Cutover and old-passphrase cleanup **unauthorized**. It explicitly does not prove the complete Backup/Destination content, WAL durability, physical power-loss behavior or stale-device safety.

## Native workflow

`V4PluginRuntime.verifyFencedReencryptionOriginalKey` uses a separate read-only Backup-branch GitHubClient, validates the live vault identity, and never changes the normal GitHub client. The Obsidian command **Verify Re-encryption Recovery (Read-only)** runs it on demand; no network call or costly PBKDF2 is made automatically during startup. No saved key, Index mutation, branch publication or fence clearance is performed.

## Remaining

Independent full current Backup/Destination Git and WAL proofs after restart; real safely recoverable Destination Runtime Index writer; multi-device/stale-client protections; installed Obsidian Desktop/Android/iOS acceptance. Keep release gate blocked. No GitHub Actions, Native Helper or live credentialed test-vault Git writes.

## Verified offline gates

D235 targeted **3/3 PASS**, final Full Fast **1,387/1,387 PASS**, Recovery **93/93**, Feasibility **136/136**, Resource **11/11**, `pnpm build` and `pnpm typecheck:max-strict` PASS. GitHub E2E **three compile-only** bundles, Metadata and Package validators PASS. Bounded cryptographic **100,000,000-byte soak 1/1 PASS**, SHA-256 `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8` equals reference. No live credentialed GitHub calls, installed Obsidian native acceptance or real power-loss proof was claimed.
