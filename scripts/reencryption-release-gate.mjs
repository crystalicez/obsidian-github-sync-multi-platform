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
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || manifest.schemaVersion !== 1
    || manifest.gate !== "first-public-release-reencryption-wizard"
    || manifest.status !== "qualified"
    || !manifest.checks || typeof manifest.checks !== "object"
    || Array.isArray(manifest.checks)
    || REENCRYPTION_RELEASE_CHECKS.some(check => manifest.checks[check] !== "passed")) {
    throw new Error("Stable release blocked: Re-encryption Wizard must be fully qualified before the first release.");
  }
}
