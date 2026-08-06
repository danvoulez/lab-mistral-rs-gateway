# Operations

## Normal Boot

1. Connect LAB 512 and LAB 8GB with Ethernet.
2. Confirm LAB 512 is `10.88.0.10` and LAB 8GB is `10.88.0.9`.
3. On LAB 512, start `mistralrs serve` on `10.88.0.10:1234`.
4. On LAB 8GB, start the gateway with `npm start` or the service file in `services/`.
5. From any requester, call `http://10.88.0.9:8787/v1/chat/completions`.

## Health Checks

```bash
curl -H "Authorization: Bearer <key>" http://10.88.0.9:8787/ops/state
curl -H "Authorization: Bearer <key>" http://10.88.0.9:8787/ops/bridge
curl -H "Authorization: Bearer <key>" http://10.88.0.9:8787/metrics
curl http://10.88.0.9:8787/health
npm run bridge:status
npm run bridge:watchdog
```

`/health` is intentionally unauthenticated so local uptime tools can check it. Operational state and metrics require the bearer token.

## When It Feels Dirty

Check these in order:

1. `gateway.systemMode` in `config/lab-block.json`
2. `config/system-policy.txt`
3. `lab.prompt_hash` in responses
4. `logs/mistralrs.stderr.log`
5. `runtime/mistral-state.json`

The gateway does not store chat history. LAB 8GB also does not hold inference. If stale behavior appears, it is either in the request body, the configured system policy, the model weights, or the LAB 512 model server process.

Request metadata is written to `logs/gateway-requests.jsonl`. Prompt text is not logged; use `lab.prompt_hash` and `x-lab-request-id` to correlate a request.

## Model RAM Rule

Never start mistral.rs on LAB 8GB. It is gateway-only. The one mistral.rs server belongs on LAB 512.

```bash
npm run select -- mistral-nemo-q4
```

The supervisor uses one child process and one port. A model change means stop, wait, start, health check.
