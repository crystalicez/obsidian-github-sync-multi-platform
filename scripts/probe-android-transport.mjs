// Read-only capabilities probe, exact disposable Android Vault.
import assert from "node:assert/strict";
const port=Number(process.argv.find(x=>x.startsWith("--port="))?.slice(7));
assert.ok(Number.isInteger(port)&&port>1024&&port<=65535);
const pages=(await(await fetch("http://127.0.0.1:"+port+"/json/list",{signal:AbortSignal.timeout(5000)})).json()).filter(x=>x.type==="page"&&x.url==="http://localhost/"&&x.webSocketDebuggerUrl);
assert.equal(pages.length,1);
const ws=new WebSocket(pages[0].webSocketDebuggerUrl);
try{
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 const expression=`(()=>{const a=globalThis.app;const v=a?.vault;const adapter=v?.adapter;const base=String(adapter?.getBasePath?.()??adapter?.basePath??adapter?.getFullPath?.("")??"").replace(/^file:\\/\\//u,"").replace(/\\/$/u,"");const correct=v?.getName()==="ObsidianSync-D496-Disposable"&&["/storage/emulated/0/Documents/ObsidianSync-D496-Disposable","/sdcard/Documents/ObsidianSync-D496-Disposable"].includes(base);if(!correct)return{correct};const p=a.plugins.plugins["encrypted-github-sync-multi-platform"];let o;try{o=globalThis.require?.("obsidian")}catch{}const d=o&&Object.getOwnPropertyDescriptor(o,"requestUrl");return{correct,loaded:!!p?.v4Runtime,configured:!!(p?.settings?.githubOwner||p?.settings?.githubRepo||p?.settings?.githubToken||p?.settings?.encryptionPassphrase),files:v.getFiles().map(f=>f.path).sort(),requireType:typeof globalThis.require,requestUrlType:typeof o?.requestUrl,requestUrlWritable:d?.writable,requestUrlConfigurable:d?.configurable,hasGetter:!!d?.get,capacitor:!!globalThis.Capacitor,nativePromiseType:typeof globalThis.Capacitor?.nativePromise,nativePromiseWritable:Object.getOwnPropertyDescriptor(globalThis.Capacitor??{},'nativePromise')?.writable,httpRequestType:typeof globalThis.Capacitor?.Plugins?.CapacitorHttp?.request,httpRequestWritable:Object.getOwnPropertyDescriptor(globalThis.Capacitor?.Plugins?.CapacitorHttp??{},'request')?.writable,pluginNames:Object.keys(globalThis.Capacitor?.Plugins??{}).filter(k=>/http|request/i.test(k))};})()`;
 const result=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error("Probe timed out")),10000);ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.id===1){clearTimeout(t);resolve(r.result?.result?.value);}};ws.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression,returnByValue:true,awaitPromise:true}}));});
 assert.ok(result?.correct&&result.loaded&&!result.configured);
 console.log(JSON.stringify(result));
}finally{ws.close();}
