import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatRequest } from '../src/promptPolicy.js';
import { toUpstreamBody } from '../src/aiProvider.js';

const body = {
  model: 'vercel/openai/gpt-4.1-mini',
  messages: [
    { role: 'system', content: 'Dream system' },
    { role: 'user', content: 'Formalize Q3' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_process_contract', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
  ],
  tools: [{ type: 'function', function: { name: 'read_process_contract', description: 'read law', parameters: { type: 'object' } } }],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } },
  temperature: 0,
  top_p: 0.9,
  max_tokens: 0,
  stop: ['END'],
  seed: 42,
  user: 'dream',
  stream: false,
};

test('forwards tools, schema, messages and generation parameters without loss', () => {
  const model = { id: body.model, modelId: 'openai/gpt-4.1-mini', source: 'vercel', maxOutputTokens: 1024 };
  const normalized = normalizeChatRequest(body);
  const upstream = toUpstreamBody(model, normalized, body, false);

  const expected = {
    ...body,
    model: 'openai/gpt-4.1-mini',
    providerOptions: { gateway: { only: ['openai'] } },
  };
  assert.deepEqual(upstream, expected);
  assert.equal(upstream.max_tokens, 0);
  assert.deepEqual(upstream.messages, body.messages);
});

test('does not add defaults the client did not request', () => {
  const body = { model: 'local/qwen2.5-3b', messages: [{ role: 'user', content: 'hello' }] };
  const model = { id: body.model, modelId: 'default', source: 'local', maxOutputTokens: 512 };
  const upstream = toUpstreamBody(model, normalizeChatRequest(body), body, false);
  assert.deepEqual(upstream, { ...body, model: 'default', stream: false });
  assert.equal('temperature' in upstream, false);
  assert.equal('max_tokens' in upstream, false);
});

test('fails before dispatch when a model explicitly declares a requested capability unsupported', () => {
  const body = { model: 'local/no-tools', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'x', parameters: {} } }] };
  const model = { id: body.model, modelId: 'default', source: 'local', capabilities: { tools: false } };
  assert.throws(() => toUpstreamBody(model, normalizeChatRequest(body), body, false), (error) => error.code === 'model_capability_mismatch');
});
