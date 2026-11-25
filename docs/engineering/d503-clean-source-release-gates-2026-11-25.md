# D503 — Clean-source regression and release gates

Date: 2026-11-25. Source tested: detached clean `1614c30` (D502 production fix `4b11ee1`; audit evidence HEAD `07f4097`). Worktree: `.worktrees/d493-native-live-qualification`. No source changes or live vault/GitHub mutations in this round. Existing Re-encryption WIP in the audit worktree was not used for qualification.

| Command | Result | Task ID |
| --- | --- | --- |
| `pnpm test:recovery` | PASS, exit 0 | `9965d47f-9e39-4548-8a8c-4215f4d6e840` |
| `pnpm test:resource` | PASS, 11/11, no skipped tests, exit 0 | `46adfd57-eec6-4da0-92f3-d214f7deef80` |
| `pnpm typecheck:max-strict` | PASS, exit 0 | `00cc7cb3-c920-40b2-97bf-46c018b6ea66` |
| `pnpm build` | PASS, exit 0 | `afe1bd65-857c-4b8b-a6c1-bd077ce817e4` |
| `pnpm validate:metadata` | PASS, exit 0 | `92805b6c-820f-4b7a-bd46-950607174930` |
| `pnpm test:feasibility` | PASS, exit 0 | `79308974-4141-4d20-854f-d9d2c08eb075` |
| `pnpm validate:package` | PASS, exit 0 | `b5a2b68c-15e2-4a9f-a21c-63b8eeb172b8` |
| `pnpm typecheck:github-e2e` | PASS, exit 0 | `76a361c3-8017-4d86-86d7-964a92b8b6fa` |
| `pnpm test:fast:offline-qualified --plan` | PASS, plan only: 155 files, 154 ordinary files, 190 heavy cases | `40a18c4e-cba5-44a3-b607-1ae8fc689710` |
| `pnpm test:fast` | Pending terminal result; NOT qualified | `fdb5138e-ce2b-4d6f-9c25-ebf17dd8a38e` |

Recovery and Feasibility output was truncated by the tool; exact aggregate test counts were not verified. Recovery includes real Windows filesystem/process termination cases, not physical power-loss proof. These local results are not native iOS, new live GitHub, or installed Re-encryption evidence. Remaining release gates: full Fast coverage, native bulk (1,000 notes), plaintext peer, publication crash/advanced HEAD boundaries, iOS, installed Re-encryption and final local release qualification. Maximum generated fixture 500 MiB; ordinary mobile capability ceiling 32 MiB.
