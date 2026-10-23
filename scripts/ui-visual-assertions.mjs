import assert from "node:assert/strict";

// These checks protect the screenshot gate from counting a perfectly valid,
// completely unrelated/blank PNG while the actual UI sits outside the frame.
export function visibleIntersection(rect, viewport) {
  assert.ok(rect && viewport, "Visual target bounds and viewport are required");
  const numbers=[rect.x,rect.y,rect.width,rect.height,viewport.width,viewport.height];
  assert.ok(numbers.every(Number.isFinite), "Visual bounds must contain finite coordinates");
  assert.ok(rect.width>0 && rect.height>0 && viewport.width>0 && viewport.height>0, "Visual target/viewport must have positive dimensions");
  const x=Math.max(0,rect.x),y=Math.max(0,rect.y);
  const right=Math.min(viewport.width,rect.x+rect.width);
  const bottom=Math.min(viewport.height,rect.y+rect.height);
  assert.ok(right-x >= 24 && bottom-y >= 8,
    `Target is outside screenshot viewport (rect=${JSON.stringify(rect)}, viewport=${JSON.stringify(viewport)})`);
  return {x,y,width:right-x,height:bottom-y,scale:1};
}

export function verifyPngBytes(bytes, {minWidth=80,minHeight=80}={}) {
  assert.ok(Buffer.isBuffer(bytes), "Screenshot must be a Buffer");
  assert.ok(bytes.byteLength>=33,"Screenshot PNG was empty/truncated");
  assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a","Screenshot is not a valid PNG");
  assert.equal(bytes.toString("ascii",12,16),"IHDR","PNG is missing IHDR");
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  assert.ok(width>=minWidth && height>=minHeight,
    `Screenshot too small (${width}x${height}); possible empty/cropped output`);
  return {width,height};
}
