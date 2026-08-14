import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMistralArgs, ModelSupervisor } from '../src/modelSupervisor.js';
import { upstreamHealthEndpoint } from '../src/config.js';

test('buildMistralArgs pins one serve process to one model', () => {
  const args = buildMistralArgs({
    mistral: {
      host: '127.0.0.1',
      port: 1234,
      extraArgs: ['--prefix-cache-n', '0', '--max-seqs', '1']
    }
  }, {
    id: 'mistral-nemo',
    modelId: 'default',
    args: ['auto', '-m', '/Users/danvoulez/models', '--format', 'gguf', '-f', 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf']
  });

  assert.deepEqual(args, [
    'serve',
    '--model-id',
    'default',
    '--host',
    '127.0.0.1',
    '--port',
    '1234',
    '--prefix-cache-n',
    '0',
    '--max-seqs',
    '1',
    'auto',
    '-m',
    '/Users/danvoulez/models',
    '--format',
    'gguf',
    '-f',
    'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf'
  ]);
});

test('does not wait for a mistral process when the selected route is an external upstream', async () => {
  const supervisor = new ModelSupervisor({ mistral: { supervise: false } });
  let healthWaits = 0;
  supervisor.readState = () => ({ activeModel: null, pid: null });
  supervisor.writeState = (state) => state;
  supervisor.waitForHealthy = async () => { healthWaits += 1; };

  const state = await supervisor.ensureModel({
    id: 'cloudflare/@cf/openai/gpt-oss-120b',
    modelId: '@cf/openai/gpt-oss-120b',
    source: 'cloudflare',
    role: 'cloud',
    host: 'cloudflare-ai-gateway',
    upstream: { url: 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1' },
  });

  assert.equal(healthWaits, 0);
  assert.equal(state.activeModel, 'cloudflare/@cf/openai/gpt-oss-120b');
  assert.equal(state.pid, null);
});

test('uses the real Workers AI catalog endpoint for Cloudflare health', () => {
  const config = { cloudflare: { accountId: 'account' } };
  const cloudflare = {
    source: 'cloudflare',
    upstream: { url: 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1' },
  };
  const vercel = {
    source: 'vercel',
    upstream: { url: 'https://ai-gateway.vercel.sh/v1' },
  };

  assert.equal(
    upstreamHealthEndpoint(config, cloudflare),
    'https://api.cloudflare.com/client/v4/accounts/account/ai/models/search',
  );
  assert.equal(upstreamHealthEndpoint(config, vercel), 'https://ai-gateway.vercel.sh/v1/models');
});
