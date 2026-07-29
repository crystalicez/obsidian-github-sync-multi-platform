import { modelV4LargeFileRevision } from "./v4-phase0-models.mjs";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const logicalBytes = Number(process.env.LOGICAL_BYTES ?? 5 * GiB);
const spacingMs = Number(process.env.GITHUB_MUTATION_SPACING_MS ?? 1_000);
const hourlyGuidance = Number(process.env.GITHUB_CONTENT_HOURLY_GUIDANCE ?? 500);
const safetyFraction = Number(process.env.GITHUB_CONTENT_SAFETY_FRACTION ?? 0.70);
const recommendedRepoBytes = Number(process.env.GITHUB_RECOMMENDED_REPO_BYTES ?? 10 * GiB);

const rows = [48, 32, 16].map(partMiB => {
  const model = modelV4LargeFileRevision(logicalBytes, partMiB * MiB, { mutationSpacingMs: spacingMs });
  return {
    partMiB,
    partCount: model.partCount,
    mutations: model.contentMutations,
    hourlyGuidanceFraction: model.contentMutations / hourlyGuidance,
    withinSafetyBudget: model.contentMutations <= hourlyGuidance * safetyFraction,
    minimumPacedSeconds: model.minimumPacedMutationMs / 1000,
    revisionGiB: model.estimatedRepositoryBytesPerRevision / GiB,
    twoRevisionGiB: (model.estimatedRepositoryBytesPerRevision * 2) / GiB,
    threeRevisionGiB: (model.estimatedRepositoryBytesPerRevision * 3) / GiB,
    twoRevisionsWithinRecommendedRepo: model.estimatedRepositoryBytesPerRevision * 2 <= recommendedRepoBytes,
  };
});

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
})));

console.log(JSON.stringify({ logicalBytes, spacingMs, hourlyGuidance, safetyFraction, recommendedRepoBytes, rows }, null, 2));
