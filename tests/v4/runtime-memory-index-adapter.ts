/** Isolated Obsidian DataAdapter fixture for the Runtime's private Index and WAL.
 * Real Sync requires stable adapter ownership, even in a simulated GitHub test.
 */
export function createRuntimeMemoryIndexAdapter() {
  const files = new Map<string, string>()
  const directories = new Set<string>()
  return {
    async read(path: string) {
      const value = files.get(path)
      if (value === undefined) throw Error("Missing fixture file: " + path)
      return value
    },
    async write(path: string, value: string) { files.set(path, value) },
    async exists(path: string) { return files.has(path) || directories.has(path) },
    async mkdir(path: string) { directories.add(path) },
  }
}
