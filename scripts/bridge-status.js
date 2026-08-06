import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';

const execFileAsync = promisify(execFile);
const config = loadConfig();
const key = process.env.LAB_GATEWAY_KEY || config.gateway.apiKey;
const gateway = process.env.LAB_GATEWAY_URL || config.gateway.publicBaseUrl;
const lab8 = config.bridge.lab8gb.ip;
const lab512 = config.bridge.lab512.ip;

const report = {
  checkedAt: new Date().toISOString(),
  bridge: config.bridge.name,
  expected: {
    inference: config.models.map((model) => ({
      id: model.id,
      role: model.role,
      endpoint: `${model.upstream.host}:${model.upstream.port}`
    })),
    gateway: gateway,
    model: config.defaultModel,
    protectedLaunchLabels: config.bridge.protectedLaunchLabels,
    deletedLaunchLabels: config.bridge.deletedLaunchLabels,
    warningLaunchLabels: config.bridge.warningLaunchLabels
  },
  checks: []
};

await check('lab512_mistral_health', async () => {
  return await getText(`http://${lab512}:${config.mistral.port}/health`);
});

await check('lab8_metabolism_health', async () => {
  const model = config.models.find((entry) => entry.role === 'metabolism');
  return await getText(`http://${model.upstream.host}:${model.upstream.port}/health`);
});

await check('lab512_mistral_models', async () => {
  return await getJson(`http://${lab512}:${config.mistral.port}/v1/models`);
});

await check('lab8_gateway_health', async () => {
  return await getJson(`${gateway}/health`);
});

await check('lab8_bridge_state', async () => {
  return await getJson(`${gateway}/ops/bridge`, { authorization: `Bearer ${key}` });
});

await check('lab8_launch_labels', async () => {
  const { stdout } = await execFileAsync('ssh', [
    `danvoulez@${lab8}`,
    'launchctl list | egrep -i "(manhattan|actgraph|openclaw|lab-mistral-gateway|host-runtime)" || true'
  ], { timeout: 10000 });
  return stdout.trim();
});

await check('lab8_relevant_ports', async () => {
  const { stdout } = await execFileAsync('ssh', [
    `danvoulez@${lab8}`,
    'lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | egrep "(7000|7001|8787|18789|1234|actgraph|mistral|gateway)" || true'
  ], { timeout: 10000 });
  return stdout.trim();
});

await check('lab8_dated_launchagents', async () => {
  const { stdout } = await execFileAsync('ssh', [
    `danvoulez@${lab8}`,
    'find "$HOME/Library/LaunchAgents" -maxdepth 1 -type f 2>/dev/null | egrep -i "(actgraph|openclaw|gateway|lab-mistral|manhattan)" | while IFS= read -r p; do stat -f "%Sm %N" -t "%Y-%m-%d %H:%M:%S" "$p"; done'
  ], { timeout: 10000 });
  return stdout.trim();
});

console.log(JSON.stringify(report, null, 2));
if (report.checks.some((entry) => entry.status !== 'ok')) process.exitCode = 1;

async function check(name, fn) {
  try {
    report.checks.push({ name, status: 'ok', detail: await fn() });
  } catch (error) {
    report.checks.push({ name, status: 'fail', detail: error.message });
  }
}

async function getText(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 400)}`);
  return text.trim();
}

async function getJson(url, headers = {}) {
  const text = await getText(url, headers);
  return JSON.parse(text);
}
