import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../config/lab-block.json', import.meta.url), 'utf8'));

test('configures only the Cloudflare model that passed dream-agent.v1 live acceptance', () => {
  const cloudflare = config.models.filter((model) => model.source === 'cloudflare');
  assert.equal(cloudflare.length, 1);
  assert.deepEqual(cloudflare[0], {
    id: 'cloudflare/@cf/openai/gpt-oss-120b',
    modelId: '@cf/openai/gpt-oss-120b',
    source: 'cloudflare',
    kind: 'text',
    role: 'cloud',
    host: 'cloudflare-ai-gateway',
    upstream: {
      url: `https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.accountId}/ai/v1`,
      key: config.cloudflare.key,
      gatewayId: config.cloudflare.gatewayId,
    },
    capabilities: { tools: true, response_format: true },
    maxOutputTokens: 1024,
    notes: 'GPT-OSS 120B via o AI Gateway golden-bridge. Certificado por envelope vivo; nunca default e sem fallback.',
  });
  assert.deepEqual(config.prices[cloudflare[0].id], { input: 0.35, output: 0.75 });
});
