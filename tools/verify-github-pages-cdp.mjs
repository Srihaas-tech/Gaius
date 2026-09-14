import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';

const base = String(process.env.GAIUS_PAGES_BASE || 'https://typethe0ry.github.io/Gaius/').replace(/\/+$/, '') + '/';
const output = resolve(process.env.OUTPUT || 'artifacts/github-pages-cdp.json');
const chromeBinary = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const expectedRelay = process.env.RELAY || 'wss://ellan.site/tunnel';
const expectedTarget = process.env.TARGET || 't40.sjcmc.cn:14803';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return await response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async open() {
    await new Promise((done, fail) => {
      this.socket.onopen = done;
      this.socket.onerror = fail;
    });
    this.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
    };
  }
  send(method, params = {}) {
    const id = this.sequence++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, listener) {
    this.listeners.set(method, [...(this.listeners.get(method) || []), listener]);
  }
  close() { this.socket.close(); }
}

function check(results, name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
}

const debugPort = await freePort();
const profileDir = await mkdtemp(`${tmpdir()}/gaius-pages-cdp-`);
const chrome = spawn(chromeBinary, [
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
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let cdp;
const report = {
  schema: 'gaius.github-pages-cdp-acceptance.v1',
  base,
  checkedAt: new Date().toISOString(),
  checks: [],
  pages: [],
  exceptions: [],
};

try {
  await waitJson(`http://127.0.0.1:${debugPort}/json/version`);
  const targets = await waitJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = targets.find((candidate) => candidate.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('Chrome did not expose a page target');
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on('Runtime.exceptionThrown', (event) => report.exceptions.push(
    event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'runtime exception'));
  await Promise.all([cdp.send('Runtime.enable'), cdp.send('Page.enable'), cdp.send('Network.enable')]);

  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })).result?.value;

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
      if (snapshot?.readyState === 'complete' && !snapshot.status.startsWith('正在读取')) break;
    }
    report.pages.push({ path, ...snapshot });
    check(report.checks, `${path || 'home'}-loaded`, snapshot?.readyState === 'complete' && snapshot?.title.includes('Gaius'), snapshot?.title);
    check(report.checks, `${path || 'home'}-relay-default`, snapshot?.relay === expectedRelay, snapshot?.relay);
    check(report.checks, `${path || 'home'}-target-default`, snapshot?.target === expectedTarget, snapshot?.target);
    check(report.checks, `${path || 'home'}-registry-rendered`, snapshot?.status.includes(expectedRelay), snapshot?.status.slice(0, 240));
  }

  const registryUrl = new URL('relay-nodes.json', base).href;
  const registryResponse = await fetch(registryUrl, { cache: 'no-store' });
  const registry = registryResponse.ok ? await registryResponse.json() : null;
  report.registry = { url: registryUrl, status: registryResponse.status, body: registry };
  check(report.checks, 'relay-registry-http', registryResponse.ok, `HTTP ${registryResponse.status}`);
  check(report.checks, 'relay-registry-schema', registry?.kind === 'gaius-relay-registry' && registry?.protocolVersion === 1, JSON.stringify(registry));
  check(report.checks, 'relay-registry-node', registry?.nodes?.some((node) => node.url === expectedRelay), JSON.stringify(registry?.nodes || []));

  for (const profile of ['1.21.11', '26.2']) {
    const pageUrl = new URL(`${profile}/`, base).href;
    await cdp.send('Page.navigate', { url: pageUrl });
    await sleep(800);
    const injected = await evaluate(`(() => {
      const relay = document.querySelector('#relay');
      const target = document.querySelector('#target');
      const anchor = document.querySelector('a.launch[data-profile=${JSON.stringify(profile)}]');
      relay.value = ${JSON.stringify(expectedRelay)};
      target.value = ${JSON.stringify(expectedTarget)};
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { href: anchor.href, hint: document.querySelector('#hint')?.textContent || '' };
    })()`);
    const launch = new URL(injected.href);
    report.pages.push({ path: `${profile}/parameter-injection`, ...injected });
    check(report.checks, `${profile}-launch-release`, launch.hostname === 'github.com' && launch.pathname.endsWith(`/Gaius-${profile}.html`), launch.href);
    check(report.checks, `${profile}-launch-relay-param`, launch.searchParams.get('relay') === expectedRelay && launch.searchParams.get('bridge') === expectedRelay, launch.search);
    check(report.checks, `${profile}-launch-server-param`, launch.searchParams.get('server') === expectedTarget && launch.searchParams.get('directPlugin') === '0', launch.search);
  }

  check(report.checks, 'runtime-exceptions-clean', report.exceptions.length === 0, `exceptions=${report.exceptions.length}`);
  report.success = report.checks.every((entry) => entry.ok);
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, success: report.success, checks: report.checks }, null, 2));
  if (!report.success) process.exitCode = 1;
} finally {
  cdp?.close();
  chrome.kill();
  await sleep(500);
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
