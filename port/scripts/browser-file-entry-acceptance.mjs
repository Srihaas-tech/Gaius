#!/usr/bin/env node

// Real Chrome file:// acceptance for the portable, single-file artifact.  This
// intentionally drives the product UI through DOM/CDP input rather than
// mutating Minecraft state or using the diagnostic benchmark fixtures.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {basename, dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {analyzeTerrainPng, terrainVisualPass} from "../../tools/terrain-visual-metrics.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const profilePath = process.env.GAIUS_VERSION_PROFILE_PATH || "port/versions/26.2.json";
const profileId = basename(profilePath).replace(/\.json$/i, "");
const artifact = resolve(process.env.GAIUS_FILE_ARTIFACT || `port/web/dist/${profileId}/Gaius.html`);
const mode = String(process.env.GAIUS_FILE_MODE || "single").toLowerCase();
const output = resolve(process.env.GAIUS_FILE_OUTPUT || `artifacts/file-entry-${profileId}-${mode}.json`);
const timeoutMs = Number(process.env.GAIUS_FILE_TIMEOUT_MS || "300000");
const chromeBinary = process.env.GAIUS_CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const playerName = process.env.GAIUS_FILE_PLAYER || `GaiusFile${profileId.replace(/\W/g, "")}`;
const targetUrl = `file:///${artifact.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1:")}?fileAcceptance=${Date.now()}`;

async function fileIdentity(path) {
  const bytes = await readFile(path);
  return {bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 1; this.pending = new Map(); this.listeners = new Map(); }
  async open() {
    await new Promise((ok, bad) => { const o=()=>{clean();ok();}; const e=()=>{clean();bad(new Error("CDP websocket failed"));}; const clean=()=>{this.ws.removeEventListener("open",o);this.ws.removeEventListener("error",e);}; this.ws.addEventListener("open",o);this.ws.addEventListener("error",e); });
    this.ws.addEventListener("message", e => { const m=JSON.parse(String(e.data)); if (m.id != null) { const p=this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result || {}); } else for (const f of this.listeners.get(m.method)||[]) f(m.params||{}); });
    this.ws.addEventListener("close",()=>{ for (const p of this.pending.values()) p.reject(new Error("CDP closed")); this.pending.clear(); });
  }
  send(method, params={}) { const id=this.id++; return new Promise((resolve,reject)=>{this.pending.set(id,{method,resolve,reject});this.ws.send(JSON.stringify({id,method,params}));}); }
  on(method, fn) { this.listeners.set(method,[...(this.listeners.get(method)||[]),fn]); }
  close() { this.ws.close(); }
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function waitForExit(child, ms) {
  if (child.exitCode != null || child.signalCode != null) return true;
  return await new Promise(resolve => {
    const finish=value=>{clearTimeout(timer);child.removeListener("exit",exited);child.removeListener("close",exited);resolve(value);};
    const exited=()=>finish(true);
    const timer=setTimeout(()=>finish(false),ms);
    child.once("exit",exited);child.once("close",exited);
  });
}
async function removeChromeProfile(path) {
  try {
    // Crashpad can retain CrashpadMetrics-active.pma briefly after the browser
    // process exits on Windows. fs.rm's retry options cover that normal race.
    await rm(path,{recursive:true,force:true,maxRetries:20,retryDelay:250});
    try { await stat(path); return {removed:false,error:"profile still exists after rm"}; }
    catch (error) { if(error?.code==="ENOENT")return {removed:true,error:null}; throw error; }
  } catch (error) {
    return {removed:false,error:String(error?.stack||error)};
  }
}
async function waitJson(url, ms) { const end=Date.now()+ms; let last; while(Date.now()<end){try{const r=await fetch(url);if(r.ok)return r.json();last=new Error(`${r.status}`);}catch(e){last=e;}await sleep(100);}throw new Error(`timeout ${url}: ${last}`); }
async function evaluate(cdp, expression) { const r=await cdp.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.text||"Runtime.evaluate failed"); return r.result?.value; }
async function waitFor(cdp, expression, ms, label) { const end=Date.now()+ms; let last; while(Date.now()<end){try{if(await evaluate(cdp,expression))return;}catch(e){last=e;}await sleep(250);}throw new Error(`timeout waiting for ${label}${last?`: ${last.message}`:""}`); }
async function freePort(){const s=createServer();await new Promise((ok,bad)=>{s.once("error",bad);s.listen(0,"127.0.0.1",ok);});const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
async function clickAt(cdp,x,y){await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,button:"none"});await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});}
async function findWidget(cdp,label,ms=60000){const needle=String(label).toLowerCase();const end=Date.now()+ms;while(Date.now()<end){const v=await evaluate(cdp,`(()=>{const s=window.__gaiusMinecraftState||{};const ws=Array.isArray(s.screenWidgets)?s.screenWidgets:[];const n=${JSON.stringify(needle)};const w=ws.find(x=>x&&x.visible!==false&&x.active!==false&&String(x.text||'').trim().toLowerCase()===n)||ws.find(x=>x&&x.visible!==false&&x.active!==false&&String(x.text||'').toLowerCase().includes(n));const c=document.querySelector('canvas');const r=c&&c.getBoundingClientRect();const z=s.screenSize;if(!w||!r||!z||!z.width||!z.height)return null;return {text:String(w.text||''),x:r.left+(Number(w.x)+Number(w.width)/2)*r.width/Number(z.width),y:r.top+(Number(w.y)+Number(w.height)/2)*r.height/Number(z.height),screen:s.screen||null};})()`);if(v)return v;await sleep(250);}return null;}
async function clickWidget(cdp,label,ms=60000){const w=await findWidget(cdp,label,ms);if(!w)throw new Error(`visible widget not found: ${label}`);await clickAt(cdp,w.x,w.y);return w;}

