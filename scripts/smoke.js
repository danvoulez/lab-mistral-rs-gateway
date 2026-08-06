import { loadConfig } from '../src/config.js';

const config = loadConfig();
const base = process.env.LAB_GATEWAY_URL || config.gateway.publicBaseUrl || `http://127.0.0.1:${config.gateway.port}`;
const prompt = process.argv.slice(2).join(' ') || 'Reply with exactly: LAB gateway is alive';

const response = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.LAB_GATEWAY_KEY || config.gateway.apiKey}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    model: process.env.LAB_MODEL || config.defaultModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 64
  })
});

console.log(await response.text());
if (!response.ok) process.exitCode = 1;
