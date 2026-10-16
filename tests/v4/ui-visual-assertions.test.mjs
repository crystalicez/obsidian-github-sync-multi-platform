import assert from "node:assert/strict";
import test from "node:test";
import { visibleIntersection, verifyPngBytes } from "../../scripts/ui-visual-assertions.mjs";

test("a UI that was pushed outside a narrow emulated viewport cannot count as screenshot evidence",()=>{
  assert.throws(()=>visibleIntersection({x:736,y:60,width:276,height:700},{width:375,height:760}),/outside screenshot viewport/u);
});
test("a visible Obsidian sidebar produces an exact in-viewport screenshot crop",()=>{
  assert.deepEqual(visibleIntersection({x:736,y:60,width:276,height:700},{width:1024,height:802}),
    {x:736,y:60,width:276,height:700,scale:1});
});
test("clipping to the window does not hide an offscreen target",()=>{
  assert.deepEqual(visibleIntersection({x:930,y:10,width:276,height:780},{width:1024,height:802}),
    {x:930,y:10,width:94,height:780,scale:1});
  assert.throws(()=>visibleIntersection({x:1009,y:50,width:180,height:200},{width:1024,height:802}),/outside screenshot viewport/u);
});
test("screenshots must have valid PNG headers and meaningful dimensions",()=>{
  const png=Buffer.alloc(45);
  Buffer.from("89504e470d0a1a0a","hex").copy(png);
  png.write("IHDR",12,"ascii");png.writeUInt32BE(300,16);png.writeUInt32BE(760,20);
  assert.deepEqual(verifyPngBytes(png),{width:300,height:760});
  assert.throws(()=>verifyPngBytes(Buffer.alloc(50)),/valid PNG/u);
  png.writeUInt32BE(1,16);
  assert.throws(()=>verifyPngBytes(png),/too small/u);
});
