import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, routeHeaders, verifyExecutedModel } from '../src/routing.js';
import { generateCompletion, streamCompletion } from '../src/aiProvider.js';
import { normalizeChatRequest } from '../src/promptPolicy.js';

const config = {
  models: [
    { id: 'local/qwen2.5-3b', modelId: 'default', source: 'local' },
    { id: 'vercel/openai/gpt-4.1-mini', modelId: 'openai/gpt-4.1-mini', source: 'vercel' },
    { id: 'cloudflare/@cf/openai/gpt-oss-120b', modelId: '@cf/openai/gpt-oss-120b', source: 'cloudflare', upstream: { gatewayId: 'golden-bridge' } },
  ],
};

test('requires an explicit canonical model and never consults active/default state', () => {
  assert.throws(() => resolveRoute(config, {}), (error) => error.status === 400 && error.code === 'model_required');
  assert.throws(() => resolveRoute(config, { model: 'does-not-exist' }), (error) => error.status === 404 && error.code === 'model_unknown');
  assert.equal(resolveRoute(config, { model: 'local/qwen2.5-3b' }).id, 'local/qwen2.5-3b');
});

test('pins Cloudflare gateway headers to one attempt and no cache', () => {
  const model = resolveRoute(config, { model: 'cloudflare/@cf/openai/gpt-oss-120b' });
  assert.deepEqual(routeHeaders(model), {
    'cf-aig-gateway-id': 'golden-bridge',
    'cf-aig-max-attempts': '1',
    'cf-aig-skip-cache': 'true',
  });
});

test('rejects an upstream model different from the exact requested route', () => {
  const model = resolveRoute(config, { model: 'vercel/openai/gpt-4.1-mini' });
  assert.doesNotThrow(() => verifyExecutedModel(model, 'openai/gpt-4.1-mini'));
  assert.throws(() => verifyExecutedModel(model, 'anthropic/claude-haiku-4.5'), (error) => error.status === 502 && error.code === 'route_mismatch');
});

test('makes exactly one upstream call and preserves an assistant tool call', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      model: 'default',
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      usage: { total_tokens: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const model = { id: 'local/qwen2.5-3b', modelId: 'default', source: 'local', upstream: { host: '127.0.0.1', port: 9999 } };
    const body = { model: model.id, messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'x', parameters: {} } }] };
    const result = await generateCompletion({ gateway: { requestTimeoutMs: 1000 }, mistral: {} }, model, normalizeChatRequest(body), body);
    assert.equal(calls, 1);
    assert.equal(result.message.tool_calls[0].function.name, 'x');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verifies the executed route before exposing a stream', async () => {
  const originalFetch = globalThis.fetch;
  const model = { id: 'local/qwen2.5-3b', modelId: 'default', source: 'local', upstream: { host: '127.0.0.1', port: 9999 } };
  const body = { model: model.id, messages: [{ role: 'user', content: 'x' }], stream: true };
  globalThis.fetch = async () => new Response('data: {"model":"other","choices":[]}\n\n', { status: 200 });
  try {
    await assert.rejects(
      streamCompletion({ gateway: { requestTimeoutMs: 1000 }, mistral: {} }, model, normalizeChatRequest(body), body),
      (error) => error.code === 'route_mismatch',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