async function captureSingleplayerTerrain(cdp) {
  const screenshotPath=output.replace(/\.json$/i,"")+"-terrain.png";
  const deadline=Date.now()+Math.min(timeoutMs,120000);
  const samples=[];
  let last=null;
  while(Date.now()<deadline){
    const state=await evaluate(cdp,`(()=>{const s=window.__gaiusMinecraftState||{};const events=Array.isArray(window.__gaiusMinecraftEvents)?window.__gaiusMinecraftEvents:[];const chunkEvents=events.filter(x=>x?.event==='client.handleLevelChunkWithLight');const chunkEventCount=chunkEvents.reduce((maximum,x)=>Math.max(maximum,Number(x?.count)||0),0);return {screen:s.screen||null,level:!!s.level,levelClass:s.level||null,loadedChunkCount:Number(s.loadedChunkCount)||0,player:s.player||null,chunkEventCount};})()`);
    if(state?.level&&state?.screen==null){
      const captured=await cdp.send("Page.captureScreenshot",{format:"png",fromSurface:true,captureBeyondViewport:false});
      const png=Buffer.from(captured.data||"","base64");
      try {
        const visual=analyzeTerrainPng(png);
        last={state,png,visual,ready:Number(state.loadedChunkCount)>0&&Number(state.chunkEventCount)>0&&terrainVisualPass(visual)};
        samples.push({at:new Date().toISOString(),loadedChunkCount:state.loadedChunkCount,chunkEventCount:state.chunkEventCount,visual:{terrainVisualPass:visual.terrainVisualPass,lowerLuminanceStdDev:visual.lowerLuminanceStdDev,lowerColorBuckets:visual.lowerColorBuckets,lowerEdgeDensity:visual.lowerEdgeDensity,lowerTexturedTileCount:visual.lowerTexturedTileCount}});
        if(last.ready)break;
      } catch(error) {
        last={state,png,visual:null,ready:false,visualError:String(error?.stack||error)};
      }
    }
    await sleep(1500);
  }
  if(!last?.png?.length)return {ready:false,screenshotPath,samples,error:"no in-world screenshot was captured"};
  await mkdir(dirname(screenshotPath),{recursive:true});
  await writeFile(screenshotPath,last.png);
  const identity={bytes:last.png.length,sha256:createHash("sha256").update(last.png).digest("hex")};
  return {ready:last.ready===true,screenshotPath,identity,loadedChunkCount:last.state?.loadedChunkCount||0,chunkEventCount:last.state?.chunkEventCount||0,player:last.state?.player||null,visual:last.visual,samples,visualError:last.visualError||null};
}

