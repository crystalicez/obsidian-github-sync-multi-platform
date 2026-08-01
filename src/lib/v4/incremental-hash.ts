const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

function toHex(bytes: Uint8Array): string {
  let value = ""
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0")
  return value
}

export interface V4IncrementalHash {
  update(bytes: Uint8Array): void
  digest(): Uint8Array
  digestHex(): string
}

class V4IncrementalSha256 implements V4IncrementalHash {
  private readonly state = new Uint32Array(SHA256_INITIAL)
  private readonly block = new Uint8Array(64)
  private readonly words = new Uint32Array(64)
  private blockLength = 0
  private totalBytes = 0
  private finalized = false
  private result?: Uint8Array

  update(bytes: Uint8Array): void {
    if (this.finalized) throw new Error("V4 incremental SHA-256 is already finalized.")
    if (!(bytes instanceof Uint8Array)) throw new TypeError("SHA-256 update requires Uint8Array.")
    if (bytes.byteLength === 0) return
    if (!Number.isSafeInteger(this.totalBytes + bytes.byteLength)) throw new RangeError("SHA-256 input is too large.")
    this.totalBytes += bytes.byteLength
    let offset = 0
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, bytes.byteLength)
      this.block.set(bytes.subarray(0, take), this.blockLength)
      this.blockLength += take
      offset += take
      if (this.blockLength === 64) {
        this.compress(this.block)
        this.blockLength = 0
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.compress(bytes, offset)
      offset += 64
    }
    if (offset < bytes.byteLength) {
      this.block.set(bytes.subarray(offset), 0)
      this.blockLength = bytes.byteLength - offset
    }
  }

  digest(): Uint8Array {
    if (this.result) return new Uint8Array(this.result)
    if (!this.finalized) this.finalize()
    return new Uint8Array(this.result!)
  }

  digestHex(): string {
    return toHex(this.digest())
  }

  private finalize(): void {
    this.finalized = true
    const bitLength = this.totalBytes * 8
    this.block[this.blockLength++] = 0x80
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength)
      this.compress(this.block)
      this.blockLength = 0
    }
    this.block.fill(0, this.blockLength, 56)
    const high = Math.floor(bitLength / 0x1_0000_0000)
    const low = bitLength >>> 0
    this.block[56] = high >>> 24
    this.block[57] = high >>> 16
    this.block[58] = high >>> 8
    this.block[59] = high
    this.block[60] = low >>> 24
    this.block[61] = low >>> 16
    this.block[62] = low >>> 8
    this.block[63] = low
    this.compress(this.block)

    const output = new Uint8Array(32)
    for (let i = 0; i < this.state.length; i++) {
      const value = this.state[i]
      output[i * 4] = value >>> 24
      output[i * 4 + 1] = value >>> 16
      output[i * 4 + 2] = value >>> 8
      output[i * 4 + 3] = value
    }
    this.result = output
  }

  private compress(bytes: Uint8Array, baseOffset = 0): void {
    const w = this.words
    for (let i = 0; i < 16; i++) {
      const offset = baseOffset + i * 4
      w[i] = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const v15 = w[i - 15]
      const v2 = w[i - 2]
      const s0 = rotr(v15, 7) ^ rotr(v15, 18) ^ (v15 >>> 3)
      const s1 = rotr(v2, 17) ^ rotr(v2, 19) ^ (v2 >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = this.state[0]
    let b = this.state[1]
    let c = this.state[2]
    let d = this.state[3]
    let e = this.state[4]
    let f = this.state[5]
    let g = this.state[6]
    let h = this.state[7]

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + choice + SHA256_K[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    this.state[0] = (this.state[0] + a) >>> 0
    this.state[1] = (this.state[1] + b) >>> 0
    this.state[2] = (this.state[2] + c) >>> 0
    this.state[3] = (this.state[3] + d) >>> 0
    this.state[4] = (this.state[4] + e) >>> 0
    this.state[5] = (this.state[5] + f) >>> 0
    this.state[6] = (this.state[6] + g) >>> 0
    this.state[7] = (this.state[7] + h) >>> 0
  }
}

export function createV4IncrementalSha256(): V4IncrementalHash {
  return new V4IncrementalSha256()
}

export async function sha256V4ChunksHex(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<string> {
  const hash = createV4IncrementalSha256()
  for await (const chunk of chunks) {
    if (signal?.aborted) throw signal.reason ?? new Error("V4 hashing aborted.")
    hash.update(chunk)
  }
  return hash.digestHex()
}
