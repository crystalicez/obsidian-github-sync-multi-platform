# Superseded: Official Local Qualification and Release Design

This design has been superseded after a second full codebase/tooling audit.

Use the authoritative replacement:

`docs/superpowers/specs/2026-08-27-local-qualification-and-release-design.md`

The replacement records the decision alternatives and rationale, fixes the stable-ref concurrency protocol, separates manual E2E source detection from official canonical-origin authority, validates origin push URLs, adds out-of-band E2E cleanup, preserves the repository's existing stable-version syntax, stages static release assets from exact Git blobs, pins GitHub CLI operations to `github.com`, and defines the realistic remote-master race boundary.

The previous text remains available in Git history for audit purposes.
