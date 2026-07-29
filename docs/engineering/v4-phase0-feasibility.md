# V4 Phase 0 Feasibility Evidence

Date: 2026-07-29 (Asia/Bangkok project date)

## Purpose

This document records evidence gathered **before changing production code** for the V4 hardening plan. It answers four gating questions:

1. Can the current project be built and tested reproducibly in the available environment?
2. Can Windows/Android provide bounded local I/O suitable for a 5 GiB logical file without whole-file allocation?
3. Is the existing V4 Git-blob chunk protocol operationally reasonable for a 5 GiB file on a personal GitHub Free repository?
4. What transient-memory budget must include beyond raw chunk bytes?

This is a feasibility record, not a product support claim.

## 1. Baseline source and test status

- Baseline archive SHA-256: `37ece48eadb4666d37dc05d6f4d044711ac4b1c1b8db94b6bae495a8912f924a`.
- Local baseline Git commit: `27433440228be0f359434eb8daa67329eda320b8`.
- Original source manifest: 98 files; manifest SHA-256 `1b9de978d4203ee23f3fa04a7d337a411ad0425d9a9ec3ec52dd2843b9db2e98`.
- No production file under `src/` was modified during Phase 0.
- Official dependency installation is currently blocked in this environment: Corepack/pnpm cannot resolve `registry.npmjs.org` (`EAI_AGAIN`). The archive also contains a `package-lock.json` with stale Tencent mirror URLs while the declared package manager is pnpm.
- Because dependencies cannot be installed, an official `pnpm build` / `pnpm test` result is **not available** from this environment and must not be inferred.
- A temporary, untracked manual transpilation harness using the installed TypeScript compiler and the repository's Obsidian test stub ran the equivalent V4 suite. After replacing fixed event-loop-tick waits in tests with observable-condition waits, 10 consecutive runs completed with 224/224 TypeScript tests passing plus the legacy MJS test passing.

Interpretation: the source has a usable behavioral baseline, but the official package-manager/build gate remains blocked by network/dependency availability and must be rerun in a normal development environment before release.

## 2. Obsidian platform I/O gate

Current plugin manifest:

- `minAppVersion`: `1.11.4`.

The project currently depends on Obsidian typings `^1.12.3`. Public API evidence indicates that `appendBinary` was added for Obsidian 1.12.3, while public binary reads remain whole-buffer (`readBinary`) and there is no documented public ranged/streaming read API for mobile at the time of this evidence capture.

Planning implications:

- Production code must **not** silently require `appendBinary` while advertising `minAppVersion: 1.11.4`.
- Before using `appendBinary`, either:
  1. bump the minimum supported Obsidian version to a version that guarantees the API, or
  2. prove and test a safe feature-detected fallback.
- Bounded Android **write** appears more feasible on newer Obsidian versions because binary append exists.
- Bounded Android **read** remains unresolved with the documented public API. A physical Android prototype is required before any Android 5 GiB upload claim.
- If a stable supported bounded read path cannot be demonstrated, large-file upload must fail capability-safe above the configured whole-buffer ceiling rather than attempt a multi-gigabyte `readBinary()` allocation.

Reference:
- Obsidian developer forum discussion documenting whole-buffer mobile reads and the addition of `appendBinary` in 1.12.3: https://forum.obsidian.md/t/add-api-support-for-reading-and-writing-binary-by-chunks-or-streaming/77384

**Gate status:** Windows physical proof pending; Android bounded-read proof pending. Android 5 GiB support is therefore **not proven**.

## 3. GitHub Free / V4 5 GiB operating model

GitHub's current REST guidance says to make requests serially to avoid secondary limits and to wait at least one second between large numbers of mutative requests. Secondary content-generation limits are generally 80/minute and 500/hour, subject to change. GitHub's repository-health guidance recommends an on-disk repository size of at most 10 GB and recommends individual Git objects of at most 1 MB, while enforcing 100 MB per object.

References:
- https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2026-03-10
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits

