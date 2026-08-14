import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatRequest } from '../src/promptPolicy.js';

test('preserves the complete conversation envelope byte-for-byte at the JSON value level', () => {
  const messages = [
    { role: 'system', content: '  Dream owns this prompt.\nDo not trim it.  ', name: 'dream' },
    { role: 'user', content: [{ type: 'text', text: 'create Q3' }, { type: 'image_url', image_url: { url: 'https://example.invalid/q3.png' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_process_contract', arguments: '{"process_id":"projection-build.v1"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'read_process_contract', content: '{"ok":true}' },
  ];

  const result = normalizeChatRequest({ messages });

  assert.deepEqual(result.messages, messages);
  assert.equal(result.messages[0].content.startsWith('  '), true);
  assert.equal(result.messages[0].content.endsWith('  '), true);
  assert.match(result.promptHash, /^[0-9a-f]{64}$/);
  assert.equal('systemMode' in result, false);
  assert.equal('strippedSystemMessages' in result, false);
});

test('rejects malformed messages without rewriting valid content', () => {
  assert.throws(() => normalizeChatRequest({ messages: [] }), /messages must be a non-empty array/);
  assert.throws(() => normalizeChatRequest({ messages: [{ role: 'root', content: 'x' }] }), /role is not supported/);
  assert.throws(() => normalizeChatRequest({ messages: [{ role: 'user', content: 42 }] }), /content/);
});
