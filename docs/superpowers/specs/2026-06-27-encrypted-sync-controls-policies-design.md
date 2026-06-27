# Encrypted Sync Controls And Policies Design

## Goal

Extend encrypted sync mode with explicit manual controls, force push/pull operations, safer repository initialization behavior, configurable automatic sync triggers, path ignore rules, conflict policies, and large-file chunking.

This spec builds on `2026-06-27-encrypted-obsidian-github-sync-design.md` and keeps the existing plaintext sync path intact unless a requirement explicitly says otherwise.

## Selected Approach

Use small services under `src/lib/encrypted/` and keep `sync-engine.ts` as the orchestrator.

Planned service boundaries:

- `sync-modes.ts`: normal, force push, force pull, and manual operation routing
- `remote-state.ts`: repository layout classification
- `sync-errors.ts`: user-facing error normalization and reporting
- `ignore.ts`: plaintext vault path ignore regex parsing and matching
- `conflicts.ts`: copy, newer, merge, and ask conflict behavior
- `large-objects.ts`: single-object vs chunked-object storage

This avoids turning `sync-engine.ts` into one large file while preserving the current implementation direction.

## Sync Operations

Encrypted sync supports these operation modes:

- `normal`: bidirectional sync using manifest and local sync state
- `manual`: user-triggered normal sync
- `forcePush`: make the remote encrypted repo match the local vault within sync scope
- `forcePull`: make the local vault match the remote encrypted manifest within sync scope

`forcePush` may mark/delete remote manifest entries and encrypted objects that are no longer present locally. It must require explicit confirmation.

`forcePull` is a destructive mirror operation. It downloads remote encrypted content and deletes local files within sync scope that are not present in the remote manifest. It must require explicit confirmation.

Manual sync should still be available when automatic sync is disabled. The existing `syncEnabled` setting remains a master switch for automatic sync behavior, not for manual buttons.

## Settings

Add settings:

- `syncOnStartup: boolean`
- `syncOnLocalChange: boolean`
- `scheduledSyncEnabled: boolean`
- `scheduledSyncIntervalSeconds: number`
- `ignorePathRegex: string`
- `conflictPolicy: "copy" | "newer" | "merge" | "ask"`

Existing `syncEnabled` remains the master switch for automatic sync. If `syncEnabled` is false:

- startup sync does not run
- local-change sync does not run
- scheduled sync does not run
- manual sync buttons remain usable

Suggested defaults:

- `syncOnStartup: true`
- `syncOnLocalChange: true`
- `scheduledSyncEnabled: false`
- `scheduledSyncIntervalSeconds: 300`
- `ignorePathRegex: ""`
- `conflictPolicy: "copy"`

## UI Controls

Settings UI should expose:

- Manual sync button
- Force push local to remote button
- Force pull remote to local button
- Sync when Obsidian opens toggle
- Sync when local files change toggle
- Scheduled sync toggle
- Scheduled sync interval seconds input
- Path ignore regex textarea
- Conflict policy dropdown

Force push and force pull controls must show confirmation modals explaining what will be overwritten or deleted.

The ignore regex setting description must include examples:

- `^Archive/` ignores the `Archive` folder
- `(^|/)\\.DS_Store$` ignores `.DS_Store` files
- `\\.tmp$` ignores files ending in `.tmp`

## Automatic Sync Behavior

Startup sync:

- runs only when `syncEnabled` and `syncOnStartup` are true
- runs after Obsidian layout is ready
- should not run if GitHub configuration or encrypted passphrase is missing

Local-change sync:

- runs only when `syncEnabled` and `syncOnLocalChange` are true
- applies to create, modify, delete, and rename events
- respects debounce behavior
- respects ignore regex rules before encrypting or deleting

Scheduled sync:

- runs only when `syncEnabled`, `scheduledSyncEnabled`, and a valid positive interval are set
- uses a single registered interval timer
- skips a tick if another sync is already running
- interval is stored in seconds

## Repository Classification

Before encrypted operations that may initialize a repository, classify the remote repo as:

