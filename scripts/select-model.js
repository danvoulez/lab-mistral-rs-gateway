import { loadConfig } from '../src/config.js';

const config = loadConfig();
const model = process.argv[2];
if (!model) throw new Error('usage: npm run select -- <canonical-model-id>');
const base = process.env.LAB_GATEWAY_URL || config.gateway.publicBaseUrl;

const response = await fetch(`${base}/ops/models/select`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.LAB_GATEWAY_KEY || config.gateway.apiKey}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify({ model })
});

console.log(await response.text());
if (!response.ok) process.exitCode = 1;
