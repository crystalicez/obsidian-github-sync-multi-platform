import { readReleaseMetadata, validateReleaseMetadata } from "./release-metadata.mjs";

const result = validateReleaseMetadata(await readReleaseMetadata(process.cwd()));
console.log(`Validated release metadata for ${result.pluginId} v${result.version}`);
