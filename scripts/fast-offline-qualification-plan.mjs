import { excludeSelectedTestFile, selectTests, shardSelectedTests } from "./test-discovery.mjs";

// Offline test subprocesses do not need live-service credentials. Strip
// well-known provider namespaces and credential-bearing names regardless of
// case (important on Windows), without modifying the parent's environment.
// This is defense in depth, not a sandbox for untrusted test code.
const SENSITIVE_OFFLINE_FAST_ENV = /^(?:GITHUB_|GH_|AWS_|AZURE_|GOOGLE_|GCP_|GCLOUD_|SSH_|NPM_CONFIG_|NODE_(?:OPTIONS|PATH|V8_COVERAGE)|GIT_(?:ASKPASS|SSH_COMMAND|CONFIG_))|(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH_SOCK)/u;

export function sanitizeOfflineFastChildEnvironment(parent) {
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
    throw new TypeError("Offline Fast child environment must be an object.");
  }
  const child = {};
  for (const [name, value] of Object.entries(parent)) {
    if (typeof value !== "string" || SENSITIVE_OFFLINE_FAST_ENV.test(name.toUpperCase())) {
      continue;
    }
    Object.defineProperty(child, name, {
      value, enumerable: true, writable: true, configurable: true,
    });
  }
  return child;
}

export const HEAVY_FAST_TEST_FILE = "tests/v4/reencryption-destination-exact-commit.test.ts";
export const OFFLINE_FAST_SHARDS = 12;

// A new D-number outside the explicitly verified ranges must update this plan
// before offline qualification can claim full coverage.
export const HEAVY_TEST_COHORTS = Object.freeze([
  { label: "D0-199", pattern: String.raw`^D(?:\d{1,2}|1\d\d)(?!\d)`, matches: /^D(?:\d{1,2}|1\d\d)(?!\d)/u },
  { label: "D200-229", pattern: String.raw`^D2[0-2]\d(?!\d)`, matches: /^D2[0-2]\d(?!\d)/u },
  { label: "D230", pattern: String.raw`^D230(?!\d)`, matches: /^D230(?!\d)/u },
  { label: "D231", pattern: String.raw`^D231(?!\d)`, matches: /^D231(?!\d)/u },
  { label: "D232", pattern: String.raw`^D232(?!\d)`, matches: /^D232(?!\d)/u },
  { label: "D233", pattern: String.raw`^D233(?!\d)`, matches: /^D233(?!\d)/u },
  { label: "D234", pattern: String.raw`^D234(?!\d)`, matches: /^D234(?!\d)/u },
  { label: "D235", pattern: String.raw`^D235(?!\d)`, matches: /^D235(?!\d)/u },
  { label: "D236", pattern: String.raw`^D236(?!\d)`, matches: /^D236(?!\d)/u },
  { label: "D238", pattern: String.raw`^D238(?!\d)`, matches: /^D238(?!\d)/u },
  { label: "D239", pattern: String.raw`^D239(?!\d)`, matches: /^D239(?!\d)/u },
  { label: "D240-249", pattern: String.raw`^D24\d(?!\d)`, matches: /^D24\d(?!\d)/u },
  { label: "D250-299", pattern: String.raw`^D2[5-9]\d(?!\d)`, matches: /^D2[5-9]\d(?!\d)/u },
  // Explicit new D368 Settings Cutover regression. Other D3xx cases still
  // require their own reviewed cohort rather than being silently selected.
  { label: "D368", pattern: String.raw`^D368(?!\d)`, matches: /^D368(?!\d)/u },
]);

