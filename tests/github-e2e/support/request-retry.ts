/** GitHub E2E transport retry policy. This is not used by the production GitHub client. */
export type GitHubE2EFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchGitHubE2EWithRetry(
  url: string,
  init: RequestInit,
  request: GitHubE2EFetch = fetch,
  attempts = 3,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const readOnly = method === "GET" || method === "HEAD";
  let response: Response | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    response = await request(url, init);
    const retryableStatus = response.status === 429 || response.status >= 500;
    if (!readOnly || !retryableStatus || attempt === attempts) return response;
    await response.arrayBuffer().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, attempt * 500));
  }
  throw new Error("GitHub E2E request retry budget is empty.");
}
