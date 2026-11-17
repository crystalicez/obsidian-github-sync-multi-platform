// Test-only TypeScript augmentation for the esbuild-alias Obsidian runtime stub.
// The production plugin continues to typecheck against the real Obsidian SDK.
import "obsidian";

declare module "obsidian" {
  function setRequestUrlHandler(handler: ((options: unknown) => Promise<unknown>) | null): void;
}
