export const CANONICAL_REPOSITORY = "crystalicez/obsidian-github-sync-multi-platform";

function failRemote(message = "Unsupported GitHub remote URL") {
  throw new Error(message);
}

function normalizeRepositoryPath(pathname) {
  const clean = pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  const segments = clean.split("/");
  if (segments.length !== 2 || segments.some(segment => !segment || /\s/u.test(segment))) {
    failRemote();
  }
  return `${segments[0]}/${segments[1]}`;
}

export function parseGitHubRemote(raw) {
  if (typeof raw !== "string" || raw.trim() === "") failRemote();
  const value = raw.trim();

  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu.exec(value);
  if (scp) return `${scp[1]}/${scp[2]}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    failRemote();
  }

  if (url.hostname.toLowerCase() !== "github.com" || url.port || url.search || url.hash) failRemote();
  if (url.protocol === "https:") {
    if (url.username || url.password) failRemote("Credential-bearing GitHub HTTPS remotes are not allowed");
  } else if (url.protocol === "ssh:") {
    if (url.username !== "git" || url.password) failRemote();
  } else {
    failRemote();
  }

  return normalizeRepositoryPath(url.pathname);
}

export function repositoriesEqual(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function runGitUrlQuery({ runner, cwd, args, label }) {
  const result = runner("git", args, { cwd, encoding: "utf8" });
  if (!result || result.status !== 0) throw new Error(`Unable to read origin ${label} URL`);
  const lines = String(result.stdout ?? "").split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`Origin must have exactly one effective ${label} URL`);
  return parseGitHubRemote(lines[0]);
}

export function readOriginFetchRepository({ runner, cwd }) {
  return runGitUrlQuery({
    runner,
    cwd,
    args: ["remote", "get-url", "--all", "origin"],
    label: "fetch",
  });
}

export function requireCanonicalOriginEndpoints({ runner, cwd }) {
  const fetchRepository = readOriginFetchRepository({ runner, cwd });
  const pushRepository = runGitUrlQuery({
    runner,
    cwd,
    args: ["remote", "get-url", "--push", "--all", "origin"],
    label: "push",
  });

  if (!repositoriesEqual(fetchRepository, CANONICAL_REPOSITORY)) {
    throw new Error(`Origin fetch repository must be ${CANONICAL_REPOSITORY}`);
  }
  if (!repositoriesEqual(pushRepository, CANONICAL_REPOSITORY)) {
    throw new Error(`Origin push repository must be ${CANONICAL_REPOSITORY}`);
  }

  return { fetchRepository, pushRepository };
}
