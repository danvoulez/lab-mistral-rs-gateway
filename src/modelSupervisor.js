import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { modelById, projectPath, upstreamAuthHeaders, upstreamBaseUrl, upstreamEndpoint } from './config.js';

const stateFile = projectPath('runtime/mistral-state.json');

export class ModelSupervisor {
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    this.child = null;
    this.lock = Promise.resolve();
  }

  async ensureModel(model) {
    return this.withLock(async () => {
      const state = this.readState();
      if (
        state.activeModel === model.id &&
        state.supervised === this.config.mistral.supervise &&
        await this.isMistralHealthy(model)
      ) {
        return state;
      }

      if (this.config.mistral.supervise === false) {
        // Cloud upstreams (Vercel/Cloudflare AI Gateway) fail fast — there is
        // no process to wait for, just an authenticated endpoint to probe.
        const startupTimeout = model.upstream?.url ? 15000 : this.config.mistral.startupTimeoutMs;
        await this.waitForHealthy(model, startupTimeout);
        const externalState = this.writeState({
          activeModel: model.id,
          modelId: model.modelId,
          pid: null,
          supervised: false,
          role: model.role,
          host: model.host,
          externalBaseUrl: this.mistralBaseUrl(model)
        });
        return externalState;
      }

      await this.stopCurrent();

      const args = buildMistralArgs(this.config, model);
      fs.mkdirSync(projectPath('logs'), { recursive: true });
      const out = fs.openSync(projectPath('logs/mistralrs.stdout.log'), 'a');
      const err = fs.openSync(projectPath('logs/mistralrs.stderr.log'), 'a');

      this.logger.info?.(`starting mistralrs for ${model.id}: ${this.config.mistral.command} ${args.join(' ')}`);
      this.child = spawn(this.config.mistral.command, args, {
        stdio: ['ignore', out, err],
        detached: false
      });

      const nextState = this.writeState({
        activeModel: model.id,
        modelId: model.modelId,
        pid: this.child.pid,
        supervised: true,
        startedAt: new Date().toISOString()
      });

      this.child.once('exit', (code, signal) => {
        this.logger.warn?.(`mistralrs exited code=${code} signal=${signal}`);
      });

      await this.waitForHealthy(model, this.config.mistral.startupTimeoutMs);
      return nextState;
    });
  }

  async stopCurrent() {
    const state = this.readState();
    const pid = this.child?.pid || state.pid;
    if (!pid || !isProcessAlive(pid)) {
      this.child = null;
      this.writeState({ activeModel: null, pid: null, stoppedAt: new Date().toISOString() });
      return;
    }

    this.logger.info?.(`stopping mistralrs pid ${pid}`);
    process.kill(pid, 'SIGTERM');
    await waitForProcessExit(pid, this.config.mistral.shutdownTimeoutMs);
    if (isProcessAlive(pid)) {
      this.logger.warn?.(`mistralrs pid ${pid} did not stop cleanly; sending SIGKILL`);
      process.kill(pid, 'SIGKILL');
      await waitForProcessExit(pid, 5000);
    }
    this.child = null;
    this.writeState({ activeModel: null, pid: null, stoppedAt: new Date().toISOString() });
  }

  async isMistralHealthy(model = null) {
    const selected = model || this.activeModel();
    if (selected?.upstream?.url) {
      try {
        const response = await fetch(upstreamEndpoint(this.config, selected, 'models'), {
          headers: upstreamAuthHeaders(this.config, selected),
          signal: AbortSignal.timeout(5000)
        });
        return response.ok;
      } catch {
        return false;
      }
    }
    const base = this.mistralBaseUrl(selected);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async waitForHealthy(model, timeoutMs = 180000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.isMistralHealthy(model)) return true;
      if (this.child && this.child.exitCode !== null) {
        throw new Error(`mistralrs exited during startup with code ${this.child.exitCode}`);
      }
      await delay(1000);
    }
    throw new Error(`mistralrs did not become healthy within ${timeoutMs}ms`);
  }

  async metrics(model = null) {
    const base = this.mistralBaseUrl(model || this.activeModel());
    const response = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`mistralrs metrics returned ${response.status}`);
    return response.text();
  }

  mistralBaseUrl(model) {
    return upstreamBaseUrl(this.config, model);
  }

  activeModel() {
    return modelById(this.config, this.readState().activeModel) || null;
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return { activeModel: null, pid: null };
    }
  }

  writeState(next) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const state = { ...this.readState(), ...next, updatedAt: new Date().toISOString() };
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  withLock(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }
}

export function buildMistralArgs(config, model) {
  return [
    'serve',
    '--model-id',
    model.modelId,
    '--host',
    config.mistral.host,
    '--port',
    String(config.mistral.port),
    ...(config.mistral.extraArgs || []),
    ...(model.args || [])
  ];
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await delay(250);
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
