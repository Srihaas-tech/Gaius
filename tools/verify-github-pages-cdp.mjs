import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

function pagesFinalGate({ checks, error, cleanup }) {
  return !error
    && checks.every((entry) => entry.ok)
    && cleanup?.cdpClosed === true
    && cleanup?.chromeExited === true
    && cleanup?.profileRemoved === true;
}

if (process.argv.includes('--static-self-test')) {
  const ready = { checks: [{ ok: true }], error: null, cleanup: { cdpClosed: true, chromeExited: true, profileRemoved: true } };
  assert.equal(pagesFinalGate(ready), true);
  assert.equal(pagesFinalGate({ ...ready, cleanup: { ...ready.cleanup, cdpClosed: false } }), false);
  assert.equal(pagesFinalGate({ ...ready, cleanup: { chromeExited: false, profileRemoved: true } }), false);
  assert.equal(pagesFinalGate({ ...ready, cleanup: { chromeExited: true, profileRemoved: false } }), false);
  assert.equal(pagesFinalGate({ ...ready, error: 'failure' }), false);

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
  const debugPort = await freePort();
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
  await Promise.all([cdp.send('Runtime.enable'), cdp.send('Page.enable'), cdp.send('Network.enable')]);

  const evaluate = async (expression) => {
    const response = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
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

  check(report.checks, 'runtime-exceptions-clean', report.exceptions.length === 0, `exceptions=${report.exceptions.length}`);
} catch (error) {
  executionError = String(error?.stack || error);
  report.error = executionError;
} finally {
  let cdpClosed = true;
  if (cdp) {
    try { cdpClosed = await cdp.close(); }
    catch (error) {
      cdpClosed = false;
      if (!executionError) executionError = String(error?.stack || error);
      report.error = executionError;
    }
  }
  let chromeExited = true;
  if (chrome) {
    chrome.kill('SIGTERM');
    chromeExited = await waitForExit(chrome, 5_000);
    if (!chromeExited) {
      chrome.kill('SIGKILL');
      chromeExited = await waitForExit(chrome, 5_000);
    }
  }
  const profileCleanup = profileDir
    ? await removeChromeProfile(profileDir)
    : { removed: true, error: null };
  report.cleanup = {
    cdpClosed,
    chromeExited,
    profileRemoved: profileCleanup.removed,
    profileError: profileCleanup.error,
  };
  check(report.checks, 'cdp-closed', cdpClosed, `cdpClosed=${cdpClosed}`);
  check(report.checks, 'chrome-exited', chromeExited, `chromeExited=${chromeExited}`);
  check(report.checks, 'profile-removed', profileCleanup.removed, profileCleanup.error || 'removed');
  report.success = pagesFinalGate({ checks: report.checks, error: executionError, cleanup: report.cleanup });
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, success: report.success, cleanup: report.cleanup, checks: report.checks }, null, 2));
  if (executionError) console.error(executionError);
  if (!report.success) process.exitCode = 1;
}
