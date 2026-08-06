# Founder Guide: Golden Bridge

This guide is for using the LAB local inference infrastructure correctly without accidentally waking old experiments, dirty prompt paths, or duplicate gateways.

## The One Sentence

Use the LAB 8GB gateway, and let it route over the Ethernet cable to LAB 512 inference.

```text
requester -> LAB 8GB gateway -> Ethernet cable -> LAB 512 mistral.rs/model
```

Do not point products, agents, or experiments directly at LAB 512 unless you are diagnosing the bridge.

## The Canonical Endpoint

Use this as the OpenAI-compatible base URL:

```text
http://10.88.0.9:8787/v1
```

Use this model name:

```text
mistral-nemo-q4
```

The gateway maps that to LAB 512 upstream model:

```text
default
```

## Mental Model

LAB 512 is the engine room.

- Holds the model in memory
- Runs `mistralrs`
- Listens at `10.88.0.10:1234`
- Service: `com.minilab.mistralrs-serve`

LAB 8GB is the bridge booth.

- Does not hold inference
- Does not run `mistralrs`
- Cleans/controls prompt boundary
- Routes requests to LAB 512
- Listens at `10.88.0.9:8787`
- Service: `local.lab-mistral-gateway`

Manhattan is the survival layer.

- Do not stop it casually
- Do not delete it
- It knows the bridge IPs
- It marks the old `com.minilab.llm-gateway` as retired

## Basic Use

### curl

```bash
curl http://10.88.0.9:8787/v1/chat/completions \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-nemo-q4",
    "messages": [
      { "role": "user", "content": "Say hello from the golden bridge." }
    ],
    "temperature": 0,
    "max_tokens": 64
  }'
```

### OpenAI SDK Shape

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://10.88.0.9:8787/v1',
  apiKey: process.env.LAB_GATEWAY_KEY
});

const response = await client.chat.completions.create({
  model: 'mistral-nemo-q4',
  messages: [{ role: 'user', content: 'Are you alive?' }]
});
```

## Daily Health Check

Run this first:

```bash
npm run bridge:watchdog
```

Healthy means:

```text
"ok": true
```

For a fuller view:

```bash
npm run bridge:status
```

For Manhattan-style bridge checks:

```bash
npm run bridge:manhattan -- status --pretty
```

Or directly:

```bash
curl http://10.88.0.9:8787/health
curl -H "Authorization: Bearer <key>" http://10.88.0.9:8787/ops/bridge
```

## What The Lights Mean

Good signs:

- `upstreamHealthy: true`
- `supervised: false`
- `externalBaseUrl: http://10.88.0.10:1234`
- `systemMode: replace`
- `activeModel: mistral-nemo-q4`
- `routed_model: default`

Bad signs:

- LAB 8GB running `mistralrs`
- `supervised: true` on LAB 8GB
- model name is Qwen, SmolLM, or anything not `mistral-nemo-q4`
- gateway points to `127.0.0.1:1234` on LAB 8GB
- ActGraph launch labels reappear
- `com.minilab.llm-gateway` reappears as active

## Prompt Cleanliness

The gateway uses:

```text
systemMode: replace
```

That means caller system prompts are stripped and replaced by:

```text
config/system-policy.txt
```

This is intentional. It prevents old agents, old tests, or old UIs from smuggling stale system instructions into the model.

The gateway does not log prompt text. It logs prompt hashes and request metadata.

Request log:

```text
logs/gateway-requests.jsonl
```

## Do Not Touch

Do not stop or remove:

```text
com.project-manhattan.agent
com.project-manhattan.daemon
com.minilab.mistralrs-serve
local.lab-mistral-gateway
local.lab-bridge-watchdog
```

Do not run:

```text
mistralrs
```

on LAB 8GB.

Do not resurrect:

```text
com.minilab.llm-gateway
com.minilab.actgraph
com.minilab.actgraph-mcp-http
actions.runner.danvoulez-ActGraph.lab-8gb-capital
```

## If It Feels Dirty

Dirty means the model repeats garbage, answers in the wrong language, ignores the request, or seems to carry old instructions.

Check in this order:

1. Run `npm run bridge:watchdog`.
2. Run `npm run bridge:manhattan -- status --pretty`.
3. Check `curl -H "Authorization: Bearer <key>" http://10.88.0.9:8787/ops/bridge`.
4. Confirm `systemMode` is `replace`.
5. Confirm LAB 8GB has `supervised: false`.
6. Confirm LAB 512 direct health: `curl http://10.88.0.10:1234/health`.
7. Confirm the LAB 512 service args include `--prefix-cache-n 0`.

The LAB 512 service must include:

```text
--prefix-cache-n 0
--max-seqs 1
--max-batch-size 1
--max-seq-len 4096
```

If prefix cache comes back, dirty behavior may come back.

## If It Is Down

First identify which side is down.

Gateway side:

```bash
curl http://10.88.0.9:8787/health
```

Inference side:

```bash
curl http://10.88.0.10:1234/health
```

If gateway is down, restart only on LAB 8GB:

```bash
launchctl kickstart -k gui/$(id -u)/local.lab-mistral-gateway
```

If inference is down, restart only on LAB 512:

```bash
launchctl kickstart -k gui/$(id -u)/com.minilab.mistralrs-serve
```

If Manhattan is down, use Manhattan controls deliberately. Do not improvise around it.

## If You Need To Change The Model

Treat this as infrastructure work, not a casual prompt change.

1. Update `config/lab-block.json`.
2. Update `docs/GOLDEN_BRIDGE.md`.
3. Update this guide.
4. Confirm LAB 512 can load the model cleanly.
5. Confirm LAB 8GB still has `mistral.supervise: false`.
6. Run `npm test`.
7. Run `npm run bridge:watchdog`.
8. Run one end-to-end inference through `10.88.0.9:8787`.

Do not add a second model server on another port as a shortcut.

## Where The Truth Lives

Use these files as the source of truth:

```text
docs/FOUNDER_GUIDE.md
docs/GOLDEN_BRIDGE.md
docs/AUDIT.md
config/lab-block.json
services/com.minilab.mistralrs-serve.plist
services/lab-mistral-gateway.plist
services/lab-bridge-watchdog.plist
```

## The Founder Rule

If there are two paths, one of them is already a bug.

The golden bridge is valuable because it is boring:

```text
one model host
one cable
one gateway
one model name
one health story
one audit trail
```
