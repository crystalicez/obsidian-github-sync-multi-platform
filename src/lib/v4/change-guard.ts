export interface V4ChangeGuardInput {
  thresholdPercent: number;
  changedFiles: number;
  baseFiles: number;
  localFiles: number;
  remoteFiles: number;
}

export interface V4ChangeGuardResult {
  blocked: boolean;
  changePercent: number;
  thresholdPercent: number;
}

export function evaluateV4ChangeGuard(input: V4ChangeGuardInput): V4ChangeGuardResult {
  const thresholdPercent = Math.max(0, Math.min(100, input.thresholdPercent));
  const denominator = Math.max(1, input.baseFiles, input.localFiles, input.remoteFiles);
  const changePercent = Math.min(100, Math.round((Math.max(0, input.changedFiles) / denominator) * 10_000) / 100);
  return {
    blocked: thresholdPercent > 0 && changePercent > thresholdPercent,
    changePercent,
    thresholdPercent,
  };
}
