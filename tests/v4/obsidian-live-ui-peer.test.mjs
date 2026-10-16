import assert from "node:assert/strict";
import test from "node:test";
import {assertSecondVaultRestore} from "../../scripts/obsidian-live-ui-peer.mjs";

const expected="# Synthetic remote UI E2E\n\nSecond revision from Obsidian.\n";
test("second-device acceptance rejects incomplete, failed, and wrong decryption",()=>{
 assert.throws(()=>assertSecondVaultRestore(null,expected),/restore|status/iu);
 assert.throws(()=>assertSecondVaultRestore({status:"failed",content:expected},expected),/restore|status/iu);
 assert.throws(()=>assertSecondVaultRestore({status:"success",filename:"UI-smoke.md",content:"corrupted"},expected),/mismatch|content/iu);
 assert.throws(()=>assertSecondVaultRestore({status:"success",content:expected,filename:"another.md"},expected),/path|filename/iu);
});
test("second-device acceptance permits exact decrypted synthetic note only",()=>{
 assert.doesNotThrow(()=>assertSecondVaultRestore({status:"success",filename:"UI-smoke.md",content:expected},expected));
});