async function closeCdp(cdp, timeoutMilliseconds=2000) {
  if(!cdp)return true;
  try {
    const closed=new Promise(resolve=>cdp.ws.addEventListener("close",()=>resolve(true),{once:true}));
    cdp.close();
    return await Promise.race([closed,sleep(timeoutMilliseconds).then(()=>false)]);
  } catch { return false; }
}

function singleRuntimeGate(runMode,singleRuntime) {
  if(!["single","both"].includes(runMode))return true;
  return singleRuntime?.level===true
    &&singleRuntime?.wasm?.ready===true
    &&singleRuntime?.wasm?.disabled!==true
    &&singleRuntime?.storage==="ok"
    &&singleRuntime?.idb==="ok"
    &&singleRuntime?.terrain?.ready===true
    &&Number(singleRuntime?.terrain?.loadedChunkCount)>0
    &&Number(singleRuntime?.terrain?.chunkEventCount)>0
    &&terrainVisualPass(singleRuntime?.terrain?.visual);
}

function finalAcceptanceGate({runMode,singleRuntime,baseReady,cleanup,artifactIdentity}) {
  return baseReady===true
    &&singleRuntimeGate(runMode,singleRuntime)
    &&cleanup?.cdpClosed===true
    &&cleanup?.chromeExited===true
    &&cleanup?.profileRemoved===true
    &&artifactIdentity?.unchanged===true;
}

if(process.argv.includes("--static-self-test")){
  const terrain={available:true,nonBlackRatio:.5,luminanceStdDev:30,colorBuckets:100,centralLuminanceStdDev:20,centralColorBuckets:80,centralDominantColorRatio:.2,activeTileCount:12,lowerLuminanceStdDev:20,lowerColorBuckets:60,lowerEdgeDensity:.1,lowerTexturedTileCount:10,lowerTexturedRowCount:3,lowerTexturedColumnCount:4};
  const ready={level:true,wasm:{ready:true,disabled:false},storage:"ok",idb:"ok",terrain:{ready:true,loadedChunkCount:4,chunkEventCount:2,visual:terrain}};
  assert.equal(singleRuntimeGate("single",ready),true);
  assert.equal(singleRuntimeGate("single",{...ready,level:false}),false);
  assert.equal(singleRuntimeGate("single",{...ready,wasm:{ready:true,disabled:true}}),false);
  assert.equal(singleRuntimeGate("single",{...ready,storage:"failed"}),false);
  assert.equal(singleRuntimeGate("single",{...ready,idb:"unavailable"}),false);
  assert.equal(singleRuntimeGate("single",{...ready,terrain:{...ready.terrain,loadedChunkCount:0}}),false);
  assert.equal(singleRuntimeGate("single",{...ready,terrain:{...ready.terrain,chunkEventCount:0}}),false);
  assert.equal(singleRuntimeGate("single",{...ready,terrain:{...ready.terrain,visual:{...terrain,lowerEdgeDensity:0}}}),false);
  assert.equal(singleRuntimeGate("both",ready),true);
  assert.equal(singleRuntimeGate("both",null),false);
  assert.equal(singleRuntimeGate("multi",{}),true);
  const complete={runMode:"both",singleRuntime:ready,baseReady:true,cleanup:{cdpClosed:true,chromeExited:true,profileRemoved:true},artifactIdentity:{unchanged:true}};
  assert.equal(finalAcceptanceGate({...complete,cleanup:{...complete.cleanup,cdpClosed:false}}),false);
  assert.equal(finalAcceptanceGate(complete),true);
  assert.equal(finalAcceptanceGate({...complete,cleanup:{chromeExited:false,profileRemoved:true}}),false);
  assert.equal(finalAcceptanceGate({...complete,cleanup:{chromeExited:true,profileRemoved:false}}),false);
  console.log("BROWSER_FILE_ENTRY_ACCEPTANCE_GATE_STATIC_OK");
  process.exit(0);
}

