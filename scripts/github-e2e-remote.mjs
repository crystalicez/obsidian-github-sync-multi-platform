const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const SHA_RE = /^[0-9a-f]{40}$/u;

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
  };
}

function encoded(value) {
  return encodeURIComponent(value);
}

function encodedBranch(branch) {
  return branch.split("/").map(encoded).join("/");
}

async function fetchResponse(fetchImpl, url, options, label) {
  try {
    return await fetchImpl(url, options);
  } catch {
    throw new Error(`${label} failed due to a network error`);
  }
}

async function readJsonObject(response, label) {
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned malformed JSON`);
  }
  return value;
}

function apiStatusError(label, status) {
  return new Error(`${label} failed with HTTP ${status}`);
}

function repositoryUrl(owner, repo) {
  return `${API_BASE}/repos/${encoded(owner)}/${encoded(repo)}`;
}

function branchReadUrl(owner, repo, branch) {
  return `${repositoryUrl(owner, repo)}/git/ref/heads/${encodedBranch(branch)}`;
}

function branchDeleteUrl(owner, repo, branch) {
  return `${repositoryUrl(owner, repo)}/git/refs/heads/${encodedBranch(branch)}`;
}

export async function readE2ERepository({ fetchImpl = fetch, owner, repo, token }) {
  const response = await fetchResponse(fetchImpl, repositoryUrl(owner, repo), { headers: headers(token) }, "GitHub E2E repository lookup");
  if (response.status !== 200) throw apiStatusError("GitHub E2E repository lookup", response.status);
  const body = await readJsonObject(response, "GitHub E2E repository lookup");
  if (typeof body.default_branch !== "string" || body.default_branch.trim() === "") {
    throw new Error("GitHub E2E repository lookup returned no valid default branch");
  }
  return { defaultBranch: body.default_branch };
}

export async function readE2EBranch({ fetchImpl = fetch, owner, repo, branch, token }) {
  const response = await fetchResponse(fetchImpl, branchReadUrl(owner, repo, branch), { headers: headers(token) }, "GitHub E2E branch lookup");
  if (response.status === 404) return { kind: "absent" };
  if (response.status !== 200) throw apiStatusError("GitHub E2E branch lookup", response.status);
  const body = await readJsonObject(response, "GitHub E2E branch lookup");
  const sha = body?.object?.sha;
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    throw new Error("GitHub E2E branch lookup returned an invalid commit SHA");
  }
  return { kind: "present", sha };
}

export async function preflightE2ERemote({ fetchImpl = fetch, config }) {
  const repository = await readE2ERepository({
    fetchImpl,
    owner: config.owner,
    repo: config.repo,
    token: config.token,
  });
  if (config.branch === repository.defaultBranch) {
    throw new Error(`Refusing destructive GitHub E2E against repository default branch: ${repository.defaultBranch}`);
  }
  return repository;
}

export async function cleanupE2EBranch({
  fetchImpl = fetch,
  owner,
  repo,
  branch,
  token,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxAttempts = 3,
}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("maxAttempts must be an integer between 1 and 10");
  }
  const deleteUrl = branchDeleteUrl(owner, repo, branch);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = await readE2EBranch({ fetchImpl, owner, repo, branch, token });
    if (before.kind === "absent") return;

    const deleted = await fetchResponse(fetchImpl, deleteUrl, { method: "DELETE", headers: headers(token) }, "GitHub E2E branch cleanup");
    if (deleted.status === 401 || deleted.status === 403) {
      throw apiStatusError("GitHub E2E branch cleanup", deleted.status);
    }
    if (![204, 404].includes(deleted.status) && (deleted.status < 500 || deleted.status > 599)) {
      throw apiStatusError("GitHub E2E branch cleanup", deleted.status);
    }

    const verify = await readE2EBranch({ fetchImpl, owner, repo, branch, token });
    if (verify.kind === "absent") return;
    if (attempt < maxAttempts) await sleep(attempt * 2_000);
  }
  throw new Error(`Disposable GitHub E2E branch still exists after ${maxAttempts} cleanup attempts: ${branch}`);
}