export function collectHeavyFastTestNames(source) {
  if (typeof source !== "string") throw new TypeError("Test source must be text.");
  // Require direct, literal, top-level Node test declarations. No test.skip,
  // test.todo, aliases or generated names may bypass exact coverage checks.
  const declarations = [...source.matchAll(/^[ \t]*test(?:\.[A-Za-z]+)?\s*\(/gmu)];
  const literal = [...source.matchAll(/^[ \t]*test\(\s*"([^"\r\n]+)"\s*,/gmu)];
  if (!declarations.length || declarations.length !== literal.length) {
    throw new Error("Heavy Fast test declarations changed or became nonliteral; coverage unknown.");
  }
  const names = literal.map(entry => entry[1]);
  if (new Set(names).size !== names.length) {
    throw new Error("Duplicate heavy Fast test name; cannot prove case coverage.");
  }
  for (const name of names) {
    const matches = HEAVY_TEST_COHORTS.filter(cohort => cohort.matches.test(name));
    if (matches.length !== 1) {
      throw new Error("Unclassified or overlapping heavy Fast test case; update qualification ranges.");
    }
  }
  return names;
}

export function createOfflineFastQualificationPlan(discovered, heavySource, shardCount = OFFLINE_FAST_SHARDS) {
  const eligible = selectTests(discovered, { tier: "fast" });
  if (!eligible.length || new Set(eligible.map(item => item.path)).size !== eligible.length) {
    throw new Error("Fast test discovery is empty or contains duplicate paths.");
  }
  const ordinary = excludeSelectedTestFile(eligible, HEAVY_FAST_TEST_FILE);
  const names = collectHeavyFastTestNames(heavySource);
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > ordinary.length) {
    throw new RangeError("Invalid number of ordinary Fast shards.");
  }
  const shards = Array.from({ length: shardCount }, (_, index) => {
    const files = shardSelectedTests(ordinary, `${index + 1}/${shardCount}`);
    return Object.freeze({
      label: `files-${index + 1}-of-${shardCount}`,
      args: ["--tier=fast", `--exclude-file=${HEAVY_FAST_TEST_FILE}`, `--shard=${index + 1}/${shardCount}`],
      fileCount: files.length,
      files: files.map(item => item.path),
      expectedNames: null,
    });
  });
  const uniqueOrdinaryFiles = new Set(shards.flatMap(shard => shard.files));
  if (uniqueOrdinaryFiles.size !== ordinary.length
    || shards.reduce((total, shard) => total + shard.fileCount, 0) !== ordinary.length) {
    throw new Error("Fast shard plan lost or duplicated a test file.");
  }
  const cohorts = HEAVY_TEST_COHORTS.map(cohort => Object.freeze({
    label: cohort.label,
    args: ["--tier=fast", `--filter=${HEAVY_FAST_TEST_FILE}`, `--name-pattern=${cohort.pattern}`],
    fileCount: 1,
    files: [HEAVY_FAST_TEST_FILE],
    expectedNames: names.filter(name => cohort.matches.test(name)),
  }));
  if (cohorts.some(cohort => cohort.expectedNames.length === 0)
    || cohorts.reduce((count, cohort) => count + cohort.expectedNames.length, 0) !== names.length) {
    throw new Error("Heavy Fast cohort plan incomplete.");
  }
  return Object.freeze({ eligibleFiles: eligible.length, ordinaryFiles: ordinary.length,
    heavyCases: names.length, tasks: [...shards, ...cohorts] });
}

export function verifyOfflineFastTestOutput({ status, stdout, task }) {
  if (status !== 0 || typeof stdout !== "string") {
    throw new Error(`Offline Fast test task ${task.label} failed or has no output.`);
  }
  const fields = new Map();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/u.exec(line.trim());
    if (match) {
      if (fields.has(match[1])) throw new Error("Ambiguous duplicate Node test summary.");
      fields.set(match[1], Number(match[2]));
    }
  }
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    if (!Number.isSafeInteger(fields.get(key))) throw new Error("Incomplete Node test summary.");
  }
  if (fields.get("tests") < task.fileCount || fields.get("tests") !== fields.get("pass")
    || fields.get("fail") !== 0 || fields.get("cancelled") !== 0
    || fields.get("skipped") !== 0 || fields.get("todo") !== 0) {
    throw new Error(`Offline Fast task ${task.label} did not pass all selected cases.`);
  }
  if (task.expectedNames !== null) {
    // A regexp-only filter can accidentally match the file name and run every
    // test. Require the exact expected case set from the actual runner output.
    const names = stdout.split(/\r?\n/u)
      .map(line => /^✔ (.*?) \([\d.]+ms\)$/u.exec(line.trim())?.[1])
      .filter(name => name !== undefined);
    const actual = new Set(names);
    const expected = new Set(task.expectedNames);
    if (names.length !== task.expectedNames.length || actual.size !== expected.size
      || task.expectedNames.some(name => !actual.has(name))
      || fields.get("pass") !== task.expectedNames.length) {
      throw new Error(`Offline Fast task ${task.label} reported incomplete or unexpected test names.`);
    }
  }
  return fields.get("pass");
}