const profileDir = await mkdtemp(`${tmpdir()}/gaius-file-entry-`); const port = await freePort();
const chrome = spawn(chromeBinary,["--headless=new",`--remote-debugging-port=${port}`,"--remote-allow-origins=*",`--user-data-dir=${profileDir}`,"--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-component-update","--disable-domain-reliability","--disable-features=Translate,MediaRouter","about:blank"],{stdio:["ignore","pipe","pipe"]});
const chromeOutput=[];chrome.stdout.on("data",d=>chromeOutput.push(String(d)));chrome.stderr.on("data",d=>chromeOutput.push(String(d)));
let cdp; let report=null; let artifactIdentity=null; let runtime=null; let singleRuntime=null; const consoleMessages=[]; const exceptions=[]; const failedResources=[];
try {
  artifactIdentity=await fileIdentity(artifact);
  await waitJson(`http://127.0.0.1:${port}/json/version`,15000); const targets=await waitJson(`http://127.0.0.1:${port}/json/list`,15000); const page=targets.find(x=>x.type==="page"); if(!page?.webSocketDebuggerUrl)throw new Error("no page target"); cdp=new Cdp(page.webSocketDebuggerUrl); await cdp.open();
  cdp.on("Runtime.consoleAPICalled",e=>consoleMessages.push({type:e.type,text:(e.args||[]).map(a=>a.value??a.description??"").join(" ")})); cdp.on("Runtime.exceptionThrown",e=>exceptions.push(e.exceptionDetails?.exception?.description||e.exceptionDetails?.text||"exception")); const requestUrls=new Map(); cdp.on("Network.requestWillBeSent",e=>requestUrls.set(e.requestId,e.request?.url||"")); cdp.on("Network.loadingFailed",e=>failedResources.push({requestId:e.requestId,url:e.url||requestUrls.get(e.requestId)||"",errorText:e.errorText,canceled:e.canceled})); await Promise.all([cdp.send("Page.enable"),cdp.send("Runtime.enable"),cdp.send("Network.enable"),cdp.send("Performance.enable")]);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument",{source:`(()=>{
    const log=[];
    globalThis.__gaiusBridgeTrace=log;
    const safe=(value, depth=0)=>{
      if(depth>2||value==null)return value;
      if(typeof value==='function')return '[function]';
      if(typeof value!=='object')return value;
      if(typeof MessagePort!=='undefined'&&value instanceof MessagePort)
        return {port:true, generation:String(value.__gaiusLaunchGeneration||''), closed:!!value.__gaiusClosed};
      if(Array.isArray(value))return value.slice(0,12).map(x=>safe(x,depth+1));
      const out={};
      for(const k of Object.keys(value).slice(0,30)){
        try{out[k]=safe(value[k],depth+1);}catch(_){out[k]='[unreadable]';}
      }
      return out;
    };
    const snapshot=()=>{
      const workers=globalThis.__gaiusSingleplayerWorkers;
      const ports=globalThis.__gaiusLocalServerPorts;
      const bridge=globalThis.__gaiusNettyBridge;
      const map=(m)=>m&&typeof m.entries==='function'?Array.from(m.entries()).map(([k,v])=>({key:String(k),value:safe(v)})):null;
      log.push({k:'snapshot',at:Date.now(),session:String(globalThis.__gaiusServerSessionId||''),launchGeneration:String(globalThis.__gaiusServerLaunchGeneration||''),clientPort:safe(globalThis.__gaiusServerClientPort),bridgeType:typeof bridge,bridgeKeys:bridge?Object.keys(bridge):null,networkStats:safe(globalThis.__gaiusNetworkStats),workers:map(workers),ports:map(ports),channels:map(bridge?.channels),owners:map(bridge?.localSessionOwners)});
    };
    const wrapBridge=(bridge)=>{
      if(!bridge||bridge.__traceWrapped)return;
      bridge.__traceWrapped=true;
      for(const k of ['open','registerLocalPort','claimLocalPort','takeLocalPort','attachLocalPort','failLocalSession']){
        if(typeof bridge[k]!=='function')continue;
        const original=bridge[k];
        const wrapped=function(...args){
          log.push({k,args:args.map(x=>safe(x)),at:Date.now(),session:String(globalThis.__gaiusServerSessionId||''),workers:globalThis.__gaiusSingleplayerWorkers?.size||0,ports:globalThis.__gaiusLocalServerPorts?.size||0,channels:bridge.channels?.size||0,owners:bridge.localSessionOwners?.size||0});
          try{return original.apply(this,args);}catch(error){log.push({k:k+'-throw',error:String(error?.stack||error),at:Date.now()});throw error;}
        };
        wrapped.__trace=true;
        bridge[k]=wrapped;
      }
    };
    // Do not replace the bridge property: generated TeaVM code assigns it as a
    // plain global and a descriptor shim can change that initialization
    // semantics. Polling is sufficient and preserves production behavior.
    const originalPostMessage=Worker.prototype.postMessage;
    if(!originalPostMessage.__gaiusTrace){
      const post=function(message,transfer){
        if(message&&typeof message==='object')log.push({k:'worker-postMessage',at:Date.now(),message:{type:message.type||null,sessionId:message.sessionId||null,launchGeneration:message.launchGeneration||null,serverScriptGzipData:!!message.serverScriptGzipData,serverScriptGzipUrl:message.serverScriptGzipUrl||null},transfer:Array.isArray(transfer)?transfer.map(x=>safe(x)):[]});
        return originalPostMessage.apply(this,arguments);
      };
      post.__gaiusTrace=true;Worker.prototype.postMessage=post;
    }
    const tick=()=>{wrapBridge(globalThis.__gaiusNettyBridge);snapshot();};
    setInterval(tick,250);tick();
  })();`});
  await cdp.send("Page.navigate",{url:targetUrl});
  await waitFor(cdp,"document.querySelector('#profile-gate')?.hidden===false",60000,"player-name gate");
  const gate = await evaluate(cdp,`(()=>{const i=document.querySelector('#profile-name');const b=document.querySelector('#profile-submit');if(!i||!b)return false;i.value=${JSON.stringify(playerName)};i.dispatchEvent(new Event('input',{bubbles:true}));b.click();return true;})()`); if(!gate)throw new Error("profile gate controls missing");
  await waitFor(cdp,"String(window.__gaiusMinecraftState?.screen||'').endsWith('TitleScreen')",timeoutMs,"Minecraft title screen");
  const title = await evaluate(cdp,"window.__gaiusMinecraftState?.screen||null");
  await evaluate(cdp,`(()=>{const log=window.__gaiusBridgeTrace||(window.__gaiusBridgeTrace=[]);const b=window.__gaiusNettyBridge;if(!b)return false;for(const k of ['open','registerLocalPort','failLocalSession']){if(typeof b[k]==='function'&&!b[k].__trace){const o=b[k];const w=function(...a){log.push({k,args:a.map(x=>typeof x==='object'&&x&&x.constructor?.name==='MessagePort'?{port:true,g:x.__gaiusLaunchGeneration}:x),at:Date.now(),workers:window.__gaiusSingleplayerWorkers?.size||0,ports:window.__gaiusLocalServerPorts?.size||0});return o.apply(this,a)};w.__trace=true;b[k]=w;}}return true;})()`);
  if(mode === "single" || mode === "both") {
    await clickWidget(cdp,"Singleplayer"); await waitFor(cdp,"/SelectWorldScreen|CreateWorldScreen/.test(String(window.__gaiusMinecraftState?.screen||''))",60000,"singleplayer world-selection screen");
    let screen=await evaluate(cdp,"String(window.__gaiusMinecraftState?.screen||'')");
    if(screen.includes("SelectWorldScreen")) { const create=await findWidget(cdp,"Create New World",5000); if(create) { await clickAt(cdp,create.x,create.y); await waitFor(cdp,"String(window.__gaiusMinecraftState?.screen||'').includes('CreateWorldScreen')",60000,"create-world screen"); } else throw new Error("existing worlds were listed but Create New World was not visible"); }
    await clickWidget(cdp,"Create New World"); await waitFor(cdp,"!!window.__gaiusMinecraftState?.level&&!window.__gaiusMinecraftState?.screen",timeoutMs,"active singleplayer world");
    const terrain=await captureSingleplayerTerrain(cdp);
    singleRuntime = await evaluate(cdp,`(async()=>{let idb='unavailable',storage='unavailable',opfs='unavailable';try{localStorage.setItem('gaius.file.acceptance','1');storage=localStorage.getItem('gaius.file.acceptance')==='1'?'ok':'failed';}catch(e){storage=String(e)}try{if(indexedDB){const r=indexedDB.open('gaius-file-acceptance',1);await new Promise((ok,bad)=>{r.onsuccess=()=>{r.result.close();ok()};r.onerror=()=>bad(r.error||new Error('idb'))});idb='ok';}}catch(e){idb=String(e)}try{opfs=!!navigator.storage?.getDirectory?'ok':'unsupported';}catch(e){opfs=String(e)}return {capturedAt:new Date().toISOString(),stage:'singleplayer-world',protocol:location.protocol,href:location.href,screen:window.__gaiusMinecraftState?.screen||null,level:!!window.__gaiusMinecraftState?.level,portableBuild:!!window.__gaiusPortableBuild,classesUrl:String(window.__gaiusClassesUrl||''),workerUrl:String(window.__gaiusSingleplayerWorkerUrl||''),wasmUrl:String(window.__gaiusHotpathWasmUrl||''),wasm:window.__gaiusWasmHotpath?{ready:!!window.__gaiusWasmHotpath.ready,disabled:!!window.__gaiusWasmHotpath.disabled,error:window.__gaiusWasmHotpath.error||null}:null,storage,idb,opfs,workers:window.__gaiusSingleplayerWorkers?window.__gaiusSingleplayerWorkers.size:null,canvas:document.querySelector('canvas')?.getBoundingClientRect().toJSON()||null,resources:performance.getEntriesByType('resource').map(x=>({name:x.name,duration:x.duration,transferSize:x.transferSize,decodedBodySize:x.decodedBodySize})),events:window.__gaiusMinecraftEvents||[],bridgeTrace:window.__gaiusBridgeTrace||[]};})()`);
    singleRuntime.terrain=terrain;
  }
  if(mode === "multi" || mode === "both") {
    if(mode === "both") { await evaluate(cdp,"location.reload()") ; await waitFor(cdp,"document.querySelector('#profile-gate')?.hidden===false",60000,"second profile gate"); await evaluate(cdp,`(()=>{const i=document.querySelector('#profile-name');i.value=${JSON.stringify(playerName+"M")};i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#profile-submit').click();return true;})()`); await waitFor(cdp,"String(window.__gaiusMinecraftState?.screen||'').endsWith('TitleScreen')",timeoutMs,"title after reload"); }
    await clickWidget(cdp,"Multiplayer"); await waitFor(cdp,"/MultiplayerScreen|ServerListScreen|Online/.test(String(window.__gaiusMinecraftState?.screen||''))",60000,"multiplayer screen");
  }
  runtime = mode==="single" ? singleRuntime : await evaluate(cdp,`(async()=>{let idb='unavailable',storage='unavailable',opfs='unavailable';try{localStorage.setItem('gaius.file.acceptance','1');storage=localStorage.getItem('gaius.file.acceptance')==='1'?'ok':'failed';}catch(e){storage=String(e)}try{if(indexedDB){const r=indexedDB.open('gaius-file-acceptance',1);await new Promise((ok,bad)=>{r.onsuccess=()=>{r.result.close();ok()};r.onerror=()=>bad(r.error||new Error('idb'))});idb='ok';}}catch(e){idb=String(e)}try{opfs=!!navigator.storage?.getDirectory?'ok':'unsupported';}catch(e){opfs=String(e)}return {capturedAt:new Date().toISOString(),stage:'final',protocol:location.protocol,href:location.href,screen:window.__gaiusMinecraftState?.screen||null,level:!!window.__gaiusMinecraftState?.level,portableBuild:!!window.__gaiusPortableBuild,classesUrl:String(window.__gaiusClassesUrl||''),workerUrl:String(window.__gaiusSingleplayerWorkerUrl||''),wasmUrl:String(window.__gaiusHotpathWasmUrl||''),wasm:window.__gaiusWasmHotpath?{ready:!!window.__gaiusWasmHotpath.ready,disabled:!!window.__gaiusWasmHotpath.disabled,error:window.__gaiusWasmHotpath.error||null}:null,storage,idb,opfs,workers:window.__gaiusSingleplayerWorkers?window.__gaiusSingleplayerWorkers.size:null,canvas:document.querySelector('canvas')?.getBoundingClientRect().toJSON()||null,resources:performance.getEntriesByType('resource').map(x=>({name:x.name,duration:x.duration,transferSize:x.transferSize,decodedBodySize:x.decodedBodySize})),events:window.__gaiusMinecraftEvents||[],bridgeTrace:window.__gaiusBridgeTrace||[]};})()`);
  const siblingFileRequests=runtime.resources.filter(x=>x.name.startsWith("file:")&&!x.name.toLowerCase().endsWith(basename(artifact).toLowerCase())).map(x=>x.name); const criticalFailedResources=failedResources.filter(x=>!String(x.url||"").startsWith("http://127.0.0.1:8080/proxy/auth?")); const blobUrls=[runtime.classesUrl,runtime.workerUrl,runtime.wasmUrl].filter(x=>x.startsWith("blob:"));
  const baseReady=exceptions.length===0&&criticalFailedResources.length===0&&siblingFileRequests.length===0&&runtime.protocol==="file:"&&runtime.portableBuild===true&&blobUrls.length>=3;
  report={schemaVersion:2,profile:profileId,artifact,artifactIdentity,targetUrl,mode,completed:true,success:false,titleScreen:title,singleRuntime,runtime,consoleMessages,exceptions,failedResources,siblingFileRequests,blobUrls,gates:{baseReady,singleRuntimeReady:singleRuntimeGate(mode,singleRuntime)},chromeOutput:chromeOutput.join("").slice(-10000),capturedAt:new Date().toISOString()};
  } catch(error) { if(!artifactIdentity){try{artifactIdentity=await fileIdentity(artifact);}catch(_){}} let diagnostic=null; try { diagnostic=await evaluate(cdp,`(()=>{const b=window.__gaiusNettyBridge;return {href:location.href,screen:window.__gaiusMinecraftState?.screen||null,level:!!window.__gaiusMinecraftState?.level,body:(document.body?.innerText||'').slice(0,4000),state:window.__gaiusMinecraftState||null,workers:window.__gaiusSingleplayerWorkers?Array.from(window.__gaiusSingleplayerWorkers.entries()).map(([k,v])=>({key:k,state:v?.state||null,worldgen:v?.worldgen||null,ready:v?.ready||null})):null,events:(window.__gaiusMinecraftEvents||[]).slice(-80),bridgeType:typeof b,bridgeKeys:b?Object.keys(b):null,networkStats:window.__gaiusNetworkStats||null,bridgeStats:b?.stats||null,bridgeInitTrace:window.__gaiusNettyBridgeInitTrace||[],bridgeInitError:window.__gaiusNettyBridgeInitError||null,portableBridgeTrace:window.__gaiusPortableBridgeTrace||[],bridgeTrace:window.__gaiusBridgeTrace||[],bridgeOwn:globalThis===window?Object.getOwnPropertyNames(window).filter(k=>k.toLowerCase().includes('bridge')||k.toLowerCase().includes('network')):[],resources:performance.getEntriesByType('resource').map(x=>({name:x.name,duration:x.duration,transferSize:x.transferSize}))};})()`); } catch(_) {} report={schemaVersion:2,profile:profileId,artifact,artifactIdentity,targetUrl,mode,completed:false,success:false,error:String(error.stack||error),singleRuntime,runtime,diagnostic,consoleMessages,exceptions,failedResources,gates:{baseReady:false,singleRuntimeReady:singleRuntimeGate(mode,singleRuntime)},chromeOutput:chromeOutput.join("").slice(-20000),capturedAt:new Date().toISOString()};
} finally {
  const cdpClosed=await closeCdp(cdp);
  chrome.kill("SIGTERM");
  let chromeExited=await waitForExit(chrome,5000);
  if (!chromeExited) {
    chrome.kill("SIGKILL");
    chromeExited=await waitForExit(chrome,5000);
  }
  const profileCleanup=await removeChromeProfile(profileDir);
  const cleanup={cdpClosed,chromeExited,profileRemoved:profileCleanup.removed,profileError:profileCleanup.error};
  try {
    const finalIdentity=await fileIdentity(artifact);
    artifactIdentity={...artifactIdentity,finalBytes:finalIdentity.bytes,finalSha256:finalIdentity.sha256,unchanged:artifactIdentity?.bytes===finalIdentity.bytes&&artifactIdentity?.sha256===finalIdentity.sha256};
  } catch(error) {
    artifactIdentity={...artifactIdentity,unchanged:false,finalIdentityError:String(error?.stack||error)};
  }
  report=report||{schemaVersion:2,profile:profileId,artifact,targetUrl,mode,completed:false,success:false,error:"acceptance did not produce a report",gates:{baseReady:false,singleRuntimeReady:false},capturedAt:new Date().toISOString()};
  report.artifactIdentity=artifactIdentity;
  report.cleanup=cleanup;
  report.gates={...(report.gates||{}),cleanupReady:cleanup.cdpClosed&&cleanup.chromeExited&&cleanup.profileRemoved,artifactUnchanged:artifactIdentity?.unchanged===true};
  report.success=finalAcceptanceGate({runMode:mode,singleRuntime:report.singleRuntime,baseReady:report.gates.baseReady,cleanup,artifactIdentity});
  report.finishedAt=new Date().toISOString();
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({output,profile:profileId,mode,success:report.success,screen:report.runtime?.screen||null,level:report.singleRuntime?.level||false,storage:report.singleRuntime?.storage||null,idb:report.singleRuntime?.idb||null,wasm:report.singleRuntime?.wasm||null,terrain:report.singleRuntime?.terrain?{ready:report.singleRuntime.terrain.ready,loadedChunkCount:report.singleRuntime.terrain.loadedChunkCount,chunkEventCount:report.singleRuntime.terrain.chunkEventCount,screenshotPath:report.singleRuntime.terrain.screenshotPath}:null,cleanup,artifactUnchanged:artifactIdentity?.unchanged===true,exceptions:exceptions.length,failedResources:failedResources.length},null,2));
  if(!report.success)process.exitCode=1;
}
