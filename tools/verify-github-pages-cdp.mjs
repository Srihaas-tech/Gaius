import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';

const base = String(process.env.GAIUS_PAGES_BASE || 'https://typethe0ry.github.io/Gaius/').replace(/\/+$/, '') + '/';
const output = resolve(process.env.OUTPUT || 'artifacts/github-pages-cdp.json');
const chromeBinary = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const expectedRelay = process.env.RELAY || 'wss://ellan.site/tunnel';
const expectedTarget = process.env.TARGET || 't40.sjcmc.cn:14803';
const cdpCommandTimeoutMs = Number(process.env.CDP_COMMAND_TIMEOUT_MS || '15000');
const resourcePackCdpTimeoutMs = 120_000;
const expectedResourcePack = Object.freeze({
  url: 'https://typethe0ry.github.io/Gaius/resource-packs/008381d7a89976709aa86bb71dee06dc50bb3961.zip',
  bytes: 61_102_872,
  sha1: '008381d7a89976709aa86bb71dee06dc50bb3961',
  sha256: 'ee96a1fe577a90f1c2a3f686cdec060a3cbf0f127ae8e0585cb79dd93e69e172',
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (!Number.isInteger(cdpCommandTimeoutMs) || cdpCommandTimeoutMs < 1000) {
  throw new Error(`CDP_COMMAND_TIMEOUT_MS must be an integer >= 1000; received ${JSON.stringify(process.env.CDP_COMMAND_TIMEOUT_MS)}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return true;
  return await new Promise((done) => {
    const finish = (value) => {
      clearTimeout(timer);
      child.removeListener('exit', exited);
      child.removeListener('close', exited);
      done(value);
    };
    const exited = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', exited);
    child.once('close', exited);
  });
}

function cleanupCommandLineMatches(commandLine, profileDir, debugPort) {
  const command = String(commandLine || '').toLowerCase();
  const profile = String(profileDir || '').toLowerCase();
  return Boolean(command && profile && command.includes(profile))
    || command.includes(`--remote-debugging-port=${debugPort}`);
}

async function windowsChromeResidues(profileDir, debugPort) {
  if (process.platform !== 'win32') return [];
  const script = '$ErrorActionPreference = "Stop"; '
    + '$profile = $env:GAIUS_CDP_CLEANUP_PROFILE; '
    + '$needle = "--remote-debugging-port=$env:GAIUS_CDP_CLEANUP_PORT"; '
    + '@(Get-CimInstance Win32_Process -Filter "Name = \'chrome.exe\'" '
    + '| Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($profile) -or $_.CommandLine.Contains($needle)) } '
    + '| Select-Object ProcessId, ParentProcessId, CommandLine) | ConvertTo-Json -Compress';
  const stdout = await new Promise((resolvePromise, rejectPromise) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GAIUS_CDP_CLEANUP_PROFILE: profileDir,
          GAIUS_CDP_CLEANUP_PORT: String(debugPort),
        },
      },
      (error, output) => error ? rejectPromise(error) : resolvePromise(output));
  });
  const text = String(stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    processId: Number(entry.ProcessId),
    parentProcessId: Number(entry.ParentProcessId),
    commandLine: String(entry.CommandLine || ''),
  })).filter((entry) => cleanupCommandLineMatches(entry.commandLine, profileDir, debugPort));
}

async function waitForNoChromeResidues(profileDir, debugPort, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let residues = [];
  do {
    residues = await windowsChromeResidues(profileDir, debugPort);
    if (residues.length === 0) return { clean: true, residues: [] };
    await sleep(250);
  } while (Date.now() < deadline);
  return { clean: false, residues };
}

async function taskkillWindowsTree(processId) {
  if (process.platform !== 'win32' || !Number.isInteger(processId) || processId <= 0) return false;
  return await new Promise((resolvePromise) => {
    execFile('taskkill.exe', ['/PID', String(processId), '/T', '/F'],
      { windowsHide: true, timeout: 10_000 }, (error) => resolvePromise(!error));
  });
}

async function stopChrome(chrome, cdp, profileDir, debugPort) {
  const cleanup = {
    browserCloseRequested: false,
    chromeExited: !chrome,
    processIdentityClean: true,
    residues: [],
    termination: [],
  };
  if (cdp && !cdp.closed) {
    cleanup.browserCloseRequested = true;
    try {
      await cdp.send('Browser.close', {}, 3_000);
      cleanup.termination.push({ step: 'Browser.close', sent: true });
    } catch (error) {
      cleanup.termination.push({ step: 'Browser.close', sent: true, error: String(error?.message || error) });
    }
  }
  if (await waitForExit(chrome, 5_000)) {
    cleanup.termination.push({ step: 'Browser.close/wait', exited: true });
  } else {
    const termSent = chrome?.kill('SIGTERM') || false;
    cleanup.termination.push({ step: 'SIGTERM', sent: termSent });
    if (!(await waitForExit(chrome, 5_000))) {
      const killSent = chrome?.kill('SIGKILL') || false;
      cleanup.termination.push({ step: 'SIGKILL', sent: killSent });
      await waitForExit(chrome, 5_000);
    }
  }
  let identity = await waitForNoChromeResidues(profileDir, debugPort);
  if (!identity.clean && process.platform === 'win32') {
    const killed = [];
    for (const residue of identity.residues) {
      killed.push({ processId: residue.processId, sent: await taskkillWindowsTree(residue.processId) });
    }
    cleanup.termination.push({ step: 'taskkill-residues', processes: killed });
    identity = await waitForNoChromeResidues(profileDir, debugPort);
  }
  cleanup.processIdentityClean = identity.clean;
  cleanup.residues = identity.residues;
  cleanup.chromeExited = (chrome?.exitCode != null || chrome?.signalCode != null) && identity.clean;
  return cleanup;
}

async function removeChromeProfile(path) {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    try {
      await stat(path);
      return { removed: false, error: 'profile still exists after rm' };
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: true, error: null };
      throw error;
    }
  } catch (error) {
    return { removed: false, error: String(error?.stack || error) };
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function waitJson(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(2_000) });
      if (response.ok) return await response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url}`);
}

class Cdp {
  constructor(url, socket = new WebSocket(url)) {
    this.socket = socket;
    this.sequence = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.failed = false;
    this.socket.addEventListener('close', () => {
      this.closed = true;
      this.rejectPending(new Error('CDP WebSocket closed'));
    });
    this.socket.addEventListener('error', () => {
      this.failed = true;
      this.rejectPending(new Error('CDP WebSocket error'));
    });
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  async open(timeoutMs = cdpCommandTimeoutMs) {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => {
        cleanup();
        fail(new Error(`CDP WebSocket open timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const opened = () => { cleanup(); done(); };
      const errored = () => { cleanup(); fail(new Error('CDP WebSocket open failed')); };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener('open', opened);
        this.socket.removeEventListener('error', errored);
      };
      this.socket.addEventListener('open', opened);
      this.socket.addEventListener('error', errored);
    });
    this.socket.onmessage = ({ data }) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch (error) {
        this.failed = true;
        this.rejectPending(error);
        try { this.socket.close(); } catch {}
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
    };
  }
  send(method, params = {}, timeoutMs = cdpCommandTimeoutMs) {
    const id = this.sequence++;
    return new Promise((resolvePromise, rejectPromise) => {
      if (this.closed || this.failed || this.socket.readyState !== WebSocket.OPEN) {
        rejectPromise(new Error(`CDP ${method} cannot be sent on a closed WebSocket`));
        return;
      }
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        rejectPromise(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolvePromise, reject: rejectPromise, timer });
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
  async close(timeoutMs = 2000) {
    this.rejectPending(new Error('CDP connection closed by verifier'));
    if (this.socket.readyState === WebSocket.CLOSED) return true;
    const closed = new Promise((done) => this.socket.addEventListener('close', () => done(true), { once: true }));
    try { this.socket.close(); } catch { return false; }
    return await Promise.race([closed, sleep(timeoutMs).then(() => false)]);
  }
}

function check(results, name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
}

function responseHeader(headers, name) {
  const expected = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === expected) return String(value);
  }
  return null;
}

function verifiedExpectedResourcePackTransaction(transaction) {
  const body = transaction?.bodyVerification;
  return transaction?.requestUrl === expectedResourcePack.url
    && transaction?.responseUrl === expectedResourcePack.url
    && transaction?.method === 'GET'
    && Number(transaction?.status) >= 200
    && Number(transaction?.status) < 300
    && Number(transaction?.declaredContentLength) === expectedResourcePack.bytes
    && transaction?.loadingFinished === true
    && Number(transaction?.encodedDataLength) > 0
    && !transaction?.loadingFailed
    && body?.base64Encoded === true
    && Number(body?.bytes) === expectedResourcePack.bytes
    && body?.sha1 === expectedResourcePack.sha1
    && body?.sha256 === expectedResourcePack.sha256
    && !body?.error;
}

function pagesFinalGate({ checks, error, cleanup }) {
  return !error
    && checks.every((entry) => entry.ok)
    && cleanup?.cdpClosed === true
    && cleanup?.chromeExited === true
    && cleanup?.processIdentityClean === true
    && cleanup?.profileRemoved === true;
}

if (process.argv.includes('--static-self-test')) {
  const ready = { checks: [{ ok: true }], error: null, cleanup: {
    cdpClosed: true, chromeExited: true, processIdentityClean: true, profileRemoved: true,
  } };
  assert.equal(pagesFinalGate(ready), true);
  assert.equal(pagesFinalGate({ ...ready, cleanup: { ...ready.cleanup, cdpClosed: false } }), false);
  assert.equal(pagesFinalGate({ ...ready, cleanup: { chromeExited: false, profileRemoved: true } }), false);
  assert.equal(pagesFinalGate({ ...ready, cleanup: { ...ready.cleanup, processIdentityClean: false } }), false);
  assert.equal(pagesFinalGate({ ...ready, cleanup: { chromeExited: true, profileRemoved: false } }), false);
  assert.equal(pagesFinalGate({ ...ready, error: 'failure' }), false);
  assert.equal(cleanupCommandLineMatches(
    'chrome.exe --user-data-dir=C:\\Temp\\gaius-pages-cdp-ABC',
    'C:\\Temp\\gaius-pages-cdp-ABC', 9222), true);
  assert.equal(cleanupCommandLineMatches(
    'chrome.exe --remote-debugging-port=9222',
    'C:\\Temp\\gaius-pages-cdp-ABC', 9222), true);
  assert.equal(cleanupCommandLineMatches(
    'chrome.exe --remote-debugging-port=9333',
    'C:\\Temp\\gaius-pages-cdp-ABC', 9222), false);

  const exactPack = {
    requestUrl: expectedResourcePack.url,
    responseUrl: expectedResourcePack.url,
    method: 'GET',
    status: 200,
    declaredContentLength: expectedResourcePack.bytes,
    loadingFinished: true,
    encodedDataLength: expectedResourcePack.bytes,
    loadingFailed: null,
    bodyVerification: {
      base64Encoded: true,
      bytes: expectedResourcePack.bytes,
      sha1: expectedResourcePack.sha1,
      sha256: expectedResourcePack.sha256,
    },
  };
  assert.equal(verifiedExpectedResourcePackTransaction(exactPack), true);
  assert.equal(verifiedExpectedResourcePackTransaction({
    ...exactPack,
    declaredContentLength: expectedResourcePack.bytes - 1,
  }), false);
  assert.equal(verifiedExpectedResourcePackTransaction({
    ...exactPack,
    loadingFinished: false,
  }), false);
  assert.equal(verifiedExpectedResourcePackTransaction({
    ...exactPack,
    bodyVerification: { ...exactPack.bodyVerification, sha256: '0'.repeat(64) },
  }), false);

  class FakeSocket extends EventTarget {
    constructor() {
      super();
      this.readyState = WebSocket.OPEN;
      this.sent = [];
    }
    send(value) { this.sent.push(value); }
    close() {
      this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new Event('close'));
    }
  }
  const timeoutSocket = new FakeSocket();
  const timeoutCdp = new Cdp('ws://static.invalid', timeoutSocket);
  await assert.rejects(timeoutCdp.send('Static.timeout', {}, 10), /timed out after 10ms/);
  assert.equal(timeoutCdp.pending.size, 0);
  const closeTimeoutSocket = new FakeSocket();
  closeTimeoutSocket.close = () => {};
  const closeTimeoutCdp = new Cdp('ws://static.invalid', closeTimeoutSocket);
  assert.equal(await closeTimeoutCdp.close(10), false);
  const pendingSocket = new FakeSocket();
  const pendingCdp = new Cdp('ws://static.invalid', pendingSocket);
  const pendingCommand = pendingCdp.send('Static.pending', {}, 1000);
  pendingSocket.dispatchEvent(new Event('error'));
  await assert.rejects(pendingCommand, /CDP WebSocket error/);
  assert.equal(pendingCdp.pending.size, 0);
  await assert.rejects(pendingCdp.send('Static.after-error'), /closed WebSocket/);
  assert.equal(await timeoutCdp.close(), true);
  console.log('VERIFY_GITHUB_PAGES_CDP_STATIC_OK');
  process.exit(0);
}

let profileDir;
let chrome;
let cdp;
let debugPort;
let executionError = null;
const report = {
  schema: 'gaius.github-pages-cdp-acceptance.v1',
  base,
  checkedAt: new Date().toISOString(),
  checks: [],
  pages: [],
  exceptions: [],
};

try {
  debugPort = await freePort();
  const profileRoot = process.env.GAIUS_CDP_PROFILE_ROOT
    ? resolve(process.env.GAIUS_CDP_PROFILE_ROOT)
    : tmpdir();
  await mkdir(profileRoot, { recursive: true });
  profileDir = await mkdtemp(join(profileRoot, 'gaius-pages-cdp-'));
  chrome = spawn(chromeBinary, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  let cleanupEarlyChromeFailure = () => {};
  const earlyChromeFailure = new Promise((unused, reject) => {
    const onError = (error) => reject(error);
    const onExit = (code, signal) => reject(
      new Error(`Chrome exited before CDP became ready (code=${code}, signal=${signal})`));
    chrome.once('error', onError);
    chrome.once('exit', onExit);
    cleanupEarlyChromeFailure = () => {
      chrome.removeListener('error', onError);
      chrome.removeListener('exit', onExit);
    };
  });
  try {
    await Promise.race([
      waitJson(`http://127.0.0.1:${debugPort}/json/version`),
      earlyChromeFailure,
    ]);
  } finally {
    cleanupEarlyChromeFailure();
  }
  const targets = await waitJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = targets.find((candidate) => candidate.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('Chrome did not expose a page target');
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on('Runtime.exceptionThrown', (event) => report.exceptions.push(
    event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'runtime exception'));
  const resourcePackTransactions = new Map();
  const pendingResourcePackBodyVerifications = [];
  cdp.on('Network.requestWillBeSent', (event) => {
    const requestUrl = String(event.request?.url || '');
    if (requestUrl !== expectedResourcePack.url) return;
    resourcePackTransactions.set(event.requestId, {
      requestId: event.requestId,
      requestUrl,
      responseUrl: null,
      method: event.request?.method || '',
      status: null,
      declaredContentLength: null,
      loadingFinished: false,
      loadingFailed: null,
    });
  });
  cdp.on('Network.responseReceived', (event) => {
    const transaction = resourcePackTransactions.get(event.requestId);
    if (!transaction) return;
    transaction.responseUrl = String(event.response?.url || '');
    transaction.status = event.response?.status ?? null;
    transaction.declaredContentLength = responseHeader(event.response?.headers, 'content-length');
  });
  cdp.on('Network.loadingFinished', (event) => {
    const transaction = resourcePackTransactions.get(event.requestId);
    if (!transaction) return;
    transaction.loadingFinished = true;
    transaction.encodedDataLength = event.encodedDataLength ?? null;
    const verification = (async () => {
      try {
        const result = await cdp.send('Network.getResponseBody', {
          requestId: event.requestId,
        }, resourcePackCdpTimeoutMs);
        if (result.base64Encoded !== true) {
          throw new Error('CDP returned the binary resource pack without base64 encoding');
        }
        const body = Buffer.from(result.body || '', 'base64');
        transaction.bodyVerification = {
          base64Encoded: true,
          bytes: body.length,
          sha1: createHash('sha1').update(body).digest('hex'),
          sha256: createHash('sha256').update(body).digest('hex'),
        };
      } catch (error) {
        transaction.bodyVerification = {
          base64Encoded: false,
          bytes: null,
          sha1: null,
          sha256: null,
          error: String(error?.stack || error),
        };
      }
    })();
    pendingResourcePackBodyVerifications.push(verification);
  });
  cdp.on('Network.loadingFailed', (event) => {
    const transaction = resourcePackTransactions.get(event.requestId);
    if (!transaction) return;
    transaction.loadingFailed = {
      errorText: event.errorText || 'loading failed',
      canceled: Boolean(event.canceled),
    };
  });
  await Promise.all([
    cdp.send('Runtime.enable'),
    cdp.send('Page.enable'),
    cdp.send('Network.enable', {
      maxTotalBufferSize: 128 * 1024 * 1024,
      maxResourceBufferSize: 96 * 1024 * 1024,
    }),
  ]);

  const evaluate = async (expression, timeoutMs = cdpCommandTimeoutMs) => {
    const response = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs);
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description
        || response.exceptionDetails.text || 'Runtime.evaluate failed');
    }
    return response.result?.value;
  };

  for (const path of ['', '1.21.11/', '26.2/']) {
    const url = new URL(path, base).href;
    await cdp.send('Page.navigate', { url });
    let snapshot;
    for (let attempt = 0; attempt < 80; attempt++) {
      await sleep(100);
      snapshot = await evaluate(`(() => ({
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        relay: document.querySelector('#relay')?.value || '',
        target: document.querySelector('#target')?.value || '',
        status: document.querySelector('#status')?.textContent || '',
        links: [...document.querySelectorAll('a.launch')].map((anchor) => ({
          profile: anchor.dataset.profile || '', text: anchor.textContent.trim(), href: anchor.href
        }))
      }))()`);
      if (snapshot?.href === url && snapshot.readyState === 'complete'
          && snapshot.status && !snapshot.status.startsWith('正在读取')) break;
    }
    report.pages.push({ path, ...snapshot });
    check(report.checks, `${path || 'home'}-loaded`, snapshot?.href === url
      && snapshot?.readyState === 'complete' && snapshot?.title.includes('Gaius'),
    `expected=${url}; actual=${snapshot?.href}; title=${snapshot?.title}`);
    check(report.checks, `${path || 'home'}-relay-default`, snapshot?.relay === expectedRelay, snapshot?.relay);
    check(report.checks, `${path || 'home'}-target-default`, snapshot?.target === expectedTarget, snapshot?.target);
    check(report.checks, `${path || 'home'}-registry-rendered`, snapshot?.status?.includes(expectedRelay), snapshot?.status?.slice(0, 240));
  }

  const registryUrl = new URL('relay-nodes.json', base).href;
  const registryResponse = await fetch(registryUrl, {
    cache: 'no-store', signal: AbortSignal.timeout(cdpCommandTimeoutMs),
  });
  const registry = registryResponse.ok ? await registryResponse.json() : null;
  report.registry = { url: registryUrl, status: registryResponse.status, body: registry };
  check(report.checks, 'relay-registry-http', registryResponse.ok, `HTTP ${registryResponse.status}`);
  check(report.checks, 'relay-registry-schema', registry?.kind === 'gaius-relay-registry' && registry?.protocolVersion === 1, JSON.stringify(registry));
  check(report.checks, 'relay-registry-node', registry?.nodes?.some((node) => node.url === expectedRelay), JSON.stringify(registry?.nodes || []));

  for (const profile of ['1.21.11', '26.2']) {
    const pageUrl = new URL(`${profile}/`, base).href;
    await cdp.send('Page.navigate', { url: pageUrl });
    let pageReady = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      await sleep(100);
      pageReady = await evaluate(`location.href === ${JSON.stringify(pageUrl)} && document.readyState === 'complete'`);
      if (pageReady) break;
    }
    check(report.checks, `${profile}-parameter-page-loaded`, pageReady, `expected=${pageUrl}`);
    const injected = await evaluate(`(() => {
      const relay = document.querySelector('#relay');
      const target = document.querySelector('#target');
      const anchor = document.querySelector('a.launch[data-profile=${JSON.stringify(profile)}]');
      if (!relay || !target || !anchor) return { error: 'required launcher controls missing' };
      relay.value = ${JSON.stringify(expectedRelay)};
      target.value = ${JSON.stringify(expectedTarget)};
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { href: anchor.href, hint: document.querySelector('#hint')?.textContent || '' };
    })()`);
    if (injected?.error || !injected?.href) throw new Error(injected?.error || `missing ${profile} launch href`);
    const launch = new URL(injected.href);
    report.pages.push({ path: `${profile}/parameter-injection`, ...injected });
    const expectedReleasePath = `/TypeThe0ry/Gaius/releases/latest/download/Gaius-${profile}.html`;
    check(report.checks, `${profile}-launch-release`, launch.protocol === 'https:'
      && launch.hostname === 'github.com' && launch.pathname === expectedReleasePath,
    launch.href);
    check(report.checks, `${profile}-launch-relay-param`, launch.searchParams.get('relay') === expectedRelay && launch.searchParams.get('bridge') === expectedRelay, launch.search);
    check(report.checks, `${profile}-launch-server-param`, launch.searchParams.get('server') === expectedTarget && launch.searchParams.get('directPlugin') === '0', launch.search);
  }

  const resourcePackFetch = await evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(expectedResourcePack.url)}, { cache: 'no-store' });
    const body = await response.arrayBuffer();
    return { url: response.url, status: response.status, bytes: body.byteLength };
  })()`, resourcePackCdpTimeoutMs);
  // Runtime.evaluate and Network.loadingFinished are independent CDP messages.  Even though the
  // page-side arrayBuffer() has completed, give the event handler time to enqueue and finish its
  // Network.getResponseBody verification instead of taking a one-time snapshot of the promise list.
  const resourcePackEventDeadline = Date.now() + 10_000;
  while (Date.now() < resourcePackEventDeadline) {
    await Promise.allSettled([...pendingResourcePackBodyVerifications]);
    const transactions = [...resourcePackTransactions.values()];
    if (transactions.some(verifiedExpectedResourcePackTransaction)) break;
    if (transactions.length > 0 && transactions.every((transaction) =>
      transaction.loadingFailed || (transaction.loadingFinished && transaction.bodyVerification))) {
      break;
    }
    await sleep(50);
  }
  const resourcePackTransactionList = [...resourcePackTransactions.values()];
  const verifiedResourcePack = resourcePackTransactionList.find(
    verifiedExpectedResourcePackTransaction,
  ) || null;
  report.resourcePack = {
    expected: expectedResourcePack,
    browserFetch: resourcePackFetch,
    transactions: resourcePackTransactionList,
    verified: Boolean(verifiedResourcePack),
  };
  check(report.checks, 'resource-pack-browser-fetch', resourcePackFetch?.url === expectedResourcePack.url
    && Number(resourcePackFetch?.status) >= 200 && Number(resourcePackFetch?.status) < 300
    && Number(resourcePackFetch?.bytes) === expectedResourcePack.bytes,
  JSON.stringify(resourcePackFetch));
  check(report.checks, 'resource-pack-exact-get-content-length-loading-finished-body-hashes',
    Boolean(verifiedResourcePack), JSON.stringify(resourcePackTransactionList));

  check(report.checks, 'runtime-exceptions-clean', report.exceptions.length === 0, `exceptions=${report.exceptions.length}`);
} catch (error) {
  executionError = String(error?.stack || error);
  report.error = executionError;
} finally {
  let chromeCleanup = {
    browserCloseRequested: false,
    chromeExited: true,
    processIdentityClean: true,
    residues: [],
    termination: [],
  };
  if (chrome) {
    try {
      chromeCleanup = await stopChrome(chrome, cdp, profileDir, debugPort);
    } catch (error) {
      chromeCleanup.chromeExited = false;
      chromeCleanup.processIdentityClean = false;
      chromeCleanup.termination.push({ step: 'stopChrome', error: String(error?.stack || error) });
      if (!executionError) executionError = String(error?.stack || error);
      report.error = executionError;
    }
  }
  let cdpClosed = true;
  if (cdp) {
    try { cdpClosed = await cdp.close(); }
    catch (error) {
      cdpClosed = false;
      if (!executionError) executionError = String(error?.stack || error);
      report.error = executionError;
    }
  }
  const profileCleanup = profileDir
    ? await removeChromeProfile(profileDir)
    : { removed: true, error: null };
  report.cleanup = {
    cdpClosed,
    ...chromeCleanup,
    profileRemoved: profileCleanup.removed,
    profileError: profileCleanup.error,
  };
  check(report.checks, 'cdp-closed', cdpClosed, `cdpClosed=${cdpClosed}`);
  check(report.checks, 'chrome-exited', chromeCleanup.chromeExited,
    `chromeExited=${chromeCleanup.chromeExited}; processIdentityClean=${chromeCleanup.processIdentityClean}; residues=${JSON.stringify(chromeCleanup.residues)}`);
  check(report.checks, 'profile-removed', profileCleanup.removed, profileCleanup.error || 'removed');
  report.success = pagesFinalGate({ checks: report.checks, error: executionError, cleanup: report.cleanup });
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, success: report.success, cleanup: report.cleanup, checks: report.checks }, null, 2));
  if (executionError) console.error(executionError);
  if (!report.success) process.exitCode = 1;
}
