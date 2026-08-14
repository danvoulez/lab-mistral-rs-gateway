import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogService, createDreamAgentCertifier } from '../src/catalog.js';

const config = {
  gateway: { requestTimeoutMs: 1000 },
  models: [
    { id: 'local/qwen', modelId: 'qwen', source: 'local', upstream: { host: '127.0.0.1', port: 8392 } },
    { id: 'vercel/openai/gpt-test', modelId: 'openai/gpt-test', source: 'vercel', upstream: { url: 'https://ai-gateway.vercel.sh/v1', key: 'vercel' } },
  ],
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('publishes only live candidates with a current complete certification', async () => {
  const calls = [];
  const service = createCatalogService(config, {
    now: () => new Date('2026-08-14T10:00:00.000Z'),
    readKey: () => 'secret',
    fetch: async (url) => {
      calls.push(url);
      if (url === 'https://ai-gateway.vercel.sh/v1/models') {
        return json({ data: [{ id: 'openai/gpt-test', type: 'language', name: 'GPT Test' }, { id: 'image/not-llm', type: 'image' }] });
      }
      if (url.endsWith('/health')) return json({ ok: true });
      if (url.endsWith('/v1/models')) return json({ data: [{ id: 'qwen' }] });
      throw new Error(`unexpected ${url}`);
    },
    certify: async (model) => ({
      profile: 'dream-agent.v1',
      passed: model.id === 'local/qwen',
      checks: { conversation: true, tool_call: true, tool_result: true, schema: true, system_prompt: true },
    }),
  });

  const catalog = await service.read({ refresh: true });

  assert.deepEqual(catalog.sources.map(({ id, status }) => ({ id, status })), [
    { id: 'local', status: 'available' },
    { id: 'vercel', status: 'available' },
    { id: 'cloudflare', status: 'not_configured' },
  ]);
  assert.equal(catalog.data.find((model) => model.id === 'local/qwen').selectable, true);
  assert.equal(catalog.data.find((model) => model.id === 'vercel/openai/gpt-test').selectable, false);
  assert.equal(catalog.data.some((model) => model.id === 'vercel/image/not-llm'), false);
  assert.deepEqual(calls, [
    'http://127.0.0.1:8392/health',
    'http://127.0.0.1:8392/v1/models',
    'https://ai-gateway.vercel.sh/v1/models',
  ]);
});

test('never serves stale or configured guesses after a source refresh fails', async () => {
  let healthy = true;
  let current = new Date('2026-08-14T10:00:00.000Z');
  const service = createCatalogService({ ...config, models: [config.models[0]] }, {
    ttlMs: 1000,
    now: () => current,
    fetch: async (url) => {
      if (!healthy) throw new Error('offline');
      return url.endsWith('/health') ? json({ ok: true }) : json({ data: [{ id: 'qwen' }] });
    },
    certify: async () => ({
      profile: 'dream-agent.v1',
      passed: true,
      checks: { conversation: true, tool_call: true, tool_result: true, schema: true, system_prompt: true },
    }),
  });

  assert.equal((await service.read({ refresh: true })).data.length, 1);
  healthy = false;
  current = new Date('2026-08-14T10:00:02.000Z');
  const degraded = await service.read();
  assert.equal(degraded.sources[0].status, 'degraded');
  assert.equal(degraded.data.length, 0);
  assert.throws(() => service.requireSelectable('local/qwen'), (error) => error.code === 'model_unavailable');
});

test('keeps a healthy local model selectable while reporting its failed sibling honestly', async () => {
  const localConfig = {
    ...config,
    models: [
      config.models[0],
      { id: 'local/offline', modelId: 'offline', source: 'local', upstream: { host: '127.0.0.1', port: 9999 } },
    ],
  };
  const service = createCatalogService(localConfig, {
    fetch: async (url) => {
      if (url.includes(':9999')) throw new Error('connection refused');
      return url.endsWith('/health') ? json({ ok: true }) : json({ data: [{ id: 'qwen' }] });
    },
    certify: async () => ({
      profile: 'dream-agent.v1', passed: true,
      checks: { conversation: true, tool_call: true, tool_result: true, schema: true, system_prompt: true },
    }),
  });

  const catalog = await service.read({ refresh: true });
  assert.equal(catalog.sources[0].status, 'degraded');
  assert.match(catalog.sources[0].message, /local\/offline/);
  assert.deepEqual(catalog.data.map((model) => model.id), ['local/qwen']);
  assert.equal(catalog.data[0].selectable, true);
});

test('imports configured Workers AI candidates only when account, token, gateway and live catalog agree', async () => {
  const cloudflare = {
    accountId: 'account',
    gatewayId: 'golden-bridge',
    key: 'cloudflare',
  };
  const model = {
    id: 'cloudflare/@cf/meta/llama-test',
    modelId: '@cf/meta/llama-test',
    source: 'cloudflare',
    upstream: { url: 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1', key: 'cloudflare', gatewayId: 'golden-bridge' },
  };
  const service = createCatalogService({ ...config, cloudflare, models: [model] }, {
    readKey: () => 'secret',
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/account/ai/models/search');
      assert.equal(init.headers.authorization, 'Bearer secret');
      return json({ success: true, result: [{ name: '@cf/meta/llama-test', task: { name: 'Text Generation' } }] });
    },
    certify: async () => ({
      profile: 'dream-agent.v1', passed: true,
      checks: { conversation: true, tool_call: true, tool_result: true, schema: true, system_prompt: true },
    }),
  });

  const catalog = await service.read({ refresh: true });
  assert.equal(catalog.sources.find((source) => source.id === 'cloudflare').status, 'available');
  assert.equal(catalog.data[0].id, model.id);
  assert.equal(catalog.data[0].selectable, true);
});

test('dream-agent.v1 certification proves the complete transport contract instead of trusting model metadata', async () => {
  const requests = [];
  const certify = createDreamAgentCertifier(async (_model, body) => {
    requests.push(body);
    if (requests.length === 1) return { role: 'assistant', content: 'DREAM_SYSTEM_OK' };
    if (requests.length === 2) {
      return { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'catalog_probe', arguments: '{"value":"ok"}' } }] };
    }
    return { role: 'assistant', content: '{"system":"DREAM_SYSTEM_OK","tool_result":"TOOL_RESULT_OK"}' };
  });

  const result = await certify({ id: 'local/qwen', modelId: 'qwen', source: 'local' });

  assert.equal(result.profile, 'dream-agent.v1');
  assert.equal(result.passed, true);
  assert.deepEqual(result.checks, { conversation: true, tool_call: true, tool_result: true, schema: true, system_prompt: true });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].messages[2].role, 'assistant');
  assert.equal(requests[2].messages[3].role, 'tool');
  assert.equal(requests[2].response_format.type, 'json_schema');
});
