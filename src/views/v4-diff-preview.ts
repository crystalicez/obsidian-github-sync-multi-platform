export class V4PreviewObjectUrlBag {
  private readonly urls = new Set<string>()

  track(url: string): string {
    this.urls.add(url)
    return url
  }

  create(bytes: Uint8Array, mime: string): string {
    return this.track(URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })))
  }

  clear(): void {
    for (const url of this.urls) URL.revokeObjectURL(url)
    this.urls.clear()
  }
}

export function renderV4TextPreview(container: HTMLElement, label: string, bytes?: Uint8Array): void {
  const section = container.createDiv({ cls: "github-sync-conflicts__side" })
  section.createEl("strong", { text: label })
  section.createEl("pre", {
    text: bytes ? new TextDecoder("utf-8").decode(bytes) : "(absent)",
    cls: "github-sync-conflicts__text-preview",
  })
}

export function renderV4BinaryMetadata(container: HTMLElement, label: string, input: {
  exists: boolean
  path?: string
  size?: number
  mtime?: number
  hash?: string
}): void {
  const section = container.createDiv({ cls: "github-sync-conflicts__side" })
  section.createEl("strong", { text: label })
  if (!input.exists) {
    section.createDiv({ text: "Absent", cls: "github-sync-conflicts__muted" })
    return
  }
  if (input.path) section.createDiv({ text: input.path })
  if (input.size !== undefined) section.createDiv({ text: `${input.size.toLocaleString()} bytes`, cls: "github-sync-conflicts__muted" })
  if (input.mtime !== undefined) section.createDiv({ text: new Date(input.mtime).toLocaleString(), cls: "github-sync-conflicts__muted" })
  if (input.hash) section.createDiv({ text: input.hash.slice(0, 12), cls: "github-sync-conflicts__hash" })
}
