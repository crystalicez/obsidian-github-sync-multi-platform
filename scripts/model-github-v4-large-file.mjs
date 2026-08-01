import { modelV4LargeFileRevision } from "./v4-phase0-models.mjs";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const logicalBytes = Number(process.env.LOGICAL_BYTES ?? 5 * GiB);
const spacingMs = Number(process.env.GITHUB_MUTATION_SPACING_MS ?? 1_000);
const hourlyGuidance = Number(process.env.GITHUB_CONTENT_HOURLY_GUIDANCE ?? 500);
const safetyFraction = Number(process.env.GITHUB_CONTENT_SAFETY_FRACTION ?? 0.70);
const recommendedRepoBytes = Number(process.env.GITHUB_RECOMMENDED_REPO_BYTES ?? 10 * GiB);
const measuredMutations = process.env.MEASURED_MUTATIONS ? Number(process.env.MEASURED_MUTATIONS) : undefined;
const measuredSeconds = process.env.MEASURED_SECONDS ? Number(process.env.MEASURED_SECONDS) : undefined;
const measuredRevisionBytes = process.env.MEASURED_REVISION_BYTES ? Number(process.env.MEASURED_REVISION_BYTES) : undefined;
const measuredOrphanBytes = process.env.MEASURED_ORPHAN_BYTES ? Number(process.env.MEASURED_ORPHAN_BYTES) : undefined;

const rows = [48, 32, 16].map(partMiB => {
  const model = modelV4LargeFileRevision(logicalBytes, partMiB * MiB, { mutationSpacingMs: spacingMs });
  const oneRevisionBytes = measuredRevisionBytes ?? model.estimatedRepositoryBytesPerRevision;
  return {
    partMiB,
    partCount: model.partCount,
    mutations: model.contentMutations,
    hourlyGuidanceFraction: model.contentMutations / hourlyGuidance,
    withinSafetyBudget: model.contentMutations <= hourlyGuidance * safetyFraction,
    minimumPacedSeconds: model.minimumPacedMutationMs / 1000,
    revisionGiB: oneRevisionBytes / GiB,
    twoRevisionGiB: (oneRevisionBytes * 2) / GiB,
    threeRevisionGiB: (oneRevisionBytes * 3) / GiB,
    twoRevisionsWithinRecommendedRepo: oneRevisionBytes * 2 <= recommendedRepoBytes,
    orphanGiB: (measuredOrphanBytes ?? logicalBytes) / GiB,
  };
});

const measured = {
  mutations: measuredMutations,
  seconds: measuredSeconds,
  revisionBytes: measuredRevisionBytes,
  orphanBytes: measuredOrphanBytes,
  complete: [measuredMutations, measuredSeconds, measuredRevisionBytes].every(Number.isFinite),
};
const writer48 = rows[0];
const modelClassification = writer48.withinSafetyBudget && writer48.twoRevisionsWithinRecommendedRepo
  ? "operational-pass"
  : "technical-pass-operational-limited";
const measuredWithinSafetyBudget = Number.isFinite(measuredMutations)
  ? measuredMutations <= hourlyGuidance * safetyFraction
  : undefined;
const measuredTwoRevisionsWithinRecommendedRepo = Number.isFinite(measuredRevisionBytes)
  ? measuredRevisionBytes * 2 <= recommendedRepoBytes
  : undefined;
const measurementConsistent = !measured.complete || (
  measuredMutations >= writer48.partCount
  && measuredSeconds >= Math.max(0, measuredMutations - 1) * spacingMs / 1000
);
const releaseStatus = !measured.complete ? "measurement-required" : !measurementConsistent ? "measurement-invalid" : "classified";
const releaseClassification = releaseStatus !== "classified"
  ? null
  : measuredWithinSafetyBudget && measuredTwoRevisionsWithinRecommendedRepo
    ? "operational-pass"
    : "technical-pass-operational-limited";

console.table(rows.map(row => ({
  "part MiB": row.partMiB,
  parts: row.partCount,
  mutations: row.mutations,
  "% hourly": (row.hourlyGuidanceFraction * 100).toFixed(1),
  "<=70% budget": row.withinSafetyBudget,
  "paced sec": row.minimumPacedSeconds.toFixed(0),
  "1 rev GiB": row.revisionGiB.toFixed(3),
  "2 rev GiB": row.twoRevisionGiB.toFixed(3),
  "3 rev GiB": row.threeRevisionGiB.toFixed(3),
  "2 rev <=10GiB": row.twoRevisionsWithinRecommendedRepo,
  "orphan GiB": row.orphanGiB.toFixed(3),
})));

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  logicalBytes,
  spacingMs,
  hourlyGuidance,
  safetyFraction,
  recommendedRepoBytes,
  measured,
  measuredWithinSafetyBudget,
  measuredTwoRevisionsWithinRecommendedRepo,
  measurementConsistent,
  modelClassification,
  releaseStatus,
  releaseClassification,
  rows,
}, null, 2));
