// TEST ONLY: never publish or copy this bundle into any non-disposable Vault.
// Same source and normal native requestUrl path, with an optional test-only hook.
import assert from "node:assert/strict";
import {readFile,mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import esbuild from "esbuild";
import builtins from "builtin-modules";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const out=path.join(root,".tmp","d501-android-transport-test","main.js");
const target=path.join(root,"src","lib","github-api.ts");
const original=await readFile(target,"utf8");
const anchor="response = await requestUrl(options);";
assert.equal(original.split(anchor).length,2,"Expected exact requestUrl call");
const instrumented=original.replace(anchor,`const nativeTransportTestHook = (globalThis as any).__obsidianD501NativeRequest;
          response = typeof nativeTransportTestHook === "function"
            ? await nativeTransportTestHook(requestUrl, options)
            : await requestUrl(options);`);
let loaded=0;
await mkdir(path.dirname(out),{recursive:true});
await esbuild.build({
 absWorkingDir:root,entryPoints:["src/main.ts"],bundle:true,format:"cjs",target:"es2018",
 minify:true,treeShaking:true,sourcemap:false,outfile:out,
 banner:{js:"/* TEST ONLY D501 native transport qualification — DO NOT RELEASE */"},
 external:["obsidian","electron","@codemirror/autocomplete","@codemirror/collab","@codemirror/commands","@codemirror/language","@codemirror/lint","@codemirror/search","@codemirror/state","@codemirror/view","@lezer/common","@lezer/highlight","@lezer/lr","node:*",...builtins],
 plugins:[{name:"d501-only-request-url-test-hook",setup(build){
  build.onLoad({filter:/github-api\.ts$/u},args=>{
   if(path.resolve(args.path)!==target)return undefined;
   loaded++;return {contents:instrumented,loader:"ts",resolveDir:path.dirname(target)};
  });
 }}]
});
assert.equal(loaded,1);
assert.ok((await readFile(out,"utf8")).includes("__obsidianD501NativeRequest"));
console.log("D501 isolated instrumented bundle built (production main.js untouched)");
