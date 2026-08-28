const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const VERSION_20 = 20;
const DOS_DATE_1980_01_01 = 0x0021;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC_TABLE[n] = value >>> 0;
}

export function crc32(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function checkedName(name) {
  if (typeof name !== "string" || name === "" || name.includes("\\") || name.startsWith("/") || name.includes("\0")) {
    throw new Error(`Invalid ZIP entry name: ${name}`);
  }
  const encoded = Buffer.from(name, "utf8");
  if (encoded.length > MAX_U16) throw new Error(`ZIP entry name is too long: ${name}`);
  return encoded;
}

function checkedBytes(bytes, name) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (value.length > MAX_U32) throw new Error(`ZIP entry is too large for ZIP32: ${name}`);
  return value;
}

export function createStoredZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_U16) {
    throw new Error("ZIP requires 1..65535 entries");
  }

  const seen = new Set();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = entry?.name;
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    seen.add(name);

    const nameBytes = checkedName(name);
    const data = checkedBytes(entry?.bytes ?? Buffer.alloc(0), name);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(VERSION_20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // store, no compression
    local.writeUInt16LE(0, 10); // fixed DOS time 00:00:00
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    central.writeUInt16LE(VERSION_20, 4); // host OS 0 + ZIP version 2.0
    central.writeUInt16LE(VERSION_20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);

    localOffset += local.length + nameBytes.length + data.length;
    if (localOffset > MAX_U32) throw new Error("ZIP local data exceeds ZIP32 limits");
  }

  const centralBytes = Buffer.concat(centralParts);
  if (centralBytes.length > MAX_U32 || localOffset + centralBytes.length > MAX_U32) {
    throw new Error("ZIP central directory exceeds ZIP32 limits");
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBytes, end]);
}
