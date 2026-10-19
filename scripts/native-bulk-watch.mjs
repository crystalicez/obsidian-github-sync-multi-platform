export async function watchNativeBulkSync({ poll, sleep, now, timeoutMs, onProgress = () => {} }) {
  const deadline = now() + timeoutMs;
  let nextReport = now() + 30_000;
  let last = null;
  while (now() < deadline) {
    last = await poll();
    if (last.done) return last;
    if (now() >= nextReport) {
      onProgress(last);
      nextReport = now() + 30_000;
    }
    await sleep(Math.min(2_000, Math.max(0, deadline - now())));
  }
  throw new Error("Native bulk Sync exceeded deadline. Last progress: " + JSON.stringify(last));
}
