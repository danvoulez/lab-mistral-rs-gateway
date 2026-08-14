import fs from 'node:fs';
import { loadConfig, projectPath } from '../src/config.js';

const config = loadConfig();
const key = process.env.LAB_GATEWAY_KEY || config.gateway.apiKey;
const gateway = process.env.LAB_GATEWAY_URL || config.gateway.publicBaseUrl;
const statusPath = process.env.LAB_BRIDGE_STATUS_FILE || projectPath('runtime/bridge-watchdog.json');

const result = {
  checkedAt: new Date().toISOString(),
  ok: false,
  bridge: config.bridge.name,
  failures: []
};

await must('gateway health', async () => {
  const health = await getJson(`${gateway}/health`);
  if (!health.ok) throw new Error('gateway health ok=false');
  if (!health.upstreamHealthy) throw new Error('upstreamHealthy=false');
  if (health.upstreams?.length !== config.models.length) {
    throw new Error(`expected ${config.models.length} upstreams`);
  }
  result.gateway = health;
});

await must('bridge state', async () => {
  const state = await getJson(`${gateway}/ops/bridge`, { authorization: `Bearer ${key}` });
  if (state.state.supervised !== false) throw new Error('LAB 8GB is not gateway-only');
  for (const model of config.models) {
    const upstream = state.upstreams?.find((entry) => entry.id === model.id);
    const expected = `http://${model.upstream.host}:${model.upstream.port}`;
    if (!upstream || upstream.baseUrl !== expected || !upstream.healthy) {
      throw new Error(`upstream drift for ${model.id}: ${upstream?.baseUrl || 'missing'}`);
    }
  }
  result.state = state;
});

result.ok = result.failures.length === 0;
fs.mkdirSync(projectPath('runtime'), { recursive: true });
fs.writeFileSync(statusPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

async function must(name, fn) {
  try {
    await fn();
  } catch (error) {
    result.failures.push({ name, error: error.message });
  }
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}
