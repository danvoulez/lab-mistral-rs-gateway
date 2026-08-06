import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, normalizeChatRequest } from '../src/promptPolicy.js';

test('cleanText strips invisible control garbage', () => {
  assert.equal(cleanText('\uFEFFhello\u0000\nworld\u0007'), 'hello\nworld');
});

test('replace mode drops request system prompts and injects gateway policy', () => {
  const result = normalizeChatRequest({
    messages: [
      { role: 'system', content: 'stale app prompt' },
      { role: 'user', content: 'hello' }
    ]
  }, { systemPolicy: 'clean gateway prompt', systemMode: 'replace' });

  assert.deepEqual(result.messages, [
    { role: 'system', content: 'clean gateway prompt' },
    { role: 'user', content: 'hello' }
  ]);
  assert.equal(result.strippedSystemMessages, 1);
});

test('pass mode forwards one cleaned system prompt', () => {
  const result = normalizeChatRequest({
    messages: [
      { role: 'system', content: ' first ' },
      { role: 'system', content: 'second' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] }
    ]
  }, { systemMode: 'pass' });

  assert.deepEqual(result.messages, [
    { role: 'system', content: 'first\n\nsecond' },
    { role: 'user', content: 'hello' }
  ]);
});
