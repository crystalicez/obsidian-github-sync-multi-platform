import { readFile } from "node:fs/promises";
import { join } from "node:path";

const STABLE_TRIPLE_RE = /^\d+\.\d+\.\d+$/u;
const NODE_VERSION_RE = /^v\d+\.\d+\.\d+$/u;
const PNPM_PACKAGE_MANAGER_RE = /^pnpm@([^+\s]+)(?:\+.+)?$/u;

export function parseStableTriple(value) {
  if (typeof value !== "string" || !STABLE_TRIPLE_RE.test(value)) return null;
  return value.split(".").map(part => BigInt(part));
}

export function compareStableTriples(a, b) {
  const left = parseStableTriple(a);
  const right = parseStableTriple(b);
  if (!left || !right) throw new Error(`Invalid stable triple: ${a}, ${b}`);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function declaredPnpmVersion(packageManager) {
  if (typeof packageManager !== "string") {
    throw new Error("packageManager must declare pnpm@<version>");
  }
  const match = PNPM_PACKAGE_MANAGER_RE.exec(packageManager);
  if (!match || !STABLE_TRIPLE_RE.test(match[1])) {
    throw new Error("packageManager must declare pnpm@<x.y.z>");
  }
  return match[1];
}

export async function readReleaseMetadata(cwd = process.cwd()) {
  const [packageJsonText, manifestText, versionsText, nodeVersionText] = await Promise.all([
    readFile(join(cwd, "package.json"), "utf8"),
    readFile(join(cwd, "manifest.json"), "utf8"),
    readFile(join(cwd, "versions.json"), "utf8"),
    readFile(join(cwd, ".node-version"), "utf8"),
  ]);

  const packageJson = JSON.parse(packageJsonText);
  const manifest = JSON.parse(manifestText);
  const versions = JSON.parse(versionsText);
  const nodeVersion = nodeVersionText.trim();
  const pnpmVersion = declaredPnpmVersion(packageJson.packageManager);

  return { packageJson, manifest, versions, nodeVersion, pnpmVersion };
}

export function validateReleaseMetadata(metadata, { requestedVersion } = {}) {
  if (!metadata || typeof metadata !== "object") throw new Error("Release metadata is required");
  const { packageJson, manifest, versions } = metadata;
  if (!packageJson || typeof packageJson !== "object") throw new Error("package.json metadata is required");
  if (!manifest || typeof manifest !== "object") throw new Error("manifest.json metadata is required");
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) throw new Error("versions.json metadata is required");

  if (!parseStableTriple(packageJson.version) || !parseStableTriple(manifest.version)) {
    throw new Error("Release version must be x.y.z");
  }
  if (packageJson.version !== manifest.version) {
    throw new Error(`Version mismatch: package.json=${packageJson.version} manifest.json=${manifest.version}`);
  }
  if (requestedVersion !== undefined) {
    if (!parseStableTriple(requestedVersion)) throw new Error(`Requested release version must be x.y.z: ${requestedVersion}`);
    if (requestedVersion !== packageJson.version) {
      throw new Error(`Requested version mismatch: requested=${requestedVersion} metadata=${packageJson.version}`);
    }
  }

  if (!parseStableTriple(manifest.minAppVersion ?? "")) {
    throw new Error("manifest.minAppVersion must be x.y.z");
  }
  if (versions[manifest.version] !== manifest.minAppVersion) {
    throw new Error(`versions.json mismatch for ${manifest.version}: expected ${manifest.minAppVersion}`);
  }
  if (typeof manifest.id !== "string" || manifest.id.trim() === "") {
    throw new Error("manifest.json is missing plugin id");
  }

  const nodeVersion = typeof metadata.nodeVersion === "string" ? metadata.nodeVersion.trim() : "";
  if (!NODE_VERSION_RE.test(nodeVersion)) {
    throw new Error(".node-version must declare v<major>.<minor>.<patch>");
  }

  const pnpmVersion = declaredPnpmVersion(packageJson.packageManager);
  if (metadata.pnpmVersion !== undefined && metadata.pnpmVersion !== pnpmVersion) {
    throw new Error(`pnpm version metadata mismatch: declared=${pnpmVersion} observed=${metadata.pnpmVersion}`);
  }

  return {
    version: packageJson.version,
    minAppVersion: manifest.minAppVersion,
    pluginId: manifest.id,
    nodeVersion,
    pnpmVersion,
  };
}
