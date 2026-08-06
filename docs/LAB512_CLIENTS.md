# LAB 512 Clients

Use the gateway exactly like an OpenAI-compatible API.

## curl

```bash
curl http://10.88.0.9:8787/v1/chat/completions \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-nemo-q4",
    "messages": [{"role": "user", "content": "Say hello from the cable."}],
    "temperature": 0,
    "max_tokens": 64
  }'
```

## OpenAI SDK Style

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://10.88.0.9:8787/v1',
  apiKey: process.env.LAB_GATEWAY_KEY
});

const response = await client.chat.completions.create({
  model: 'mistral-nemo-q4',
  messages: [{ role: 'user', content: 'What model are you?' }]
});
```

## Streaming

Set `"stream": true`. The gateway returns standard `chat.completion.chunk` server-sent events and ends with `[DONE]`.
