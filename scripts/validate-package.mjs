import { access, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { readReleaseMetadata, validateReleaseMetadata } from "./release-metadata.mjs";

const required = ["main.js", "manifest.json", "styles.css"];
for (const file of required) {
  await access(file);
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty release artifact: ${file}`);
}

const metadata = await readReleaseMetadata(process.cwd());
const release = validateReleaseMetadata(metadata);

function gitStatus(args) {
  return spawnSync("git", args, { stdio: "ignore" }).status;
}

function tracked(file) {
  return gitStatus(["ls-files", "--error-unmatch", "--", file]) === 0;
}

if (!tracked("pnpm-lock.yaml")) throw new Error("pnpm-lock.yaml must be tracked");
for (const alternate of ["package-lock.json", "yarn.lock"]) {
  if (tracked(alternate)) throw new Error(`Non-canonical lockfile is tracked: ${alternate}`);
}

for (const secret of [".env", ".env.github-e2e", ".env.github-e2e.local"]) {
  if (tracked(secret)) {
    throw new Error(`Tracked local secret must never enter release source: ${secret}`);
  }

  let exists = true;
  try {
    await access(secret);
  } catch (error) {
    if (error?.code === "ENOENT") exists = false;
    else throw error;
  }

  if (!exists) continue;
  if (gitStatus(["check-ignore", "-q", "--", secret]) === 0) continue;

  throw new Error(`Local secret is present but Git does not prove it is ignored: ${secret}`);
}

console.log(`Validated release artifacts for ${release.pluginId} v${release.version}`);
