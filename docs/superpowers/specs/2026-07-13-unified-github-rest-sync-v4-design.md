# Unified GitHub REST Sync V4 Design

## Goal

Replace the split plaintext and encrypted sync paths with one GitHub REST based engine that is correct, atomic, scalable, mobile-compatible, and consistent across storage modes.

## Remote Format

V4 reserves `.obsidian-github-sync-v4/` for configuration, sharded indexes, history journals, encrypted data, large-file parts, and directory-local packs. Plaintext files at or below the large-file threshold remain at their vault paths. Encrypted files retain their plaintext folder hierarchy under the V4 data root while their basenames, contents, indexes, and journals remain opaque.

`config.json` contains format version, storage mode, random salt, and KDF parameters. It never contains a token, passphrase, plaintext basename, file content, or plaintext content hash. Encryption uses PBKDF2-SHA-256 with 600,000 iterations, a random per-repository salt, domain-separated keys, and AES-256-GCM with fresh nonces.

Files whose logical or encrypted payload exceeds 50 MiB use ordered parts no larger than 48 MiB. A full-file SHA-256 protects reassembly. Small encrypted files may use directory-local packs capped below the same remote blob threshold.

## Sync Model

Every automatic and manual normal sync performs a read-only preflight, builds a three-way plan from base/local/remote state, checks conflicts and the modification guard, stages and verifies remote data, applies pulls, rescans queued local paths, then publishes only required local changes in one atomic Git commit. The branch ref is updated with compare-and-swap semantics.

Local file events use one trailing five-second debounce. Repeated modifications, rename chains, and create-delete pairs are coalesced. Events arriving during a sync form the next batch. Manual and force operations pressed during an active sync report that a sync is already in progress. Scheduled ticks skip while busy.

No-change sync performs no content read, recursive tree read, blob download, or Git mutation. Normal CAS failures re-plan at most three times. Force operations stop on concurrent branch movement.

## Safety and Conflicts

Conflict policy is one of `copy`, `newer`, `merge`, or `ask`. Copy preserves both versions and publishes the conflict copy in the same atomic commit. Newer falls back to copy for equal or unavailable timestamps. Merge is a clean three-way line merge for supported UTF-8 text files no larger than 2 MiB and falls back to copy for binary or overlapping changes. Ask queues one modal at a time and supports applying a choice to remaining conflicts.

The modification guard computes planned logical file changes divided by the largest active file count among base, local, and remote. Rename counts as one change and the result is capped at 100 percent. Zero disables the guard. Every operation is checked before writes; force operations may use a separately confirmed one-time override.

Force push and force pull mirror only the configured sync scope. Ignore rules and built-in exclusions are preserved. V1/V2/V3 remote formats require V4 force push; legacy force pull is not supported. Encrypted mode refuses a target with plaintext ancestors and recommends a new empty repository. An orphan branch is accepted only with an explicit warning that plaintext on other refs remains accessible.

## Sync Scope

All file types outside `.obsidian` are eligible. Ignore regexes run against normalized plaintext vault paths. Three independent settings control general `.obsidian` configuration, bookmarks, and plugins. Workspace, mobile workspace, cache, temporary, and log files are always excluded. The sync plugin's own directory is always excluded. Plugin sync includes other plugin files, their data, and `community-plugins.json`, with a plaintext-mode warning about possible secrets.

## History and Status

Each plugin commit includes a paged journal recording stable file IDs and before/after storage descriptors. Journals are plaintext in plaintext mode and authenticated encrypted data in encrypted mode. Stable file IDs preserve file history across rename.

The Sync Center uses an adaptive master-detail layout with commit and file modes, 50-commit pagination, virtualized file lists, filters, and lazy preview. Text uses unified or side-by-side source diffs, images use before/after thumbnails, and other binary files show metadata. History is read-only in V4.

Status phases are idle, debouncing, checking remote, planning, blocked, resolving conflicts, downloading, applying, hashing, encrypting, uploading, committing, retrying, no change, success, and failed.

## Settings and Secrets

GitHub tokens and encryption passphrases move to Obsidian SecretStorage using generated per-vault IDs. Plaintext legacy secrets are removed from plugin data only after successful migration. The minimum supported Obsidian version becomes 1.11.4.

New settings default to: plaintext mode; automatic, startup, and local-change sync enabled; scheduled sync disabled at 300 seconds; copy conflicts; zero-percent guard; `.obsidian`, bookmarks, and plugins disabled; status bar enabled.

## Performance and Verification

The planner and indexes must represent 100,000 files totaling 5 GiB within 10 seconds and no more than 256 MiB heap growth on the reference CI environment. A one-file edit may not read unrelated file content or recursively fetch the remote tree. A no-change sync performs zero blob/tree downloads and zero mutations.

Tests cover unit policies and formats, fake GitHub/vault integration, real GitHub round trips, multi-device races, random file actions, 51 MiB chunking, request counts, and final byte equality.
