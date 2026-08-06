import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';

const execFileAsync = promisify(execFile);
const config = loadConfig();
const requestedHost = process.argv[2];
const host = !requestedHost || requestedHost === 'auto' ? await detectHost() : requestedHost;
const checks = [];

await check('config loads', async () => config.bridge.name);
await check('node version', async () => process.versions.node);

if (host === 'lab512' || host === 'auto') {
  await check('lab512 mistralrs binary', async () => {
    if (!fs.existsSync('/Users/danvoulez/.cargo/bin/mistralrs')) throw new Error('missing /Users/danvoulez/.cargo/bin/mistralrs');
    const { stdout, stderr } = await execFileAsync('/Users/danvoulez/.cargo/bin/mistralrs', ['--version'], { timeout: 5000 });
    return (stdout || stderr).trim();
  });
  await check('lab512 model file', async () => {
    const model = '/Users/danvoulez/models/Mistral-Nemo-Instruct-2407-Q4_K_M.gguf';
    const stat = fs.statSync(model);
    return `${model} ${Math.round(stat.size / 1024 / 1024)} MiB`;
  });
}

if (host === 'lab8gb' || host === 'auto') {
  await check('lab8gb dual-route gateway config', async () => {
    if (config.mistral.host !== config.bridge.lab512.ip) throw new Error(`mistral.host=${config.mistral.host}`);
    if (config.mistral.supervise !== false) throw new Error('mistral.supervise must be false');
    const metabolism = config.models.find((model) => model.role === 'metabolism');
    const reader = config.models.find((model) => model.role === 'inference-512');
    if (metabolism?.upstream?.host !== '127.0.0.1') throw new Error('metabolism route is not local');
    if (reader?.upstream?.host !== config.bridge.lab512.ip) throw new Error('reader route is not on LAB 512');
    return `${metabolism.id} -> ${metabolism.upstream.host}:${metabolism.upstream.port}; ${reader.id} -> ${reader.upstream.host}:${reader.upstream.port}`;
  });
}

console.table(checks);
if (checks.some((entry) => entry.status === 'fail')) process.exitCode = 1;

async function detectHost() {
  try {
    const { stdout } = await execFileAsync('hostname', [], { timeout: 3000 });
    const name = stdout.trim().toLowerCase();
    if (name === 'lab-512') return 'lab512';
    if (name === 'lab-8gb') return 'lab8gb';
  } catch {}
  return 'auto';
}

async function check(name, fn) {
  try {
    checks.push({ name, status: 'ok', detail: await fn() });
  } catch (error) {
    checks.push({ name, status: 'fail', detail: error.message });
  }
}
