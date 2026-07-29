# V4 Characterization Baseline Before Production Refactor

This map identifies the existing/new tests that must remain green while the V4 execution layer is hardened. It is intentionally behavior-oriented: the purpose is to prevent a refactor from silently changing protocol or user-visible sync semantics.

## Planner and force operations

- `tests/v4/planner.test.ts`
  - normal three-way create/modify/delete/rename planning
  - Force Push local-to-remote mirror planning
  - Force Pull remote-to-local mirror planning
- `tests/v4/sync-session.test.ts`
  - one-commit Force Push and Force Pull behavior
  - encrypted-head authentication before Force Push overwrite
  - confirmed legacy encrypted path-layout migration
  - exact-mirror stale object deletion
  - stable file identity through migration/rename scenarios

## Storage protocol

- `tests/v4/protocol-contract.test.ts`
  - 50 MiB threshold and predicted encrypted-overhead behavior
  - variable-size chunk reader compatibility
  - opaque-stable encrypted chunk AAD/order binding
  - unchanged encrypted relocation reuses content object identity
- `tests/v4/storage-codec.test.ts`
  - plaintext/encrypted single objects
  - >50 MiB chunk round-trip
  - opaque encrypted part/pack paths
- `tests/v4/storage-history.test.ts`
  - large-part joining/hash verification and history storage behavior

## Packs

- `tests/v4/sync-session.test.ts`
  - encrypted pack Force Push/Force Pull/history round-trip
  - pack migration/retained object behavior
- `tests/v4/storage-codec.test.ts`
  - encrypted pack codec behavior

Current pack thresholds/grouping remain source behavior until a dedicated metadata-first pack-planning change is introduced under tests.

## Conflict behavior

- `tests/v4/conflicts.test.ts`
  - copy/newer/merge/fallback decisions
- `tests/v4/sync-session.test.ts`
  - `keep-local-copy-remote` logical pull/push counts and copy identity
  - merged output becomes both local content and pushed content
  - conflict decisions complete before deferred local application
- `tests/v4/settings-secrets.test.ts`
  - conflict copy identity is reused across CAS retry

Execution refactors may move when bytes are staged/applied, but must preserve the same final logical outcomes and conflict-copy identity unless an explicit behavior change is separately approved.

## Publication identity and CAS

- `tests/v4/sync-session.test.ts`
  - published message is parsed as `obsidian-sync-v4:${journalId}` and used to locate the matching journal
- `tests/v4/git-tree-writer.test.ts`
  - existing branch uses expected-head CAS input
  - empty repository bootstrap behavior
- `tests/v4/github-transport.test.ts`
  - bootstrap commit message `obsidian-sync-v4:bootstrap`

The existing marker format is a contract; recovery hardening should reuse it rather than add a second remote marker scheme.

## Privacy and malformed-remote safety

- `tests/v4/opaque-leakage.test.ts`
  - encrypted remote metadata/object paths do not disclose known logical path/content fragments
- `tests/v4/sync-session.test.ts`
  - duplicate file IDs, duplicate paths and fabricated path identities fail before normal/Force Pull mutation
  - malformed/unauthenticated encrypted state cannot be used for destructive force behavior

## Test determinism baseline

The manual nearest-equivalent harness (used only because official dependencies cannot be installed in the current network environment) passed ten consecutive runs after fixed event-loop-tick waits were replaced by observable-condition waits. The official pnpm build/test gate must still be rerun once dependencies are available.
