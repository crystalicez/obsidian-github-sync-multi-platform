# Encrypted Obsidian GitHub Sync Design

## Goal

Fork `thiter/obsidian-github-sync-multi-platform` to add an encrypted sync mode where GitHub never receives plaintext note contents, attachment bytes, real filenames, or the real vault folder structure.

The first version prioritizes correctness, data preservation, and clear failure behavior over advanced merge automation or large-vault optimization.

## Selected Approach

Use a single encrypted manifest plus opaque encrypted objects.

GitHub stores:

```text
.obsidian-github-sync-encrypted/
  config.json
  manifest.enc
  objects/
    ab/
      cd/
        <opaque-object-id>.enc
```

`config.json` is intentionally non-secret. It may reveal that the repo is an encrypted Obsidian sync repo, but it must not include plaintext vault paths, note names, attachment names, note contents, plaintext hashes, or user secrets.

`manifest.enc` contains all sensitive index data and is encrypted with a key derived from the user's passphrase. Encrypted file objects contain file bytes encrypted independently with per-object randomness.

## Threat Model

The design protects against a GitHub repo reader learning:

- plaintext note contents
- attachment contents
- real filenames
- real folder structure
- note titles present only in path names

The design does not hide:

- that the repo is used by this encrypted sync plugin
- approximate encrypted object count
- encrypted object sizes unless padding is added later
- timing and commit history visible to GitHub
- the fact that a manifest changed

The first version will not implement object-size padding, traffic hiding, key rotation, or multi-user sharing.

## Key Model

Users enter the same passphrase on each device.

The plugin derives encryption keys from the passphrase using Argon2id if a well-maintained cross-platform implementation is available for the supported Obsidian runtimes. If Argon2id is not practical in the first implementation, the fallback is PBKDF2-SHA-256 with a high iteration count calibrated for acceptable desktop and mobile unlock time. The selected KDF, parameters, and random per-repo salt are stored in `config.json`.

If the passphrase is wrong, decrypting `manifest.enc` must fail authentication and stop sync before any local or remote writes occur.

Implementation note: the first implementation uses the PBKDF2-SHA-256 fallback because WebCrypto provides it consistently across supported Obsidian runtimes without adding a new native or WebAssembly dependency.

## Encryption Model

Every encrypted payload uses authenticated encryption. Preferred algorithms are AES-GCM via WebCrypto where available, or XChaCha20-Poly1305 if the project adopts a well-maintained library that works across the supported Obsidian platforms.

Each encrypted object uses fresh per-object randomness. Object names are random or opaque IDs and are not derived from plaintext paths.

Plaintext file bytes are encrypted as bytes, not strings, so markdown, images, PDFs, `.canvas`, audio, zero-byte files, and other binary files are handled uniformly.

## Manifest Contents

The decrypted manifest stores the minimum data needed for sync:

- manifest format version
- index mode set to `single`
- logical file records
- normalized plaintext path
- opaque encrypted object ID
- plaintext content hash for local change detection
- encrypted object metadata needed for GitHub updates, such as remote SHA
- tombstone/delete state
- last synced state needed to detect conflicts

The manifest may include device IDs for diagnostics and conflict filenames, but it must not depend on stable device IDs for security.

## Path Handling

Paths are normalized for sync while preserving user intent:

- store paths as UTF-8 strings using `/` separators
- preserve case
- do not normalize Unicode in a way that changes user-visible names
- support spaces, Thai text, emoji, dot-leading names, nested folders, and Obsidian-supported attachment names
- detect case-insensitive collisions such as `Note.md` and `note.md` before syncing on platforms where they collide

The plugin must never expose plaintext paths in remote object names.

## Push Flow

On sync, the plugin scans the local vault using existing ignore behavior plus encrypted-mode exclusions.

For new or changed files:

1. Read local file bytes.
2. Compute a plaintext content hash for local change detection.
3. Encrypt bytes with fresh per-object randomness.
4. Upload the encrypted object under an opaque object path.
5. Update the decrypted manifest record.
6. Encrypt and upload `manifest.enc` only after required object uploads succeed.

Local sync state is updated only after the remote write sequence succeeds.

For local deletes:

1. Mark a tombstone in the manifest.
2. Keep enough tombstone information for other devices to distinguish intentional deletes from missing remote objects or API errors.
3. Delete encrypted objects according to a conservative cleanup policy.

## Pull Flow

Pull begins by downloading and decrypting `manifest.enc`.

For remote changes:

1. Compare decrypted manifest records with local sync state.
2. Download changed encrypted objects.
3. Authenticate and decrypt object bytes.
4. Write plaintext to the normalized local path using a temp file plus atomic replace when the platform supports it.
5. Update local sync state only after writes succeed.

If any decrypt or integrity check fails, sync stops and reports an error instead of writing partial state.

## Conflict Policy

The first version uses a safe conflict policy: never silently overwrite local edits when both local and remote changed since the last known sync.

When a conflict is detected:

- keep the local file unchanged
- decrypt the remote version into a conflict copy in the vault
- use a filename containing `sync-conflict`, timestamp, and a non-secret device or source label
- apply the same policy to markdown, text, images, PDFs, and other binary files
- record enough state to avoid repeatedly generating identical conflict files on every sync

Automatic markdown merge is out of scope for the first version.

## Obsidian Edge Cases

The implementation must account for:

- markdown notes
- images and attachments
- PDFs and other binary files
- `.canvas` files
- empty files
- nested folders
- dotfiles
- Unicode paths, including Thai text and emoji
- path case collisions
- large files that may require size limits or streaming
- `.obsidian` files that are safe to sync
- encrypted sync plugin settings, passphrase-derived secrets, caches, and temp files that must not be synced

## Migration Behavior

The plugin must not silently mix plaintext and encrypted remote layouts.

When pointed at an existing plaintext sync repo, encrypted mode must require an explicit migration or import command. Migration uploads encrypted objects and encrypted manifest, then clearly marks the encrypted repo layout. Removing or archiving old plaintext remote files must be an explicit user-visible step.

## Error Handling

Sync must fail closed:

- wrong passphrase stops before writes
- manifest decrypt failure stops before writes
- object decrypt failure stops before writes for that object and does not mark sync success
- GitHub API failures do not update local sync state as successful
- partial uploads are recoverable by re-reading manifest and object state on the next sync

## Testing Strategy

Tests should cover:

- manifest encrypt/decrypt with correct and wrong passphrase
- object encrypt/decrypt for text, binary, and zero-byte files
- no plaintext path or content leakage in remote filenames or config
- push/pull round trip for nested notes and attachments
- Unicode and Thai filenames
- case collision detection
- local delete propagation using tombstones
- conflict copy creation when both sides changed
- failed decrypt and failed upload behavior

## First-Version Scope

In scope:

- single encrypted manifest
- encrypted file contents
- encrypted filenames and folder structure
- passphrase-based key derivation
- safe conflict copies
- explicit encrypted repo metadata
- conservative migration behavior

Out of scope:

- sharded manifests
- key rotation
- recovery keys
- multi-user sharing
- automatic text merge
- object-size padding
- hiding commit timing or object count
