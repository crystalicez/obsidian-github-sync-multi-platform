import { utf8ToBytes } from "../bytes"

/** Git SHA-1 object ID of "blob <length>\\0" + bytes, streamed without copying payload.
 * This only authenticates Git object identity; V4 still requires AES-GCM and SHA-256.
 */
class Sha1 {
  private readonly h = new Uint32Array([0x67452301,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0])
  private readonly block = new Uint8Array(64)
  private readonly w = new Uint32Array(80)
  private used = 0
  private length = 0
  private done = false

  update(data: Uint8Array): void {
    if (this.done) throw new Error("Git SHA-1 finalized.")
    if (!Number.isSafeInteger(this.length + data.length)) throw new RangeError("Git blob too large.")
    this.length += data.length
    let i = 0
    if (this.used) {
      const n = Math.min(64 - this.used, data.length)
      this.block.set(data.subarray(0,n), this.used)
      this.used += n
      i += n
      if (this.used === 64) { this.compress(this.block); this.used = 0 }
    }
    while (i + 64 <= data.length) { this.compress(data,i); i += 64 }
    if (i < data.length) { this.block.set(data.subarray(i)); this.used = data.length - i }
  }
  private static rol(x: number, n: number): number { return (x << n) | (x >>> (32-n)) }
  private compress(bytes: Uint8Array, pos=0): void {
    const w=this.w
    for(let i=0;i<16;i++) {
      const j=pos+i*4
      w[i]=((bytes[j]!<<24)|(bytes[j+1]!<<16)|(bytes[j+2]!<<8)|bytes[j+3]!)>>>0
    }
    for(let i=16;i<80;i++) w[i]=Sha1.rol(w[i-3]!^w[i-8]!^w[i-14]!^w[i-16]!,1)>>>0
    let a=this.h[0]!,b=this.h[1]!,c=this.h[2]!,d=this.h[3]!,e=this.h[4]!
    for(let i=0;i<80;i++) {
      let f:number,k:number
      if(i<20){f=(b&c)|(~b&d);k=0x5a827999}
      else if(i<40){f=b^c^d;k=0x6ed9eba1}
      else if(i<60){f=(b&c)|(b&d)|(c&d);k=0x8f1bbcdc}
      else{f=b^c^d;k=0xca62c1d6}
      const t=(Sha1.rol(a,5)+f+e+k+w[i]!)>>>0
      e=d;d=c;c=Sha1.rol(b,30)>>>0;b=a;a=t
    }
    this.h[0]=(this.h[0]!+a)>>>0
    this.h[1]=(this.h[1]!+b)>>>0
    this.h[2]=(this.h[2]!+c)>>>0
    this.h[3]=(this.h[3]!+d)>>>0
    this.h[4]=(this.h[4]!+e)>>>0
  }
  finish(): string {
    if(this.done) throw new Error("Git SHA-1 finalized.")
    this.done=true
    const bits=this.length*8
    this.block[this.used++]=0x80
    if(this.used>56){this.block.fill(0,this.used);this.compress(this.block);this.used=0}
    this.block.fill(0,this.used,56)
    const hi=Math.floor(bits/0x1_0000_0000),lo=bits>>>0
    this.block[56]=hi>>>24;this.block[57]=hi>>>16;this.block[58]=hi>>>8;this.block[59]=hi
    this.block[60]=lo>>>24;this.block[61]=lo>>>16;this.block[62]=lo>>>8;this.block[63]=lo
    this.compress(this.block)
    return Array.from(this.h,x=>x.toString(16).padStart(8,"0")).join("")
  }
}

export function computeV4GitBlobSha1(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Git blob must be bytes.")
  const sha=new Sha1()
  sha.update(utf8ToBytes(`blob ${bytes.byteLength}\0`))
  sha.update(bytes)
  return sha.finish()
}
export function assertV4GitBlobIdentity(bytes: Uint8Array, expectedSha: string): void {
  if (!/^[0-9a-f]{40}$/u.test(expectedSha) || computeV4GitBlobSha1(bytes)!==expectedSha) {
    throw new Error("Re-encryption immutable Git blob identity mismatch.")
  }
}
