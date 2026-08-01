# V4 GitHub Free Operational Model

Date checked: 2026-07-30

This is an operational-suitability model for the existing V4 Git-object protocol. It is not a statement that GitHub guarantees a particular repository size or request budget forever.

## Current GitHub guidance used

GitHub's current REST guidance recommends serial requests and at least one second between large numbers of mutative requests. Current secondary limits say content generation is generally no more than 80 requests/minute and 500/hour, and GitHub explicitly says secondary limits can change without notice.

GitHub's repository-limit guidance recommends an on-disk repository size no larger than 10 GB. It recommends individual Git objects no larger than 1 MB and enforces 100 MB. The V4 historical 48 MiB parts are below the enforced object maximum but above the recommended object size.

References:

- https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits

## Current 5 GiB model

Command:

```bash
node scripts/model-github-v4-large-file.mjs
```

With the current 48 MiB writer policy and the conservative metadata/publication allowance:

| Logical size | Part size | Parts | Modeled content mutations | Minimum 1-second pacing | Approx. encrypted revision growth |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 GiB | 48 MiB | 107 | 114 | 113 s | ~5.000 GiB |

The 114 modeled mutations are 22.8% of the general 500/hour content-generation guidance and below this project's conservative 70% safety budget for one modeled revision. Two full encrypted revisions are already slightly above the 10 GB repository-size recommendation before ordinary history and other vault files are considered.

V4 modifications create a new encrypted `remoteVersion`; there is no changed-part/delta protocol. A changed 5 GiB file therefore has approximately 5 GiB of new encrypted content, and an orphaned full candidate can have similar object cost even if it never becomes branch-reachable.

## Classification

- **Model-level technical classification:** `technical-pass-operational-limited`.
- **Release status before a real disposable-repository measurement:** `measurement-required`; release classification remains unset.

Do not upgrade the release classification using theoretical API acceptance alone.

## Real measurement inputs

After one disposable-repository large revision, feed the observed values back into the model:

```bash
MEASURED_MUTATIONS=<observed> \
MEASURED_SECONDS=<observed> \
MEASURED_REVISION_BYTES=<observed repository growth> \
MEASURED_ORPHAN_BYTES=<observed or bounded orphan cost> \
node scripts/model-github-v4-large-file.mjs
```

Measure repository growth using one consistent method before/after the revision. Do not create repeated 5 GiB revisions merely to exceed repository-health guidance; use the measured one-revision growth proportionally for 2/3-revision projections.

## Decision rule

- `operational-pass`: measured request/pacing behavior is healthy for the intended workload **and** projected repository growth stays within the chosen health envelope.
- `technical-pass-operational-limited`: the complete path works, but repeated revisions are unsuitable or require explicit user limits/maintenance guidance.
- `platform-capability-fail`: the complete path cannot be executed safely on the platform.

The current model strongly predicts `technical-pass-operational-limited` for repeated 5 GiB encrypted revisions on a personal GitHub repository, but a real one-revision measurement is still required before publishing that as a release qualification result.
