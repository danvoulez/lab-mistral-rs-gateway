import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.js';
import { ModelSupervisor, buildMistralArgs } from '../src/modelSupervisor.js';

const execFileAsync = promisify(execFile);
const config = loadConfig();
const supervisor = new ModelSupervisor(config);

const checks = [];
await check('node >= 20.12', async () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 12)) throw new Error(process.versions.node);
  return process.versions.node;
});

await check('mistralrs binary', async () => {
  const { stdout, stderr } = await execFileAsync(config.mistral.command, ['--version'], { timeout: 5000 });
  return (stdout || stderr).trim();
});

await check('config default model command', async () => {
  const model = config.models.find((entry) => entry.id === config.defaultModel);
  return `${config.mistral.command} ${buildMistralArgs(config, model).join(' ')}`;
});

await check('mistral health', async () => {
  const ok = await supervisor.isMistralHealthy();
  return ok ? 'healthy' : 'not running yet';
});

console.table(checks);
if (checks.some((entry) => entry.status === 'fail')) process.exitCode = 1;

async function check(name, fn) {
  try {
    checks.push({ name, status: 'ok', detail: await fn() });
  } catch (error) {
    checks.push({ name, status: 'fail', detail: error.message });
  }
}
