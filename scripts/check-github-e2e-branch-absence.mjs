// Read-only external verification of the exact disposable GitHub test branch.
// Never deletes, creates or mutates anything; fail closed on ambiguity.
import { resolve } from "node:path";
import { loadGitHubE2EEnv } from "./github-e2e-env.mjs";
import { CANONICAL_REPOSITORY_ID } from "./github-repo.mjs";
import { preflightE2ERemote, readE2EBranch } from "./github-e2e-remote.mjs";

const branch = process.argv[2];
if (process.argv.length !== 3 || !/^obsidian-sync-e2e\/local-[A-Za-z0-9_-]{6,105}$/u.test(branch ?? "")) {
  throw new Error("Specify exactly one obsidian-sync-e2e/local-* disposable branch");
}
const { env } = await loadGitHubE2EEnv({
  cwd: process.cwd(),
  env: process.env,
  envFile: resolve(process.cwd(), "..", "..", ".env.github-e2e"),
});
if (env.GITHUB_E2E_OWNER !== "diamond-crystal"
  || env.GITHUB_E2E_REPO !== "test-vault-obsidian-encrypted-github-sync-multi-platform"
  || !env.GITHUB_E2E_TOKEN) throw new Error("Unapproved test repository or missing local token");

const config = {
  owner: env.GITHUB_E2E_OWNER, repo: env.GITHUB_E2E_REPO,
  token: env.GITHUB_E2E_TOKEN, branch,
  expectedRepoId: "1284153873", currentSourceRepoId: CANONICAL_REPOSITORY_ID,
};
const retry = async action => {
  for (let i = 0; i < 6; i += 1) {
    try { return await action(); }
    catch (error) {
      if (i === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, (i + 1) * 1200));
    }
  }
};
const target = await retry(() => preflightE2ERemote({ config }));
if (target.id !== "1284153873") throw new Error("Wrong pinned test repository");
const ref = { owner: config.owner, repo: config.repo, branch, token: config.token };
const a = await retry(() => readE2EBranch(ref));
const b = await retry(() => readE2EBranch(ref));
if (a.kind !== "absent" || b.kind !== "absent") {
  throw new Error("Disposable GitHub branch is still present; do not claim cleanup");
}
console.log(JSON.stringify({ status: "READ_ONLY_CLEANUP_VERIFIED_TWICE", branch, repoId: target.id }));
