import { access, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const required = ["main.js", "manifest.json", "styles.css"];
for (const file of required) {
  await access(file);
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty release artifact: ${file}`);
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (packageJson.version !== manifest.version) {
  throw new Error(`Version mismatch: package.json=${packageJson.version} manifest.json=${manifest.version}`);
}
if (typeof manifest.id !== "string" || !manifest.id) throw new Error("manifest.json is missing plugin id");

function gitStatus(args) {
  return spawnSync("git", args, { stdio: "ignore" }).status;
}

for (const secret of [".env", ".env.github-e2e", ".env.github-e2e.local"]) {
  if (gitStatus(["ls-files", "--error-unmatch", "--", secret]) === 0) {
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

console.log(`Validated release artifacts for ${manifest.id} v${manifest.version}`);