The local model uses the existing V4 full-revision semantics and counts one Git blob mutation per part plus a conservative metadata/publication allowance. It does **not** model changed-part/delta sync because current V4 does not provide it.

| Writer part size | Parts for 5 GiB | Modeled mutations | % of 500/hour | Minimum 1s pacing time | Approx. Git data / revision | Two revisions vs. 10 GiB recommendation |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 48 MiB | 107 | 114 | 22.8% | 113 s | 5.000 GiB | over recommendation |
| 32 MiB | 160 | 167 | 33.4% | 166 s | 5.000 GiB | over recommendation |
| 16 MiB | 320 | 327 | 65.4% | 326 s | 5.000 GiB | over recommendation |

Important limitations:

- The pacing time above is a **lower bound caused by policy alone**; it excludes network transfer, crypto, retries, metadata reads and device I/O.
- Git object compression/storage details can change actual on-disk size; the model intentionally treats encrypted bytes as largely incompressible and is conservative.
- Current V4 content modifications create a new `remoteVersion` and upload a full new encrypted revision. Git history therefore accumulates old encrypted blobs.

**Provisional conclusion:** a 5 GiB V4 round trip may be technically possible, but repeated 5 GiB encrypted revisions are not presently justified as an operationally healthy GitHub Free workload. Repository growth is a stronger concern than the general hourly content-generation count for the historical 48 MiB writer size.

This conclusion must be revalidated with one disposable-repository measurement before release; do not create multiple 5 GiB revisions merely to prove the model if doing so would itself violate repository-health guidance.

## 4. Transport transient-memory evidence

Two local Node measurement passes were made for the current Git-blob request shape: raw bytes + simulated encrypted bytes + base64 string + JSON request body held during request construction. This is **not an Android measurement** and does not model every runtime copy, but it demonstrates that raw part size is not an adequate memory budget.

| Raw part | Measured peak RSS delta | Measured peak heap delta |
| ---: | ---: | ---: |
| 16 MiB | ~74.9 MiB | ~21.3 MiB |
| 32 MiB | ~133.3 MiB | ~42.7 MiB |
| 48 MiB | ~194–224 MiB across two runs | ~64.0 MiB |

Planning implication: the resource controller must budget transport encoding/transient allocations as well as raw/ciphertext bytes. A 48 MiB protocol-compatible historical part may be too expensive as a **new writer default** on some Android devices even though readers must continue to accept it.

## 5. Phase 0 decision

Current evidence supports the following decision:

- **Continue V4 hardening:** yes.
- **Change V4 remote format now:** no evidence justifies it.
- **Preserve existing 48 MiB reader compatibility:** yes.
- **Commit to 48 MiB as future Android writer size:** no; measure first.
- **Claim Windows 5 GiB support:** not yet; physical full-path test pending.
- **Claim Android 5 GiB support:** no; bounded-read path is unresolved and physical proof is pending.
- **Claim GitHub Free 5 GiB as an operationally suitable repeated workload:** no; current growth model is unfavorable for repeated full revisions.
- **Proceed with test/characterization/resource-controller work that benefits all file sizes:** yes.
- **Do not begin protocol-breaking V5 work solely from this evidence:** yes. The GitHub growth result is a decision input, but a V5/storage-backend decision should wait for the source-native V4 hardening measurements and the required-device I/O proof.

## 6. Required evidence before production large-file streaming is released

1. Official dependency install + build + test succeeds from the declared pnpm lockfile.
2. Windows bounded read/write/staging prototype passes on the real target device.
3. Android bounded read/write/staging prototype passes using a supported API/path, or large upload is explicitly capability-limited.
4. `minAppVersion` and any use of `appendBinary` are made consistent and tested.
5. Source-snapshot guard proves a file changed during streaming cannot reach the branch.
6. Transport-memory budget is measured on the actual Android target before selecting a writer part size.
7. One disposable GitHub Free large-file run validates request counts/pacing and compares repository growth to the model.
