# LAB Mistral.rs Gateway

This repository makes the fixed LAB block obvious and repeatable:

`LAB 512 mistral.rs/model -> Ethernet cable -> LAB 8GB gateway -> requester`

The gateway exposes an OpenAI-compatible `/v1/chat/completions` endpoint on LAB 8GB. Internally it is a deterministic HTTP forwarder to mistral.rs running on LAB 512 at `10.88.0.10:1234`.

## Why This Exists

- One place to see the active model: `GET /ops/state`
- One place to see the whole route: `GET /ops/bridge`
- One way to change models: `POST /ops/models/select`
- LAB 8GB never holds inference: it only routes to LAB 512 over the cable
- Clean prompt boundary: no hidden memory, no persisted messages, no old system prompt leakage
- Observable runtime: gateway metrics plus mistral.rs `/metrics`

Start with [docs/FOUNDER_GUIDE.md](docs/FOUNDER_GUIDE.md), then use [docs/GOLDEN_BRIDGE.md](docs/GOLDEN_BRIDGE.md) for operator signs, lights, and guardrails.

## LAB 512 Inference Host

LAB 512 runs the model and `mistralrs`:

```bash
mistralrs serve \
  --host 10.88.0.10 --port 1234 \
  --prefix-cache-n 0 --max-seqs 1 --max-batch-size 1 --max-seq-len 4096 \
  auto -m /Users/danvoulez/models --format gguf -f Mistral-Nemo-Instruct-2407-Q4_K_M.gguf
```

## LAB 8GB Gateway

```bash
pnpm install
npm run doctor
npm start
```

Operational checks:

```bash
npm run bridge:status
npm run bridge:watchdog
npm run bridge:manhattan -- status --pretty
```

Packaging and rebuild instructions live in [docs/REBUILD.md](docs/REBUILD.md).
The Manhattan sidecar is documented in [docs/MANHATTAN_MINI_CLI.md](docs/MANHATTAN_MINI_CLI.md).

Useful runtime overrides:

```bash
LAB_GATEWAY_HOST=127.0.0.1 LAB_GATEWAY_PORT=8787 npm start
MISTRAL_SUPERVISE=false npm start
```

Set `config/lab-block.json` before running permanently:

- `gateway.publicBaseUrl`: the LAB 8GB Ethernet address, for this cable `http://10.88.0.9:8787`
- `mistral.host`: the LAB 512 Ethernet address, for this cable `10.88.0.10`
- `mistral.supervise`: `false` on LAB 8GB
- `gateway.apiKey`: replace `change-me-lab-cable`
- `models`: the approved model profiles

## LAB 512 Client Endpoint

Point clients on LAB 512 at:

```text
baseURL: http://10.88.0.9:8787/v1
apiKey: <gateway.apiKey>
model: mistral-nemo-q4
```

Smoke test from LAB 512:

```bash
LAB_GATEWAY_URL=http://10.88.0.9:8787 LAB_GATEWAY_KEY=<key> npm run smoke
```

## Model Changes

```bash
LAB_GATEWAY_URL=http://10.88.0.9:8787 LAB_GATEWAY_KEY=<key> npm run select -- mistral-nemo-q4
```

Model memory lives on LAB 512. LAB 8GB is gateway-only.

## Prompt Policy

The default `gateway.systemMode` is `replace`. Incoming request system messages are stripped and replaced by `config/system-policy.txt`. Change the mode only deliberately:

- `replace`: gateway policy is the only system prompt
- `prepend`: gateway policy plus request system prompt
- `pass`: request system prompt only

Request content is not logged. The gateway returns a `lab.prompt_hash` so you can correlate behavior without storing private prompts.

## References

- mistral.rs serves OpenAI-compatible `/v1` endpoints and exposes `/metrics` and `/health`.
- LAB 8GB is deliberately a thin gateway. Keep provider SDKs out of the hot path unless there is a tested reason to add them.
