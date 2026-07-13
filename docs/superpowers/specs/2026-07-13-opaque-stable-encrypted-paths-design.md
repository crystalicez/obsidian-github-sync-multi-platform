# Opaque Stable Encrypted Paths Design

## Goal

When V4 encryption is enabled, GitHub must reveal no plaintext vault path segment, directory name, file name, extension, file content, index entry, or history journal entry. Remote object paths must remain deterministic and stable across syncs and logical renames. The plugin must not mirror the vault hierarchy with fake or randomized directories.

Plaintext mode remains unchanged: eligible files use their normalized vault paths directly.

## Chosen Layout

Encrypted logical paths live only inside authenticated encrypted indexes and journals. Content objects use stable opaque identifiers:

```text
.obsidian-github-sync-v4/
  data/<bucket>/<object-id>.enc
  parts/<bucket>/<object-id>/<version>/<part-number>.enc
  packs/<bucket>/<pack-id>.enc
```

`bucket` is the first two hexadecimal characters of the stable object identifier. It is a fixed technical shard with at most 256 values, not a representation of the vault directory hierarchy. No plaintext path determines the number or nesting of remote directories.

`object-id` is a URL-safe keyed token derived from the repository path key and stable `fileId`. It is deterministic for one repository and file identity, opaque without the encryption key, and does not change when the logical path changes. It is not regenerated on each sync.

The encrypted index maps `fileId` and `object-id` to the complete normalized logical path. The path includes every directory segment, basename, and extension and is encrypted as index payload data. The authenticated journal records before/after logical paths and storage descriptors so history survives renames.

## Identity and Rename Semantics

Every tracked file has a stable `fileId`. Initial creation generates a collision-resistant file identity independent of the logical path. A file rename keeps its `fileId`, `object-id`, and existing remote content path. Only encrypted metadata and the journal need to record a content-preserving rename.

A folder rename expands to prefix mappings for all tracked descendants. Descendant records keep their `fileId` and `object-id`; their logical paths change in the encrypted index and journal. A folder delete expands to descendant deletions. The watcher must not reduce folder operations to an identity-losing full rescan.

If a file is deleted and later recreated without a detectable continuous rename event, it receives a new `fileId`. Content equality alone must not silently reuse an old identity.

## Content, Parts, and Packs

Single-file content remains AES-256-GCM encrypted with fresh nonces and authenticated context bound to repository identity, stable file identity, and remote version.

Large encrypted files use the stable object identifier rather than the logical path. Version and part number remain visible because they are protocol coordinates, while the full-file hash and all logical path data remain inside encrypted metadata. Old parts are deleted only in the same atomic commit that publishes the replacement descriptor.

Encrypted packs no longer contain plaintext folder names in their remote paths. Pack grouping may use encrypted metadata and bounded batches, but the remote `pack-id` is opaque and the technical bucket is derived from it. Pack contents remain authenticated encrypted archives keyed by stable file identities.

## History Model

Plugin history is authoritative and keyed by stable `fileId`, not by the GitHub path. Each V4 commit journal records create, modify, rename, and delete operations with encrypted before/after logical paths and storage descriptors.

Because a logical rename does not move the remote content object, the plugin can display uninterrupted file history without treating the operation as a delete plus create. Deleted-version previews continue resolving the `before` descriptor from the parent commit. Content-preserving renames may reuse the prior blob and create only metadata and journal changes.

GitHub's native UI will show stable opaque object paths and encrypted metadata changes. It is not expected to display decrypted file names or vault hierarchy.

## Protocol and Compatibility

Encrypted V4 config adds:

```json
{
  "pathLayout": "opaque-stable-v1"
}
```

Plaintext config uses `pathLayout: "plaintext-v1"`. Missing `pathLayout` identifies the earlier folder-preserving encrypted layout and must never be interpreted as the new layout.

Changing an existing encrypted repository to `opaque-stable-v1` requires an explicitly confirmed Force Push. Normal sync and Force Pull reject an incompatible or missing layout with a clear migration message. The migration publishes the complete new layout atomically and deletes obsolete encrypted data, part, and pack paths in that commit. It does not reuse or expose plaintext history.

New encrypted repositories use `opaque-stable-v1` immediately. Local indexes also persist the path layout and are rebuilt when the configured repository identity, storage mode, or path layout changes.

## Sync Data Flow

1. Normalize local plaintext paths and apply scope and ignore rules before encryption.
2. Resolve existing stable file identities from the local index and queued rename mappings.
3. Generate identities only for genuinely new files.
4. Build encrypted metadata containing complete logical paths and stable identities.
5. Prepare opaque single objects, parts, or packs without plaintext path segments.
6. Build an encrypted journal keyed by stable file identities.
7. Publish content, metadata, deletions, and journal pages in one Git commit using branch compare-and-swap.
8. Persist the local index only after the remote commit succeeds.

Pull and history operations decrypt metadata first, then resolve remote objects by their opaque descriptors. No path discovery depends on recursively scanning the Git tree.

## Error Handling and Safety

- Reject wrong passphrases through authenticated metadata decryption before applying local changes.
- Reject unknown or mismatched path layouts before reading content objects.
- Detect duplicate `fileId`, duplicate `object-id`, malformed bucket, unsafe logical path, and descriptor/path mismatches.
- Treat a missing object, part, pack entry, or parent-version blob as corruption and stop before destructive local writes.
- Preserve branch-head compare-and-swap behavior and retry only normal sync races.
- Keep the modification-percentage guard based on logical files; a folder rename counts by affected logical files unless the planner represents it as one explicit folder operation in a future protocol.

## Leakage Contract

Encrypted mode may reveal plugin use, commit timing, total object count, approximate encrypted sizes, technical bucket distribution, part count, version coordinates, and which stable opaque objects changed together.

It must not reveal plaintext directory names, directory depth, filename, extension, full logical path, plaintext content, plaintext hashes, ignored paths, or secrets. Repeated versions of one file intentionally remain linkable through the stable opaque object identity to support history.

## Testing and Verification

Tests must cover:

- no plaintext path segment, basename, extension, or content in any encrypted Git path or payload;
- deterministic object paths for the same repository and `fileId`;
- different repositories and different file identities producing different object paths;
- file and nested-folder renames preserving file identities and opaque object paths;
- deletes, delete/recreate, rename chains, and folder delete expansion;
- opaque paths for single files, parts, and packs;
- encrypted index and journal round trips plus wrong-key rejection;
- history across rename and deleted-version preview;
- explicit rejection and Force Push migration of the earlier encrypted layout;
- plaintext mode remaining byte-for-byte path compatible;
- 100,000-file planning, 256-bucket distribution, no-change request counts, atomic commit behavior, and real GitHub plaintext/encrypted round trips.

The release gate must scan remote encrypted paths and payload bytes for every plaintext path segment and known file content fixture.
