import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const REENCRYPTION_RELEASE_CHECKS = Object.freeze([
  "ownerApprovedMigrationTopology",
  "safePreviewAndBackup",
  "completeReencryptionAndIntegrityVerification",
  "interruptedMigrationRecovery",
  "multiDeviceCutoverAndStaleClientSafety",
  "gitHistoryAndOldKeyDisclosure",
  "nativeDesktopAndMobileAcceptance",
]);

const MANIFEST_KEYS = Object.freeze(["schemaVersion", "gate", "status", "backupPolicy", "checks"]);
const BACKUP_POLICY_KEYS = Object.freeze([
  "acceptedMode", "sharedRepositoryFailureDomainAccepted", "independentCopyRequired",
]);

// Fail closed when a new requirement is added to the manifest but this gate
// has not yet been taught how to verify it. A future pending check must never
// be silently ignored by an older release script.
function hasExactKeys(value, expectedKeys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every(key => Object.hasOwn(value, key));
}

/**
 * Default-deny policy gate for the first public release. This manifest is a
 * maintainer acceptance declaration, NOT a substitute for qualification tests.
 * Missing/malformed/incomplete evidence never authorizes publication.
 */
export async function requireReencryptionWizardReleaseGate({
  cwd = process.cwd(),
  readText = readFile,
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readText(join(cwd, "docs/release-gates/reencryption-wizard.json"), "utf8"));
  } catch {
    throw new Error("Stable release blocked: Re-encryption Wizard gate evidence is absent or invalid.");
  }
  if (!hasExactKeys(manifest, MANIFEST_KEYS)
    || manifest.schemaVersion !== 1
    || manifest.gate !== "first-public-release-reencryption-wizard"
    || manifest.status !== "qualified"
    // Choice B accepts a verified same-repository backup, NOT unverified or independent storage.
    || !hasExactKeys(manifest.backupPolicy, BACKUP_POLICY_KEYS)
    || manifest.backupPolicy.acceptedMode !== "verified-same-repository-branch"
    || manifest.backupPolicy.sharedRepositoryFailureDomainAccepted !== true
    || manifest.backupPolicy.independentCopyRequired !== false
    || !hasExactKeys(manifest.checks, REENCRYPTION_RELEASE_CHECKS)
    || REENCRYPTION_RELEASE_CHECKS.some(check => manifest.checks[check] !== "passed")) {
    throw new Error("Stable release blocked: Re-encryption Wizard must be fully qualified before the first release.");
  }
}