- `empty`: no relevant blobs exist
- `encrypted-plugin`: `.obsidian-github-sync-encrypted/config.json` exists
- `foreign-nonempty`: repo contains files but does not look like this encrypted plugin layout
- `corrupt-plugin`: encrypted plugin layout exists but config or manifest is structurally invalid for reasons other than passphrase authentication
- `wrong-passphrase`: config is readable, but `manifest.enc` cannot be decrypted/authenticated with the supplied passphrase

Behavior:

- `empty`: allow initialization
- `encrypted-plugin`: continue normal operation
- `foreign-nonempty`: ask the user to choose `Force push local to remote` or `Cancel`
- `wrong-passphrase`: show a clear wrong-password/key-mismatch message and stop
- `corrupt-plugin`: show a corruption/error message and stop

The plugin must not silently initialize encrypted state in a foreign non-empty repo.

## Error Reporting

Sync failures must not crash the plugin or mark local sync state as successful.

Errors should report:

- operation name, such as manual sync, force push, force pull, startup sync, scheduled sync, or local change sync
- path or encrypted object path when available
- concise user-facing reason
- detailed console error for debugging

Wrong passphrase is treated as a specific user-facing error, not a generic decrypt failure.

Repository foreign-content detection is treated as a decision prompt, not a generic error.

## Ignore Regex

`ignorePathRegex` is evaluated against normalized plaintext vault paths before encryption.

Parsing rules:

- split by line
- trim whitespace
- ignore empty lines
- ignore lines starting with `#`
- invalid regex lines should be reported and should block sync until fixed

Ignore rules affect:

- normal scan/push
- force push
- force pull deletion scope
- local file event sync

Ignored local files are not uploaded. During force pull, ignored local files are not deleted even if missing from remote.

## Conflict Policies

Conflict means both local and remote changed since the last known synced state.

Policies:

- `copy`: keep local, write remote as a conflict copy
- `newer`: choose the version with the newer timestamp; if timestamps are equal or unavailable, fall back to `copy`
- `merge`: merge text-like files and fall back to `copy` for binary or failed merges
- `ask`: show a modal immediately, including during background or scheduled sync

Text-like merge applies only to known text paths such as `.md`, `.txt`, `.json`, and `.canvas`. Binary files always fall back to `copy`.

For `ask`, multiple conflicts are handled as a queue so modals do not stack on top of each other.

## Large-File Chunking

GitHub warns above 50 MiB and blocks files larger than 100 MiB. Encrypted sync should chunk encrypted object payloads when the payload would exceed 50 MiB.

Manifest object records gain storage metadata:

- `storage: "single"` for current single encrypted object behavior
- `storage: "chunked"` for chunked encrypted object sets
- chunk count
- ordered chunk paths
- per-chunk remote SHA values
- plaintext SHA-256 for the full file
- encrypted object or chunk metadata needed for updates/deletes

Chunk path format:

```text
.obsidian-github-sync-encrypted/objects/ab/cd/<object-id>.parts/000001.enc
```

Each chunk is encrypted independently with its own nonce. Pull downloads chunks in manifest order, decrypts each chunk, concatenates plaintext bytes, verifies full plaintext SHA-256, and writes the local file only after verification succeeds.

Force push, force pull, normal delete, and cleanup must treat a chunked file as one logical file.

## Testing Strategy

Tests should cover:

- ignore regex parsing and invalid regex reporting
- repository classification for empty, encrypted, foreign, wrong passphrase, and corrupt states
- force pull deletion scope
- force push remote tombstone/object cleanup planning
- conflict policy decision behavior
- text merge fallback for binary files
- chunk path generation and ordered reassembly
- chunk threshold behavior at and above 50 MiB
- no local sync state update after failed push/pull

## First Implementation Scope

In scope:

- encrypted sync controls and settings
- repository classification and prompts
- force push and force pull
- manual sync button
- startup/local-change/scheduled sync toggles
- ignore regex on plaintext paths
- conflict policy selection
- chunked storage for large encrypted objects
- user-facing error reporting

Out of scope:

- plaintext sync feature parity for every new setting
- remote garbage collection beyond objects known in manifest
- a full graphical conflict resolution dashboard
- semantic markdown merge beyond line-based text merge
- Git LFS integration
