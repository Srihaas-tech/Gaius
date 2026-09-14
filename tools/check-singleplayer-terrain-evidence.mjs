import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTerrainPng, createTerrainVisualFixture, terrainVisualPass } from './terrain-visual-metrics.mjs';

const identity = (bytes) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const gate = (name, ok, detail = '') => ({ name, ok: Boolean(ok), detail: String(detail ?? '') });

export async function validateSingleplayerEvidence(evidencePath, options = {}) {
  const path = resolve(evidencePath);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  const expectedProfile = options.profile || process.env.PROFILE || evidence.profile;
  const expectedArtifact = resolve(options.artifact || process.env.ARTIFACT || evidence.artifact);
  const runtime = evidence.singleRuntime;
  const terrain = runtime?.terrain;
  const checks = [
    gate('runner-success', evidence.completed === true && evidence.success === true,
      `${evidence.completed}/${evidence.success}`),
    gate('profile', evidence.profile === expectedProfile, `${evidence.profile}/${expectedProfile}`),
    gate('mode', ['single', 'both'].includes(evidence.mode), evidence.mode),
    gate('file-portable', runtime?.protocol === 'file:' && runtime?.portableBuild === true,
      `${runtime?.protocol}/${runtime?.portableBuild}`),
    gate('level', runtime?.level === true, runtime?.level),
    gate('wasm', runtime?.wasm?.ready === true && runtime?.wasm?.disabled !== true
      && runtime?.wasm?.error == null, JSON.stringify(runtime?.wasm)),
    gate('storage', runtime?.storage === 'ok' && runtime?.idb === 'ok',
      `${runtime?.storage}/${runtime?.idb}`),
    gate('terrain-declared', terrain?.ready === true && Number(terrain?.loadedChunkCount) > 0
      && Number(terrain?.chunkEventCount) > 0 && terrainVisualPass(terrain?.visual),
    JSON.stringify({ ready: terrain?.ready, chunks: terrain?.loadedChunkCount,
      chunkEvents: terrain?.chunkEventCount })),
    gate('runtime-exceptions-clean', (evidence.exceptions || []).length === 0,
      (evidence.exceptions || []).length),
    gate('sibling-file-requests-clean', (evidence.siblingFileRequests || []).length === 0,
      (evidence.siblingFileRequests || []).length),
    gate('base-ready', evidence.gates?.baseReady === true, evidence.gates?.baseReady),
    gate('cleanup', evidence.cleanup?.cdpClosed === true && evidence.cleanup?.chromeExited === true
      && evidence.cleanup?.profileRemoved === true, JSON.stringify(evidence.cleanup)),
    gate('artifact-unchanged', evidence.artifactIdentity?.unchanged === true,
      evidence.artifactIdentity?.unchanged),
  ];

  try {
    const artifactBytes = await readFile(expectedArtifact);
    const actual = identity(artifactBytes);
    checks.push(gate('artifact-path', resolve(evidence.artifact) === expectedArtifact,
      `${evidence.artifact}/${expectedArtifact}`));
    checks.push(gate('artifact-identity', actual.bytes === Number(evidence.artifactIdentity?.bytes)
      && actual.sha256 === evidence.artifactIdentity?.sha256, JSON.stringify(actual)));
  } catch (error) {
    checks.push(gate('artifact-identity', false, error?.message || error));
  }

  let screenshot = null;
  try {
    const declaredPath = String(terrain?.screenshotPath || '');
    const screenshotPath = isAbsolute(declaredPath) ? declaredPath : resolve(dirname(path), declaredPath);
    const png = await readFile(screenshotPath);
    const actual = identity(png);
    const visual = analyzeTerrainPng(png);
    const metricsMatch = ['sourceWidth', 'sourceHeight', 'sampleWidth', 'sampleHeight',
      'lowerTexturedTileCount', 'lowerTexturedRowCount', 'lowerTexturedColumnCount']
      .every((name) => Number(terrain?.visual?.[name]) === Number(visual[name]))
      && ['nonBlackRatio', 'luminanceStdDev', 'centralLuminanceStdDev',
        'centralDominantColorRatio', 'lowerLuminanceStdDev', 'lowerEdgeDensity']
        .every((name) => Math.abs(Number(terrain?.visual?.[name]) - Number(visual[name])) <= 1e-9);
    screenshot = { path: screenshotPath, ...actual, visual };
    checks.push(gate('terrain-screenshot-identity', actual.bytes === Number(terrain?.identity?.bytes)
      && actual.sha256 === terrain?.identity?.sha256, JSON.stringify(actual)));
    checks.push(gate('terrain-visual-recomputed', terrainVisualPass(visual) && metricsMatch,
      JSON.stringify({ terrainVisualPass: terrainVisualPass(visual), metricsMatch })));
  } catch (error) {
    checks.push(gate('terrain-screenshot-identity', false, error?.message || error));
  }

  const result = {
    schema: 'gaius.singleplayer-terrain-evidence-validation.v1', evidencePath: path,
    expected: { profile: expectedProfile, artifact: expectedArtifact }, screenshot, checks,
    success: checks.every((entry) => entry.ok), checkedAt: new Date().toISOString(),
  };
  if (!result.success && options.throwOnFailure !== false) {
    throw new Error(`SINGLEPLAYER TERRAIN EVIDENCE:\n${checks.filter((entry) => !entry.ok)
      .map((entry) => `${entry.name}: ${entry.detail}`).join('\n')}`);
  }
  return result;
}

async function selfTest() {
  const directory = await mkdtemp(join(tmpdir(), 'gaius-single-terrain-validator-'));
  try {
    const artifact = join(directory, 'Gaius.html');
    const screenshotPath = join(directory, 'terrain.png');
    const evidencePath = join(directory, 'evidence.json');
    const artifactBytes = Buffer.from('compiled-gaius');
    const png = createTerrainVisualFixture();
    const visual = analyzeTerrainPng(png);
    await writeFile(artifact, artifactBytes); await writeFile(screenshotPath, png);
    const evidence = {
      schemaVersion: 2, profile: '26.2', artifact, mode: 'single', completed: true, success: true,
      artifactIdentity: { ...identity(artifactBytes), unchanged: true }, exceptions: [],
      siblingFileRequests: [], gates: { baseReady: true },
      cleanup: { cdpClosed: true, chromeExited: true, profileRemoved: true },
      singleRuntime: { protocol: 'file:', portableBuild: true, level: true,
        wasm: { ready: true, disabled: false, error: null }, storage: 'ok', idb: 'ok',
        terrain: { ready: true, screenshotPath, identity: identity(png), loadedChunkCount: 4,
          chunkEventCount: 2, visual } },
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    assert.equal((await validateSingleplayerEvidence(evidencePath, { artifact, profile: '26.2' })).success, true);
    evidence.singleRuntime.terrain.loadedChunkCount = 0;
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    assert.equal((await validateSingleplayerEvidence(evidencePath,
      { artifact, profile: '26.2', throwOnFailure: false })).success, false);
    console.log('CHECK_SINGLEPLAYER_TERRAIN_EVIDENCE_STATIC_OK');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function main() {
  if (process.argv.includes('--static-self-test')) return selfTest();
  const evidencePath = process.argv[2] || process.env.EVIDENCE;
  if (!evidencePath) throw new Error('usage: node tools/check-singleplayer-terrain-evidence.mjs <evidence.json>');
  console.log(JSON.stringify(await validateSingleplayerEvidence(evidencePath), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
}
