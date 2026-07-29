export async function boundedMap<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be a positive integer")
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  let firstError: unknown
  let failed = false
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await mapper(items[index], index)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
        return
      }
    }
  })
  await Promise.all(workers)
  if (failed) throw firstError
  return results
}
