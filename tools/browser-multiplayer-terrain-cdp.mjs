import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import {
  analyzeTerrainPng,
  createTerrainVisualFixture,
  terrainVisualPass,
} from './terrain-visual-metrics.mjs';

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function envInteger(name, fallback, minimum = 1) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}; received ${JSON.stringify(raw)}`);
  }
  return value;
}

async function hashFile(path) {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    digest.update(chunk);
  }
  return { bytes, sha256: digest.digest('hex') };
}

async function artifactIdentity(path) {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`ARTIFACT is not a file: ${path}`);
  const identity = await hashFile(path);
  return {
    path,
    name: basename(path),
    bytes: identity.bytes,
    sha256: identity.sha256,
    lastModifiedAt: details.mtime.toISOString(),
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
  return port;
}

async function waitJson(url, timeoutMilliseconds = 20_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForExit(child, timeoutMilliseconds) {
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  return await Promise.race([
    new Promise((done) => child.once('exit', () => done(true))),
    sleep(timeoutMilliseconds).then(() => false),
  ]);
}

async function removeChromeProfile(path) {
  let lastError = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
      try {
        await stat(path);
      } catch (error) {
        if (error?.code === 'ENOENT') return { removed: true, attempts: attempt };
        throw error;
      }
      lastError = new Error(`profile still exists after rm: ${path}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250 * attempt);
  }
  return { removed: false, attempts: 12, error: String(lastError?.stack || lastError) };
}

function boundedAppend(array, value, limit) {
  if (array.length < limit) array.push(value);
}

function formatExceptionDetails(details) {
  const description = details?.exception?.description;
  const text = details?.text;
  const location = Number.isInteger(details?.lineNumber)
    ? ` at ${details.url || '<evaluation>'}:${details.lineNumber + 1}:${(details.columnNumber || 0) + 1}`
    : '';
  return `${description || text || 'Runtime.evaluate failed'}${location}`;
}

class Cdp {
  constructor(url, eventErrorSink = null) {
    this.socket = new WebSocket(url);
    this.sequence = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.eventErrorSink = eventErrorSink;
    this.closed = false;
  }

  async open(timeoutMilliseconds = 15_000) {
    await Promise.race([
      new Promise((done, fail) => {
        this.socket.onopen = done;
        this.socket.onerror = () => fail(new Error('CDP WebSocket failed to open'));
      }),
      sleep(timeoutMilliseconds).then(() => { throw new Error('CDP WebSocket open timeout'); }),
    ]);
    this.socket.onmessage = ({ data }) => this.#handleMessage(data);
    this.socket.onerror = () => this.#rejectPending(new Error('CDP WebSocket error'));
    this.socket.onclose = () => {
      this.closed = true;
      this.#rejectPending(new Error('CDP WebSocket closed'));
    };
  }

  #handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      this.eventErrorSink?.(error);
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners.get(message.method) || []) {
      try {
        listener(message.params || {});
      } catch (error) {
        this.eventErrorSink?.(error);
      }
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMilliseconds = 20_000) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP is not open for ${method}`));
    }
    const id = this.sequence++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out after ${timeoutMilliseconds}ms`));
      }, timeoutMilliseconds);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) || []), listener]);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#rejectPending(new Error('CDP client closed'));
    try { this.socket.close(); } catch {}
  }
}

async function evaluate(cdp, expression, report, label = 'evaluate') {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    const message = formatExceptionDetails(response.exceptionDetails);
    boundedAppend(report.logs.evaluateExceptions, {
      at: new Date().toISOString(),
      label,
      message,
      expression: expression.slice(0, 600),
    }, 100);
    throw new Error(`${label}: ${message}`);
  }
  return response.result?.value;
}

async function click(cdp, x, y, name, report) {
  for (const [type, button, buttons] of [
    ['mouseMoved', 'none', 0],
    ['mousePressed', 'left', 1],
    ['mouseReleased', 'left', 0],
  ]) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button, buttons, clickCount: 1,
    });
  }
  report.actions.push({ at: new Date().toISOString(), name, x, y, via: 'CDP Input.dispatchMouseEvent' });
  await sleep(500);
}

async function typeText(cdp, value, report) {
  for (const character of value) {
    const code = /[A-Za-z]/.test(character)
      ? `Key${character.toUpperCase()}`
      : /[0-9]/.test(character) ? `Digit${character}` : '';
    const virtualKeyCode = /[A-Za-z0-9]/.test(character)
      ? character.toUpperCase().charCodeAt(0)
      : 0;
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: character, code,
      windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode,
    });
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: character, key: character, code });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: character, code,
      windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode,
    });
  }
  report.actions.push({
    at: new Date().toISOString(), name: 'typeText', length: value.length,
    via: 'CDP Input.dispatchKeyEvent',
  });
}

