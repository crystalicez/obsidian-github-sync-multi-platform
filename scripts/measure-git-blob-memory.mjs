const MiB = 1024 ** 2;
const sizes = (process.env.PAYLOAD_MIB ?? "16,32,48").split(",").map(Number);

function snapshot(label) {
  const m = process.memoryUsage();
  return { label, rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
}

function mib(bytes) { return Number((bytes / MiB).toFixed(1)); }

for (const sizeMiB of sizes) {
  global.gc?.();
  const baseline = snapshot("baseline");
  const raw = new Uint8Array(sizeMiB * MiB);
  const afterRaw = snapshot("raw");
  const ciphertext = new Uint8Array(raw.byteLength + 16);
  ciphertext.set(raw);
  const afterCipher = snapshot("ciphertext");
  const base64 = Buffer.from(ciphertext).toString("base64");
  const afterBase64 = snapshot("base64");
  const json = JSON.stringify({ content: base64, encoding: "base64" });
  const afterJson = snapshot("json");
  const samples = [baseline, afterRaw, afterCipher, afterBase64, afterJson];
  const peakRss = Math.max(...samples.map(x => x.rss));
  const peakHeap = Math.max(...samples.map(x => x.heapUsed));
  console.log(JSON.stringify({
    sizeMiB,
    base64Length: base64.length,
    jsonLength: json.length,
    peakRssDeltaMiB: mib(peakRss - baseline.rss),
    peakHeapDeltaMiB: mib(peakHeap - baseline.heapUsed),
    samples: samples.map(x => ({ label: x.label, rssMiB: mib(x.rss), heapUsedMiB: mib(x.heapUsed), externalMiB: mib(x.external), arrayBuffersMiB: mib(x.arrayBuffers) })),
  }));
  void json;
}
