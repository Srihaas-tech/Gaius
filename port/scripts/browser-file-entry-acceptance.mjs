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
const cdpCommandTimeoutMs = Math.max(1000,
  Number(process.env.GAIUS_FILE_CDP_TIMEOUT_MS || "60000") || 60000);
const chromeBinary = process.env.GAIUS_CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const playerName = process.env.GAIUS_FILE_PLAYER || `GaiusFile${profileId.replace(/\W/g, "")}`;
const targetUrl = `file:///${artifact.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1:")}?fileAcceptance=${Date.now()}`;

async function fileIdentity(path) {
  const bytes = await readFile(path);
  return {bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
}

class Cdp {
  constructor(url, {webSocket=null, commandTimeoutMs=cdpCommandTimeoutMs}={}) {
    this.ws = webSocket || new WebSocket(url);
    this.id = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.state = "connecting";
    this.closed = false;
    this.commandTimeoutMs = commandTimeoutMs;
    this.terminalError = null;
    this.ws.addEventListener("message", event => this.#message(event));
    this.ws.addEventListener("error", () => this.#terminate(
      new Error(this.state === "connecting"
        ? "CDP websocket failed while opening"
        : "CDP websocket failed")));
    this.ws.addEventListener("close", () => this.#terminate(new Error("CDP closed")));
  }
  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  #terminate(error) {
    if (this.closed) return;
    this.closed = true;
    this.state = "closed";
    this.terminalError = error;
    this.#rejectPending(error);
  }
  #message(event) {
    let message;
    try { message=JSON.parse(String(event.data)); }
    catch (error) {
      this.#terminate(new Error(`CDP sent malformed JSON: ${error.message}`));
      return;
    }
    if (message.id != null) {
      const pending=this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error
        ? pending.reject(new Error(`${pending.method}: ${message.error.message}`))
        : pending.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners.get(message.method)||[]) {
      try { listener(message.params||{}); }
      catch (error) { queueMicrotask(()=>{ throw error; }); }
    }
  }
  async open(timeoutMilliseconds=15000) {
    if (this.closed || this.ws.readyState === 2 || this.ws.readyState === 3) {
      throw this.terminalError || new Error("CDP websocket closed before opening");
    }
    if (this.ws.readyState === 1) {
      this.state = "open";
      return;
    }
    await new Promise((resolveOpen,rejectOpen) => {
      const opened=()=>finish(null);
      const failed=()=>finish(this.terminalError || new Error("CDP websocket failed while opening"));
      const closed=()=>finish(this.terminalError || new Error("CDP websocket closed while opening"));
      const finish=error=>{
        clearTimeout(timer);
        this.ws.removeEventListener("open",opened);
        this.ws.removeEventListener("error",failed);
        this.ws.removeEventListener("close",closed);
        error ? rejectOpen(error) : resolveOpen();
      };
      const timer=setTimeout(()=>{
        const error=new Error(`CDP websocket open timed out after ${timeoutMilliseconds} ms`);
        this.#terminate(error);
        try { this.ws.close(); } catch {}
        finish(error);
      },timeoutMilliseconds);
      this.ws.addEventListener("open",opened);
      this.ws.addEventListener("error",failed);
      this.ws.addEventListener("close",closed);
    });
    if (this.closed || this.ws.readyState !== 1) {
      throw this.terminalError || new Error("CDP websocket is not open");
    }
    this.state = "open";
  }
  send(method, params={}, timeoutMilliseconds=this.commandTimeoutMs) {
    if (this.closed || this.state !== "open" || this.ws.readyState !== 1) {
      return Promise.reject(this.terminalError
        || new Error(`CDP is not open; cannot send ${method}`));
    }
    const id=this.id++;
    return new Promise((resolveSend,rejectSend)=>{
      const timer=setTimeout(()=>{
        if (!this.pending.delete(id)) return;
        rejectSend(new Error(`CDP command timed out after ${timeoutMilliseconds} ms: ${method}`));
      },timeoutMilliseconds);
      this.pending.set(id,{method,resolve:resolveSend,reject:rejectSend,timer});
      try { this.ws.send(JSON.stringify({id,method,params})); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectSend(new Error(`CDP send failed for ${method}: ${error.message}`));
      }
    });
  }
  on(method, fn) { this.listeners.set(method,[...(this.listeners.get(method)||[]),fn]); }
  close() {
    if (this.closed || this.ws.readyState === 3) {
      this.#terminate(this.terminalError || new Error("CDP closed"));
      return;
    }
    this.state = "closing";
    try { this.ws.close(); }
    catch (error) { this.#terminate(new Error(`CDP close failed: ${error.message}`)); }
  }
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
async function waitFor(cdp, expression, ms, label) { const end=Date.now()+ms; let last; while(Date.now()<end){try{if(await evaluate(cdp,expression))return;}catch(e){last=e;if(cdp?.closed||cdp?.state!=="open")throw new Error(`CDP unavailable while waiting for ${label}: ${e.message}`,{cause:e});}await sleep(250);}throw new Error(`timeout waiting for ${label}${last?`: ${last.message}`:""}`); }
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
  if(cdp.closed||cdp.ws.readyState===3)return true;
  try {
    const closed=new Promise(resolve=>cdp.ws.addEventListener("close",()=>resolve(true),{once:true}));
    cdp.close();
    return await Promise.race([closed,sleep(timeoutMilliseconds).then(()=>false)]);
  } catch { return false; }
}

async function runCleanupCommand(command,args,options={}) {
  return await new Promise(resolveCommand=>{
    let stdout=""; let stderr=""; let settled=false; let timer=null;
    const child=spawn(command,args,{...options,stdio:["ignore","pipe","pipe"],windowsHide:true});
    child.stdout.on("data",data=>stdout+=String(data));
    child.stderr.on("data",data=>stderr+=String(data));
    const finish=(result)=>{if(settled)return;settled=true;clearTimeout(timer);resolveCommand({...result,stdout,stderr});};
    child.once("error",error=>finish({ok:false,error:String(error?.stack||error)}));
    child.once("exit",(code,signal)=>finish({ok:code===0,code,signal,error:null}));
    timer=setTimeout(()=>{try{child.kill("SIGKILL");}catch{}finish({ok:false,error:`cleanup command timed out: ${command}`});},5000);
  });
}

function parsePidList(outputText) {
  return String(outputText||"").split(",")
    .map(value=>value.trim()).filter(Boolean)
    .map(Number).filter(value=>Number.isInteger(value)&&value>0);
}

async function sweepWindowsChromeProfile(profileDirectory) {
  if(process.platform!=="win32")return {attempted:false,remainingPids:[],error:null};
  const source=[
    "$ErrorActionPreference='Stop'",
    "$needle=$env:GAIUS_CHROME_PROFILE_CLEANUP.Replace('\\','/').ToLowerInvariant()",
    "function MatchesProfile($process){$process.Name -eq 'chrome.exe' -and $process.CommandLine -and $process.CommandLine.Replace('\\','/').ToLowerInvariant().Contains($needle)}",
    "$matches=@(Get-CimInstance Win32_Process | Where-Object { MatchesProfile $_ })",
    "foreach($process in $matches){Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue}",
    "Start-Sleep -Milliseconds 150",
    "$remaining=@(Get-CimInstance Win32_Process | Where-Object { MatchesProfile $_ } | Select-Object -ExpandProperty ProcessId)",
    "[Console]::Out.Write(($remaining -join ','))",
  ].join(";");
  const result=await runCleanupCommand("powershell.exe",[
    "-NoLogo","-NoProfile","-NonInteractive","-Command",source,
  ],{env:{...process.env,GAIUS_CHROME_PROFILE_CLEANUP:profileDirectory}});
  const remainingPids=parsePidList(result.stdout);
  return {attempted:true,remainingPids,error:result.ok?null:(result.error||result.stderr||`exit ${result.code}`)};
}

async function terminateChromeTree(chromeProcess, profileDirectory) {
  const rootPid=chromeProcess?.pid||null;
  const errors=[];
  if(chromeProcess && chromeProcess.exitCode==null && chromeProcess.signalCode==null) {
    if(process.platform==="win32"&&rootPid) {
      const taskkill=await runCleanupCommand("taskkill.exe",["/PID",String(rootPid),"/T","/F"]);
      if(!taskkill.ok&&!/not found|not running|no running instance/i.test(`${taskkill.stdout}\n${taskkill.stderr}`))
        errors.push(taskkill.error||taskkill.stderr||`taskkill exit ${taskkill.code}`);
    } else {
      try { chromeProcess.kill("SIGTERM"); } catch(error) { errors.push(String(error?.stack||error)); }
      if(!await waitForExit(chromeProcess,3000)) {
        try { chromeProcess.kill("SIGKILL"); } catch(error) { errors.push(String(error?.stack||error)); }
      }
    }
  }
  const firstSweep=await sweepWindowsChromeProfile(profileDirectory);
  if(firstSweep.error)errors.push(firstSweep.error);
  if(firstSweep.remainingPids.length) {
    await sleep(250);
    const secondSweep=await sweepWindowsChromeProfile(profileDirectory);
    if(secondSweep.error)errors.push(secondSweep.error);
    firstSweep.remainingPids=secondSweep.remainingPids;
  }
  const rootExited=!chromeProcess||await waitForExit(chromeProcess,5000);
  return {rootPid,rootExited,processTreeExited:rootExited&&firstSweep.remainingPids.length===0,
    remainingPids:firstSweep.remainingPids,error:errors.length?errors.join("\n"):null};
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
    &&cleanup?.processTreeExited===true
    &&cleanup?.profileRemoved===true
    &&artifactIdentity?.unchanged===true;
}

if(process.argv.includes("--static-self-test")){
  assert.deepEqual(parsePidList(""),[],"empty process output must not become PID 0");
  assert.deepEqual(parsePidList(" 12, ,0,-1,not-a-pid,34 "),[12,34],
    "process output must contain only positive integer PIDs");
  class FakeWebSocket {
    constructor(readyState=1){this.readyState=readyState;this.listeners=new Map();this.sent=[];}
    addEventListener(type,listener,options={}){this.listeners.set(type,[...(this.listeners.get(type)||[]),{listener,once:options?.once===true}]);}
    removeEventListener(type,listener){this.listeners.set(type,(this.listeners.get(type)||[]).filter(entry=>entry.listener!==listener));}
    emit(type,data={}){for(const entry of [...(this.listeners.get(type)||[])]){entry.listener({type,...data});if(entry.once)this.removeEventListener(type,entry.listener);}}
    send(data){if(this.readyState!==1)throw new Error("fake socket closed");this.sent.push(data);}
    close(){this.readyState=3;this.emit("close");}
  }
  const openingSocket=new FakeWebSocket(0);
  const openingCdp=new Cdp("ws://static-opening",{webSocket:openingSocket,commandTimeoutMs:25});
  const opening=openingCdp.open(100);
  openingSocket.emit("error");
  await assert.rejects(opening,/failed while opening/,
    "an opening websocket error must reject Cdp.open");
  assert.equal(openingCdp.closed,true);
  const closedSocket=new FakeWebSocket();
  const closedCdp=new Cdp("ws://static-closed",{webSocket:closedSocket,commandTimeoutMs:25});
  await closedCdp.open();
  closedSocket.close();
  await assert.rejects(closedCdp.send("Runtime.evaluate"),/CDP closed|not open/,
    "a send after close must reject immediately");
  const pendingSocket=new FakeWebSocket();
  const pendingCdp=new Cdp("ws://static-pending",{webSocket:pendingSocket,commandTimeoutMs:25});
  await pendingCdp.open();
  const pendingSend=pendingCdp.send("Page.enable");
  assert.equal(pendingCdp.pending.size,1);
  pendingSocket.close();
  await assert.rejects(pendingSend,/CDP closed/,
    "closing CDP must reject an outstanding command");
  assert.equal(pendingCdp.pending.size,0);
  const timeoutSocket=new FakeWebSocket();
  const timeoutCdp=new Cdp("ws://static-timeout",{webSocket:timeoutSocket,commandTimeoutMs:10});
  await timeoutCdp.open();
  await assert.rejects(timeoutCdp.send("Network.enable"),/command timed out/,
    "every CDP command must have a finite timeout");
  assert.equal(timeoutCdp.pending.size,0);
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
  const complete={runMode:"both",singleRuntime:ready,baseReady:true,cleanup:{cdpClosed:true,chromeExited:true,processTreeExited:true,profileRemoved:true},artifactIdentity:{unchanged:true}};
  assert.equal(finalAcceptanceGate({...complete,cleanup:{...complete.cleanup,cdpClosed:false}}),false);
  assert.equal(finalAcceptanceGate(complete),true);
  assert.equal(finalAcceptanceGate({...complete,cleanup:{chromeExited:false,profileRemoved:true}}),false);
  assert.equal(finalAcceptanceGate({...complete,cleanup:{chromeExited:true,processTreeExited:false,profileRemoved:true}}),false);
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
  const treeCleanup=await terminateChromeTree(chrome,profileDir);
  const chromeExited=treeCleanup.rootExited;
  const profileCleanup=await removeChromeProfile(profileDir);
  const cleanup={cdpClosed,chromeExited,processTreeExited:treeCleanup.processTreeExited,
    remainingPids:treeCleanup.remainingPids,processTreeError:treeCleanup.error,
    profileRemoved:profileCleanup.removed,profileError:profileCleanup.error};
  try {
    const finalIdentity=await fileIdentity(artifact);
    artifactIdentity={...artifactIdentity,finalBytes:finalIdentity.bytes,finalSha256:finalIdentity.sha256,unchanged:artifactIdentity?.bytes===finalIdentity.bytes&&artifactIdentity?.sha256===finalIdentity.sha256};
  } catch(error) {
    artifactIdentity={...artifactIdentity,unchanged:false,finalIdentityError:String(error?.stack||error)};
  }
  report=report||{schemaVersion:2,profile:profileId,artifact,targetUrl,mode,completed:false,success:false,error:"acceptance did not produce a report",gates:{baseReady:false,singleRuntimeReady:false},capturedAt:new Date().toISOString()};
  report.artifactIdentity=artifactIdentity;
  report.cleanup=cleanup;
  report.gates={...(report.gates||{}),cleanupReady:cleanup.cdpClosed&&cleanup.chromeExited&&cleanup.processTreeExited&&cleanup.profileRemoved,artifactUnchanged:artifactIdentity?.unchanged===true};
  report.success=finalAcceptanceGate({runMode:mode,singleRuntime:report.singleRuntime,baseReady:report.gates.baseReady,cleanup,artifactIdentity});
  report.finishedAt=new Date().toISOString();
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({output,profile:profileId,mode,success:report.success,screen:report.runtime?.screen||null,level:report.singleRuntime?.level||false,storage:report.singleRuntime?.storage||null,idb:report.singleRuntime?.idb||null,wasm:report.singleRuntime?.wasm||null,terrain:report.singleRuntime?.terrain?{ready:report.singleRuntime.terrain.ready,loadedChunkCount:report.singleRuntime.terrain.loadedChunkCount,chunkEventCount:report.singleRuntime.terrain.chunkEventCount,screenshotPath:report.singleRuntime.terrain.screenshotPath}:null,cleanup,artifactUnchanged:artifactIdentity?.unchanged===true,exceptions:exceptions.length,failedResources:failedResources.length},null,2));
  if(!report.success)process.exitCode=1;
}
