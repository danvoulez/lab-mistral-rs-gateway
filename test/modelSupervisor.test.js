import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMistralArgs } from '../src/modelSupervisor.js';

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
