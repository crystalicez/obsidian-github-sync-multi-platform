# D530 — Restart cutover readiness (2026-11-27)

Added a read-only Cutover Readiness command. Runtime now recognizes persisted cutover intent and verifies restart settings, hydrated destination credentials, physical vault parity, source ref, backup and destination evidence without authorizing activation, deleting credentials, or resuming sync. Source-settings pending intent and destination-settings readiness have distinct UI messages. Already-active, missing-key, drift and unverifiable states cannot be certified. Restart settings are authenticated again after the physical scan and the lease is rechecked. Existing activation/write gates remain unchanged.

## Evidence

- RED `8be98686-be26-439c-b20b-81b9d9338e91`: restart destination readiness absent.
- First attempt `c3d727d5-c674-4f95-97bf-47f9fe5e8a41`: 5/6; previous rehearsal validation rejected read-only restart with a physical reader. Corrected that validation only for non-authorizing inspection; added post-scan settings reauthentication.
- Final installed rehearsal `4c4c5d09-2e0f-477e-bfa2-90f71f78c41a`: 6/6, exit 0. Fresh Destination runtime verifies physical parity and source ref; settings, credential map, refs and source/shadow indexes unchanged; missing new key and physical drift rejected; already-active route returns null. Actual filesystem fixture and mock GitHub, not native device acceptance.
- Main UI `0aa701d7-7cd4-42f3-806d-8c4f6e454dbc`: 35/35. Distinct states, duplicate suppression, no sync invocation, sanitized exception. Source-intent UI state is mocked.
- Wizard `2179f192-31cf-4c01-a7ed-5945f3430b9e`: 40/40.
- Recovery `b5d7cc78-19a9-4939-affa-9234d53fefe4`: 95/95.
- UI/Wizard/Recovery were run before the final internal rehearsal guard adjustment; final installed rehearsal, strict typecheck, build and settings ran after it.
- Settings `c0f4d565-d0b2-438b-a22b-3d3693b852b1`: 82/82.
- Maximum strict `e340b714-8f8a-4ab4-b2fc-44b84badab70`, production build `200cede0-b3ec-45c3-958f-caf91abbb9e5`, metadata `4ef0430f-0cb8-4e50-9345-075fe90adb18`, package `026c6923-bf69-47d7-a5eb-8c33f9d1757e`: exit 0.

## Remaining release gates

Current exact-source Fast, D528 blocked publication mutation race, native activation/peer/preferences/repair, Force/connection/scope policy, public Wizard Execute, Android re-encryption within 32 MiB initiation cap. Physical iOS waived by owner. Prior native harness safety block not bypassed. No personal Vault, default branch, tag or release writes. Existing local HANDOFF changes preserved; only D530 source/tests/evidence staged.
