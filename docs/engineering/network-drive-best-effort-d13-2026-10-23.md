# Stage D13 — Network Drive best-effort policy B

Date: 2026-10-23. Isolated audit branch; **not release approval**.

## Approved product policy

The user selected **B**: permit sync on Network Drives as best-effort, with
an explicit warning. Do **not** automatically disable staged writes merely
because the vault may be on a network, mapped or cloud-mounted filesystem.
This does **not** waive any integrity checks, manual Recovery requirements,
WAL/backup retention, or open-editor safeguards.

## UX and detection limits

- Desktop Settings show a persistent warning for **all Desktop vaults**,
  including mapped drives and cloud mounts that cannot be identified from the
  path alone. Warn that synchronous filesystem metadata operations may stall
  the UI, crash durability cannot be guaranteed, and independent backups
  remain necessary.
- When a Desktop vault path has a recognizable UNC root
  (`\\server\share`, slash variant, or `\\?\UNC\server\share`), a
  Notice appears **once per plugin runtime** on its first sync attempt.
  It does not block that attempt or add an unsafe override.
- No claim is made that a Windows drive letter, an SMB/NFS mount on Linux or
  macOS, or cloud-sync folders can be reliably classified via a path string.
  Failure to show a UNC-specific Notice is **not** evidence the vault is local.

## Qualification

`tests/v4/network-storage-warning.test.ts` covers UNC and non-UNC cases,
persistent Desktop Settings warning text, and a single UNC Notice while
normal sync precondition checks remain active. Existing staged integrity and
rollback guards are unchanged. This is a UX/policy change, **not** a measured
network-drive durability or latency qualification.

Remaining production work: measure synchronous `lstatSync` / `renameSync`
latency on representative network and slow drives, OS-handle TOCTOU,
full 1,000-note native scenario on the exact candidate, macOS/Linux/mobile,
coordinated C2 format changes and line-merge UI acceptance.