function inferProfile(artifactPath) {
  const match = artifactPath.match(/(?:^|[\\/])(1\.21\.11|26\.2)(?:[\\/]|$)/);
  return process.env.PROFILE || match?.[1] || 'unknown';
}

function normalizeTarget(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `tcp://${raw}`);
    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    while (hostname.endsWith('.') && hostname.length > 1) hostname = hostname.slice(0, -1);
    const authority = hostname.includes(':') ? `[${hostname}]` : hostname;
    return url.port ? `${authority}:${url.port}` : authority;
  } catch {
    return raw.toLowerCase().replace(/\.+(?=:|$)/, '');
  }
}

function normalizeRelay(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
    url.pathname = (url.pathname.replace(/\/+$/, '') || '/').toLowerCase();
    url.hash = '';
    const normalized = url.href;
    return url.pathname === '/' && !url.search ? normalized.replace(/\/$/, '') : normalized;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

function relayNodeSuccesses(bridgeStats, relay) {
  const normalizedRelay = normalizeRelay(relay);
  let successes = 0;
  for (const [nodeRelay, node] of Object.entries(bridgeStats?.relayNodes || {})) {
    if (normalizeRelay(nodeRelay) === normalizedRelay) {
      successes = Math.max(successes, Number(node?.successes) || 0);
    }
  }
  return successes;
}

function relayConnectionEvidence(finalSnapshot) {
  const bridgeStats = finalSnapshot?.bridgeStats || {};
  const phases = Array.isArray(bridgeStats.connectPhases) ? bridgeStats.connectPhases : [];
  return phases.map((event, phaseIndex) => ({ event, phaseIndex }))
    .filter(({ event }) => event?.phase === 'relay-connected')
    .map(({ event, phaseIndex }) => {
      const relay = normalizeRelay(event.relay ?? event.detail);
      return {
        connectionId: event.connectionId ?? event.id ?? null,
        phaseIndex,
        target: normalizeTarget(event.target),
        relay,
        phase: 'relay-connected',
        relayNodeSuccesses: relayNodeSuccesses(bridgeStats, relay),
        at: event.at ?? null,
        elapsedMillis: event.elapsedMillis ?? null,
      };
    });
}

function matchingRelayConnection(records, expectedTarget, expectedRelay) {
  const target = normalizeTarget(expectedTarget);
  const relay = normalizeRelay(expectedRelay);
  return records.find((record) => record.connectionId !== null
    && record.phase === 'relay-connected'
    && record.target === target
    && record.relay === relay
    && Number(record.relayNodeSuccesses) >= 1) || null;
}

function observedEndpoints(finalSnapshot) {
  const bridgeStats = finalSnapshot?.bridgeStats || {};
  const phases = Array.isArray(bridgeStats.connectPhases) ? bridgeStats.connectPhases : [];
  const targets = [...new Set(phases.map((phase) => normalizeTarget(phase?.target)).filter(Boolean))];
  const relays = new Set(Object.keys(bridgeStats.relayNodes || {}).map(normalizeRelay).filter(Boolean));
  for (const phase of phases) {
    if (typeof phase?.detail === 'string' && /^wss?:\/\//i.test(phase.detail)) {
      relays.add(normalizeRelay(phase.detail));
    }
  }
  return { targets, relays: [...relays] };
}

function summarizeResourcePack(transactions) {
  const entries = [...transactions.values()].map((entry) => ({ ...entry }));
  const successful = entries.filter((entry) =>
    Number(entry.status) >= 200
    && Number(entry.status) < 300
    && entry.loadingFinished === true
    && Number(entry.encodedDataLength) > 0
    && !entry.loadingFailed);
  return {
    required: true,
    succeeded: successful.length > 0,
    successfulRequestIds: successful.map((entry) => entry.requestId),
    transactions: entries,
  };
}

function acceptanceGates(report) {
  const state = report.final?.state;
  const bridge = report.final?.bridgeStats;
  // Acceptance is always derived from the raw final bridge snapshot. The
  // convenience/compatibility fields written beside it are not trust roots.
  const observed = observedEndpoints(report.final);
  const connections = relayConnectionEvidence(report.final);
  const boundConnection = matchingRelayConnection(connections, report.expected.target, report.expected.relay);
  return {
    clientLevel: state?.level === 'net.minecraft.client.multiplayer.ClientLevel',
    chunksLoaded: Number(state?.loadedChunkCount) > 0,
    relayConnected: Number(bridge?.connected) >= 1,
    relaySucceeded: Number(bridge?.relayNodeSuccesses) >= 1,
    relayAttestationClean: Number(bridge?.relayTargetAttestationFailures) === 0,
    relayErrorsClean: Number(bridge?.errors) === 0,
    runtimeExceptionsClean: report.logs.exceptions.length === 0,
    evaluateExceptionsClean: report.logs.evaluateExceptions.length === 0,
    eventHandlerErrorsClean: report.logs.cdpEventErrors.length === 0,
    networkErrorsClean: Number(report.final?.net?.errors) === 0,
    bridgeInitClean: !report.final?.bridgeError,
    resourcePackSucceeded: report.resourcePack?.succeeded === true,
    expectedTargetObserved: observed.targets.includes(normalizeTarget(report.expected.target)),
    expectedRelayObserved: observed.relays.includes(normalizeRelay(report.expected.relay)),
    relayConnectionBound: Boolean(boundConnection),
    terrainScreenshotPresent: report.screenshotIdentity.some((entry) =>
      /(?:terrain|world|game)/i.test(entry.label || entry.path)
      && Number(entry.bytes) > 0
      && /^[0-9a-f]{64}$/.test(entry.sha256)
      && terrainVisualPass(entry.visual)),
    chromeExited: report.cleanup.chromeExited === true,
    profileRemoved: report.cleanup.profileRemoved === true,
    artifactUnchanged: report.artifactIdentity.unchanged === true,
  };
}

async function captureScreenshot(cdp, report, screenshotDirectory, suffix, label) {
  const path = resolve(screenshotDirectory, `join-terrain-${report.profile}-${suffix}-${label}.png`);
  const response = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  if (!response.data) throw new Error(`Chrome returned an empty screenshot for ${label}`);
  const buffer = Buffer.from(response.data, 'base64');
  if (buffer.length === 0) throw new Error(`Chrome returned a zero-byte screenshot for ${label}`);
  const visual = analyzeTerrainPng(buffer);
  await writeFile(path, buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  report.screenshots.push(path);
  report.screenshotIdentity.push({
    path, label, bytes: buffer.length, sha256, visual,
    terrainVisualPass: terrainVisualPass(visual),
  });
  return path;
}

async function stopChrome(chrome, cdp, report) {
  report.cleanup.browserCloseRequested = false;
  report.cleanup.termination = [];
  if (cdp && !cdp.closed) {
    try {
      report.cleanup.browserCloseRequested = true;
      await cdp.send('Browser.close', {}, 3_000);
    } catch (error) {
      report.cleanup.termination.push({ step: 'Browser.close', error: String(error?.message || error) });
    }
  }
  cdp?.close();
  if (await waitForExit(chrome, 5_000)) {
    report.cleanup.chromeExited = true;
    report.cleanup.termination.push({ step: 'Browser.close/wait', exited: true });
    return;
  }
  const termSent = chrome?.kill('SIGTERM') || false;
  report.cleanup.termination.push({ step: 'SIGTERM', sent: termSent });
  if (await waitForExit(chrome, 5_000)) {
    report.cleanup.chromeExited = true;
    return;
  }
  const killSent = chrome?.kill('SIGKILL') || false;
  report.cleanup.termination.push({ step: 'SIGKILL', sent: killSent });
  report.cleanup.chromeExited = await waitForExit(chrome, 5_000);
}

async function runStaticSelfTest() {
  const terrainVisual = analyzeTerrainPng(createTerrainVisualFixture());
  const skyHudVisual = analyzeTerrainPng(createTerrainVisualFixture({ skyOnly: true }));
  assert.equal(terrainVisualPass(terrainVisual), true);
  assert.equal(terrainVisual.terrainVisualPass, true);
  assert.equal(terrainVisualPass(skyHudVisual), false);
  assert.equal(skyHudVisual.terrainVisualPass, false);
  const fixture = {
    expected: { target: 'example.test:25565', relay: 'wss://relay.example/tunnel' },
    artifactIdentity: { unchanged: true },
    screenshots: ['C:/tmp/join-terrain-26.2-123-terrain-1.png'],
    screenshotIdentity: [{
      path: 'C:/tmp/join-terrain-26.2-123-terrain-1.png',
      label: 'terrain-1',
      bytes: 1024,
      sha256: 'a'.repeat(64),
      terrainVisualPass: true,
      visual: terrainVisual,
    }],
    logs: { exceptions: [], evaluateExceptions: [], cdpEventErrors: [] },
    cleanup: { chromeExited: true, profileRemoved: true },
    resourcePack: { succeeded: true },
    final: {
      state: {
        level: 'net.minecraft.client.multiplayer.ClientLevel',
        loadedChunkCount: 4,
      },
      net: { connected: 1, errors: 0 },
      bridgeError: null,
      bridgeStats: {
        connected: 1,
        relayNodeSuccesses: 1,
        relayTargetAttestationFailures: 0,
        errors: 0,
        relayNodes: { 'WSS://RELAY.EXAMPLE/TUNNEL/': { successes: 1 } },
        connectPhases: [{
          id: 7,
          target: 'EXAMPLE.TEST:25565',
          phase: 'relay-connected',
          detail: 'WSS://RELAY.EXAMPLE/TUNNEL/',
        }],
      },
      screenshots: ['C:/tmp/join-terrain-26.2-123-terrain-1.png'],
    },
  };
  fixture.observed = observedEndpoints(fixture.final);
  fixture.relayConnectionEvidence = relayConnectionEvidence(fixture.final);
  assert.deepEqual(fixture.observed, {
    targets: ['example.test:25565'], relays: ['wss://relay.example/tunnel'],
  });
  assert.deepEqual(fixture.relayConnectionEvidence.map((entry) => ({
    connectionId: entry.connectionId,
    target: entry.target,
    relay: entry.relay,
    phase: entry.phase,
    relayNodeSuccesses: entry.relayNodeSuccesses,
  })), [{
    connectionId: 7,
    target: 'example.test:25565',
    relay: 'wss://relay.example/tunnel',
    phase: 'relay-connected',
    relayNodeSuccesses: 1,
  }]);
  assert.ok(Object.values(acceptanceGates(fixture)).every(Boolean));
  const splitConnection = structuredClone(fixture);
  splitConnection.final.bridgeStats.relayNodes = {
    'wss://wrong.example/tunnel': { successes: 1 },
    'wss://relay.example/tunnel': { successes: 1 },
  };
  splitConnection.final.bridgeStats.connectPhases = [
    { id: 7, target: 'example.test:25565', phase: 'relay-connected', detail: 'wss://wrong.example/tunnel' },
    { id: 8, target: 'wrong.example:25565', phase: 'relay-connected', detail: 'wss://relay.example/tunnel' },
  ];
  splitConnection.observed = observedEndpoints(splitConnection.final);
  splitConnection.relayConnectionEvidence = relayConnectionEvidence(splitConnection.final);
  assert.equal(splitConnection.observed.targets.includes('example.test:25565'), true);
  assert.equal(splitConnection.observed.relays.includes('wss://relay.example/tunnel'), true);
  assert.equal(acceptanceGates(splitConnection).relayConnectionBound, false);
  const phaseMissing = structuredClone(fixture);
  phaseMissing.final.bridgeStats.connectPhases[0].phase = 'relay-websocket-start';
  phaseMissing.relayConnectionEvidence = relayConnectionEvidence(phaseMissing.final);
  assert.equal(acceptanceGates(phaseMissing).relayConnectionBound, false);
  const zeroSuccess = structuredClone(fixture);
  zeroSuccess.final.bridgeStats.relayNodes['WSS://RELAY.EXAMPLE/TUNNEL/'].successes = 0;
  zeroSuccess.relayConnectionEvidence = relayConnectionEvidence(zeroSuccess.final);
  assert.equal(acceptanceGates(zeroSuccess).relayConnectionBound, false);
  fixture.logs.evaluateExceptions.push({ message: 'synthetic failure' });
  assert.equal(acceptanceGates(fixture).evaluateExceptionsClean, false);
  assert.match(formatExceptionDetails({ text: 'boom', lineNumber: 0, columnNumber: 2 }), /boom.*:1:3/);
  console.log('BROWSER_MULTIPLAYER_TERRAIN_CDP_STATIC_OK');
}

async function main() {
  if (process.argv.includes('--static-self-test')) {
    await runStaticSelfTest();
    return;
  }

  if (!process.env.ARTIFACT) {
    throw new Error('ARTIFACT is required and must point to a compiled Gaius.html');
  }

  const artifact = resolve(process.env.ARTIFACT);
  const profile = inferProfile(artifact);
  const target = process.env.TARGET || 't40.sjcmc.cn:14803';
  const relay = process.env.RELAY || 'wss://ellan.site/tunnel';
  const packChoice = String(process.env.PACK_CHOICE || 'Yes').trim();
  const acceptanceSeconds = envInteger('ACCEPTANCE_SECONDS', 180, 10);
  const chromeBinary = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const suffix = Date.now().toString().slice(-9);
  const username = `Terrain${suffix}`;
  const password = `Gaius${profile.replaceAll('.', '')}P${suffix}`;
  const output = resolve(process.env.OUTPUT || `artifacts/join-terrain-${profile}-${suffix}.json`);
  const screenshotDirectory = resolve(process.env.SCREENSHOT_DIR || dirname(output));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(screenshotDirectory, { recursive: true });

  const initialArtifactIdentity = await artifactIdentity(artifact);
  const debugPort = await freePort();
  const profileDir = await mkdtemp(`${tmpdir()}/gaius-terrain-cdp-`);
  const report = {
    schema: 'gaius.multiplayer-terrain-cdp-acceptance.v3',
    runner: {
      path: resolve(process.argv[1]),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      input: 'CDP Input.dispatchMouseEvent/Input.dispatchKeyEvent only',
    },
    profile,
    artifact,
    artifactIdentity: { ...initialArtifactIdentity, unchanged: null },
    expected: { target, relay, packChoice },
    // Compatibility fields retained for older evidence consumers.
    target,
    relay,
    username,
    passwordLength: password.length,
    acceptanceSeconds,
    startedAt: new Date().toISOString(),
    actions: [],
    transitions: [],
    samples: [],
    logs: {
      exceptions: [],
      evaluateExceptions: [],
      cdpEventErrors: [],
      screenshotErrors: [],
      failedResources: [],
      finishedResources: [],
      requests: [],
      responses: [],
      network: [],
      console: [],
      chromeStdout: '',
      chromeStderr: '',
    },
    screenshots: [],
    screenshotIdentity: [],
    final: null,
    observed: { targets: [], relays: [] },
    relayConnectionEvidence: [],
    resourcePack: { required: true, succeeded: false, successfulRequestIds: [], transactions: [] },
    gates: {},
    cleanup: {
      profileDir,
      chromeExited: false,
      profileRemoved: false,
      browserCloseRequested: false,
      termination: [],
    },
    success: false,
  };

  const chrome = spawn(chromeBinary, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--window-size=854,484',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const appendChildOutput = (current, chunk) => (current + String(chunk)).slice(-64_000);
  chrome.stdout?.on('data', (chunk) => {
    report.logs.chromeStdout = appendChildOutput(report.logs.chromeStdout, chunk);
  });
  chrome.stderr?.on('data', (chunk) => {
    report.logs.chromeStderr = appendChildOutput(report.logs.chromeStderr, chunk);
  });
  chrome.on('error', (error) => {
    report.cleanup.spawnError = String(error?.stack || error);
  });
  chrome.on('exit', (code, signal) => {
    report.cleanup.exitCode = code;
    report.cleanup.signal = signal;
  });

  let cdp;
  const requestUrls = new Map();
  const resourcePackTransactions = new Map();
  try {
    await Promise.race([
      waitJson(`http://127.0.0.1:${debugPort}/json/version`),
      new Promise((_, rejectPromise) => chrome.once('error', rejectPromise)),
    ]);
    const targets = await waitJson(`http://127.0.0.1:${debugPort}/json/list`);
    const page = targets.find((candidate) => candidate.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('Chrome did not expose a page target');
    cdp = new Cdp(page.webSocketDebuggerUrl, (error) => {
      boundedAppend(report.logs.cdpEventErrors, String(error?.stack || error), 100);
    });
    await cdp.open();

    cdp.on('Runtime.exceptionThrown', (event) => boundedAppend(
      report.logs.exceptions,
      {
        at: new Date().toISOString(),
        message: formatExceptionDetails(event.exceptionDetails),
        details: event.exceptionDetails,
      },
      100,
    ));
    cdp.on('Runtime.consoleAPICalled', (event) => boundedAppend(report.logs.console, {
      at: new Date().toISOString(),
      type: event.type,
      text: (event.args || []).map((argument) => argument.value ?? argument.description ?? '').join(' ').slice(0, 2_000),
    }, 1_000));
    cdp.on('Network.requestWillBeSent', (event) => {
      const url = String(event.request?.url || '');
      requestUrls.set(event.requestId, url);
      if (/\/proxy\/resource-pack(?:\?|$)/i.test(url)) {
        resourcePackTransactions.set(event.requestId, {
          requestId: event.requestId,
          url,
          method: event.request?.method || '',
          requestedAt: new Date().toISOString(),
          status: null,
          mimeType: null,
          loadingFinished: false,
          loadingFailed: null,
        });
      }
      boundedAppend(report.logs.requests, {
        url, method: event.request?.method || '', type: event.type || '', documentURL: event.documentURL || '',
      }, 1_000);
      if (/proxy|resource|pack|ellan\.site/i.test(url)) boundedAppend(report.logs.network, {
        at: new Date().toISOString(), kind: 'request', id: event.requestId, url,
        method: event.request?.method, initiator: event.initiator?.type,
      }, 2_000);
    });
    cdp.on('Network.responseReceived', (event) => {
      const url = String(event.response?.url || requestUrls.get(event.requestId) || '');
      boundedAppend(report.logs.responses, {
        requestId: event.requestId, url, status: event.response?.status || 0,
        mimeType: event.response?.mimeType || '', type: event.type || '',
      }, 1_000);
      const resourcePack = resourcePackTransactions.get(event.requestId);
      if (resourcePack || /\/proxy\/resource-pack(?:\?|$)/i.test(url)) {
        const transaction = resourcePack || {
          requestId: event.requestId,
          url,
          method: '',
          requestedAt: null,
          loadingFinished: false,
          loadingFailed: null,
        };
        transaction.url = url;
        transaction.status = event.response?.status ?? null;
        transaction.mimeType = event.response?.mimeType || null;
        transaction.responseAt = new Date().toISOString();
        resourcePackTransactions.set(event.requestId, transaction);
      }
      if (/proxy|resource|pack|ellan\.site/i.test(url)) boundedAppend(report.logs.network, {
        at: new Date().toISOString(), kind: 'response', id: event.requestId, url,
        status: event.response?.status, mimeType: event.response?.mimeType,
        encodedDataLength: event.response?.encodedDataLength,
      }, 2_000);
    });
    cdp.on('Network.loadingFinished', (event) => {
      const url = requestUrls.get(event.requestId) || '';
      boundedAppend(report.logs.finishedResources, {
        at: new Date().toISOString(), requestId: event.requestId, url,
        encodedDataLength: event.encodedDataLength,
      }, 1_000);
      const resourcePack = resourcePackTransactions.get(event.requestId);
      if (resourcePack) {
        resourcePack.loadingFinished = true;
        resourcePack.finishedAt = new Date().toISOString();
        resourcePack.encodedDataLength = event.encodedDataLength ?? null;
      }
    });
    cdp.on('Network.loadingFailed', (event) => boundedAppend(report.logs.failedResources, {
      at: new Date().toISOString(),
      errorText: event.errorText,
      canceled: event.canceled,
      type: event.type,
      url: requestUrls.get(event.requestId) || null,
    }, 1_000));
    cdp.on('Network.loadingFailed', (event) => {
      const resourcePack = resourcePackTransactions.get(event.requestId);
      if (resourcePack) {
        resourcePack.loadingFailed = {
          at: new Date().toISOString(),
          errorText: event.errorText || 'loading failed',
          canceled: Boolean(event.canceled),
        };
      }
    });

    await Promise.all([
      cdp.send('Runtime.enable'),
      cdp.send('Page.enable'),
      cdp.send('Network.enable'),
    ]);

    const launchUrl = `file:///${artifact.replaceAll('\\', '/')}?server=${encodeURIComponent(target)}`
      + `&username=${encodeURIComponent(username)}&offlineDeveloperMode=1`
      + `&relay=${encodeURIComponent(relay)}&bridge=${encodeURIComponent(relay)}`;
    report.launchUrl = launchUrl;
    await cdp.send('Page.navigate', { url: launchUrl });

    let lastScreenKey = '';
    let rulesDone = false;
    let accountDone = false;
    let loginDone = false;
    let packDone = false;
    let warningBackDone = false;
    let terrainFirstSecond = null;

    for (let second = 1; second <= acceptanceSeconds; second++) {
      await sleep(1_000);
      const snapshot = await evaluate(cdp, `(() => {
        const state = window.__gaiusMinecraftState || {};
        return {
          screen: state.screen,
          title: state.screenTitle,
          size: state.screenSize,
          widgets: state.screenWidgets || [],
          level: state.level,
          loadedChunkCount: state.loadedChunkCount,
          player: state.player,
          gameMode: state.gameMode,
          overlay: state.overlay,
          events: (window.__gaiusMinecraftEvents || []).slice(-12),
          net: window.__gaiusNetworkStats || null,
          bridge: window.__gaiusNettyBridgeInitTrace || [],
          bridgeError: window.__gaiusNettyBridgeInitError || null
        };
      })()`, report, `state sample ${second}`);

      report.samples.push({
        second,
        screen: snapshot.screen,
        title: snapshot.title,
        level: snapshot.level,
        loadedChunkCount: snapshot.loadedChunkCount,
        player: snapshot.player,
        gameMode: snapshot.gameMode,
        events: snapshot.events,
        net: snapshot.net && {
          connected: snapshot.net.connected,
          closed: snapshot.net.closed,
          relayNodeSuccesses: snapshot.net.relayNodeSuccesses,
          relayTargetAttestationFailures: snapshot.net.relayTargetAttestationFailures,
          receivedFrames: snapshot.net.receivedFrames,
          receivedBytes: snapshot.net.receivedBytes,
          errors: snapshot.net.errors,
        },
      });

      const screenKey = `${snapshot.screen}|${snapshot.title}`;
      if (screenKey !== lastScreenKey) {
        lastScreenKey = screenKey;
        report.transitions.push({
          second, screen: snapshot.screen, title: snapshot.title, widgets: snapshot.widgets,
        });
        console.log('TRANSITION', second, snapshot.screen, JSON.stringify(snapshot.title),
          'level', snapshot.level, 'chunks', snapshot.loadedChunkCount);
      }

      const hasTerrain = snapshot.level === 'net.minecraft.client.multiplayer.ClientLevel'
        && Number(snapshot.loadedChunkCount) > 0;
      if (hasTerrain) {
        if (terrainFirstSecond == null) {
          terrainFirstSecond = second;
          report.terrainFirstSecond = second;
          console.log('TERRAIN', second, snapshot.loadedChunkCount, snapshot.player);
        }
        if (second <= terrainFirstSecond + 12) {
          try {
            await captureScreenshot(cdp, report, screenshotDirectory, suffix, `terrain-${second}`);
          } catch (error) {
            boundedAppend(report.logs.screenshotErrors, {
              at: new Date().toISOString(), label: `terrain-${second}`, error: String(error?.stack || error),
            }, 100);
          }
        }
        if (second >= terrainFirstSecond + 12) break;
      }

      if (!rulesDone && String(snapshot.screen || '').includes('MultiButtonDialogScreen')
          && String(snapshot.title || '').includes('服务器规则')) {
        rulesDone = true;
        try { await captureScreenshot(cdp, report, screenshotDirectory, suffix, 'rules-top'); } catch {}
        for (let index = 0; index < 9; index++) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: 640, y: 300, button: 'none',
          });
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 640, y: 300, deltaX: 0, deltaY: 900,
          });
          await sleep(300);
        }
        try { await captureScreenshot(cdp, report, screenshotDirectory, suffix, 'rules-bottom'); } catch {}
        report.actions.push({
          at: new Date().toISOString(), name: 'scrollRulesBottom', count: 9,
          via: 'CDP Input.dispatchMouseEvent',
        });
        await click(cdp, 286, 398, 'rulesCheckbox', report);
        await click(cdp, 428, 454, 'rulesAgree', report);
        continue;
      }

      if (!accountDone && String(snapshot.screen || '').includes('MultiButtonDialogScreen')
          && String(snapshot.title || '').includes('创建账号')) {
        accountDone = true;
        try { await captureScreenshot(cdp, report, screenshotDirectory, suffix, 'create-account'); } catch {}
        await click(cdp, 420, 280, 'passwordField', report);
        await typeText(cdp, password, report);
        await click(cdp, 420, 366, 'confirmPasswordField', report);
        await typeText(cdp, password, report);
        await click(cdp, 426, 426, 'registerButton', report);
        continue;
      }

      if (!loginDone && String(snapshot.screen || '').includes('MultiButtonDialogScreen')
          && String(snapshot.title || '').trim() === '登录') {
        loginDone = true;
        try { await captureScreenshot(cdp, report, screenshotDirectory, suffix, 'login'); } catch {}
        await click(cdp, 420, 304, 'loginPasswordField', report);
        await typeText(cdp, password, report);
        await click(cdp, 426, 365, 'loginButton', report);
        continue;
      }

      if (!packDone && String(snapshot.screen || '').includes('PackConfirmScreen')) {
        packDone = true;
        try { await captureScreenshot(cdp, report, screenshotDirectory, suffix, 'pack-confirm'); } catch {}
        const choice = packChoice.toLowerCase();
        const candidates = choice === 'no'
          ? ['No']
          : ['Download', 'Accept', 'Proceed', 'Yes', 'Continue', 'Done'];
        let chosen = null;
        for (const candidate of candidates) {
          const widget = snapshot.widgets.find((entry) =>
            String(entry.text || '').trim().toLowerCase() === candidate.toLowerCase()
            && entry.active !== false);
          if (!widget) continue;
          const scaleX = 854 / (snapshot.size?.width || 427);
          const scaleY = 484 / (snapshot.size?.height || 242);
          await click(cdp,
            (widget.x + widget.width / 2) * scaleX,
            (widget.y + widget.height / 2) * scaleY,
            `pack:${widget.text}`,
            report);
          chosen = widget.text;
          break;
        }
        if (!chosen) {
          report.actions.push({
            at: new Date().toISOString(), name: 'pack-confirm-no-candidate',
            choice: packChoice, widgets: snapshot.widgets,
          });
          console.log('PACK WIDGETS', JSON.stringify(snapshot.widgets));
        }
        continue;
      }

      if (!warningBackDone && String(snapshot.screen || '').includes('WarningScreen')) {
        warningBackDone = true;
        try { await captureScreenshot(cdp, report, screenshotDirectory, suffix, 'warning'); } catch {}
        const back = snapshot.widgets.find((entry) => String(entry.text || '').trim() === 'Back');
        if (back) {
          const scaleX = 854 / (snapshot.size?.width || 427);
          const scaleY = 484 / (snapshot.size?.height || 242);
          await click(cdp,
            (back.x + back.width / 2) * scaleX,
            (back.y + back.height / 2) * scaleY,
            'warningBack',
            report);
        }
      }
    }

    report.final = await evaluate(cdp, `(() => ({
      state: window.__gaiusMinecraftState || null,
      events: window.__gaiusMinecraftEvents || [],
      bridge: window.__gaiusNettyBridgeInitTrace || [],
      bridgeError: window.__gaiusNettyBridgeInitError || null,
      net: window.__gaiusNetworkStats || null,
      bridgeStats: window.__gaiusNettyBridge?.stats || null,
      screenshots: ${JSON.stringify(report.screenshots)},
      body: document.body?.innerText || ''
    }))()`, report, 'final evidence snapshot');
    // Keep final.screenshots authoritative even when screenshots were captured after the JS literal was built.
    report.final.screenshots = [...report.screenshots];
    report.observed = observedEndpoints(report.final);
    report.relayConnectionEvidence = relayConnectionEvidence(report.final);
  } catch (error) {
    report.error = String(error?.stack || error);
    console.error(report.error);
  } finally {
    await stopChrome(chrome, cdp, report);
    const profileCleanup = await removeChromeProfile(profileDir);
    report.cleanup.profileRemoved = profileCleanup.removed;
    report.cleanup.profileRemoveAttempts = profileCleanup.attempts;
    if (profileCleanup.error) report.cleanup.profileRemoveError = profileCleanup.error;

    try {
      const finalArtifactIdentity = await artifactIdentity(artifact);
      report.artifactIdentity.finalBytes = finalArtifactIdentity.bytes;
      report.artifactIdentity.finalSha256 = finalArtifactIdentity.sha256;
      report.artifactIdentity.unchanged = finalArtifactIdentity.bytes === report.artifactIdentity.bytes
        && finalArtifactIdentity.sha256 === report.artifactIdentity.sha256;
    } catch (error) {
      report.artifactIdentity.unchanged = false;
      report.artifactIdentity.finalIdentityError = String(error?.stack || error);
    }

    if (report.final) report.final.screenshots = [...report.screenshots];
    report.observed = observedEndpoints(report.final);
    report.relayConnectionEvidence = relayConnectionEvidence(report.final);
    report.resourcePack = summarizeResourcePack(resourcePackTransactions);
    report.gates = acceptanceGates(report);
    report.success = Object.values(report.gates).every(Boolean);
    report.finishedAt = new Date().toISOString();
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log('RESULT', JSON.stringify({
      output,
      success: report.success,
      artifactIdentity: report.artifactIdentity,
      expected: report.expected,
      observed: report.observed,
      relayConnectionEvidence: report.relayConnectionEvidence,
      resourcePack: report.resourcePack,
      gates: report.gates,
      screen: report.final?.state?.screen,
      title: report.final?.state?.screenTitle,
      level: report.final?.state?.level,
      chunks: report.final?.state?.loadedChunkCount,
      relaySuccesses: report.final?.bridgeStats?.relayNodeSuccesses,
      attestationFailures: report.final?.bridgeStats?.relayTargetAttestationFailures,
      bridgeErrors: report.final?.bridgeStats?.errors,
      runtimeExceptions: report.logs.exceptions.length,
      evaluateExceptions: report.logs.evaluateExceptions.length,
      screenshots: report.screenshots,
      cleanup: report.cleanup,
    }, null, 2));
    if (!report.success) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
