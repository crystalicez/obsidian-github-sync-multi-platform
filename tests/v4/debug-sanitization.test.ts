import assert from "node:assert/strict"
import test from "node:test"

import { sanitizeDebugSettings, syncConsoleLog } from "../../src/lib/debug"

test("console logging preserves an allowlisted nested error cause chain without serializing arbitrary fields", () => {
  const transport = Object.assign(new Error("socket reset"), {
    status: 503,
    Authorization: "Bearer must-not-leak",
    request: { headers: { Authorization: "Bearer must-not-leak" } },
  })
  const mutation = Object.assign(new Error("Git ref mutation outcome is unknown"), {
    name: "V4GitMutationOutcomeUnknownError",
    retryClass: "reachable-ref",
    cause: transport,
  })
  const publication = Object.assign(new Error("publication raced"), {
    name: "V4PublicationRaceError",
    code: "V4_PUBLICATION_RACE",
    cause: mutation,
  })

  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    syncConsoleLog({ consoleLoggingEnabled: true }, "warn", "V4 sync failed", { error: publication })
  } finally {
    console.warn = originalWarn
  }

  assert.equal(warnings.length, 1)
  const details = warnings[0][2] as { error: Record<string, unknown> }
  assert.deepEqual(details.error, {
    name: "V4PublicationRaceError",
    message: "publication raced",
    code: "V4_PUBLICATION_RACE",
    cause: {
      name: "V4GitMutationOutcomeUnknownError",
      message: "Git ref mutation outcome is unknown",
      retryClass: "reachable-ref",
      cause: {
        name: "Error",
        message: "socket reset",
        status: 503,
      },
    },
  })
  assert.equal(JSON.stringify(details).includes("must-not-leak"), false)
})

test("console logging and debug settings redact security-sensitive keys case-insensitively", () => {
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    syncConsoleLog({ consoleLoggingEnabled: true }, "warn", "redaction", {
      headers: {
        Authorization: "Bearer secret-token",
        "proxy-authorization": "Basic secret-proxy",
        "X-Api-Key": "secret-api-key",
      },
      nested: { token: "secret-token", harmless: "ok" },
    })
  } finally {
    console.warn = originalWarn
  }

  const details = warnings[0][2] as Record<string, unknown>
  assert.equal(JSON.stringify(details).includes("secret-"), false)
  assert.deepEqual(details, {
    headers: {
      Authorization: "***HIDDEN***",
      "proxy-authorization": "***HIDDEN***",
      "X-Api-Key": "***HIDDEN***",
    },
    nested: { token: "***HIDDEN***", harmless: "ok" },
  })

  assert.deepEqual(sanitizeDebugSettings({
    githubToken: "github-secret",
    encryptionPassphrase: "pass-secret",
    harmless: "ok",
  }), {
    githubToken: "***HIDDEN***",
    encryptionPassphrase: "***HIDDEN***",
    harmless: "ok",
  })
})
