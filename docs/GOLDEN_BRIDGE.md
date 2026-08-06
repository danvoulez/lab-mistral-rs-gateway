# Golden Bridge — unified inference provider

The Golden Bridge is **one provider**: a single URL, a single key, one model
namespace and one receipt format. Behind it live two local executors (LAB 8GB
small, LAB 512 large, joined by the point-to-point Ethernet cable) and cloud
models via AI gateways. Consumers never see the parts — only the provider.

```text
consumers
  |
  |  1 URL:  https://inference.minilab.work/v1      (internet, Cloudflare Access)
  |          http://192.168.0.200:8787/v1           (LAB Wi-Fi, bearer)
  |          http://10.88.0.9:8787/v1               (cable side, bearer)
  |          http://127.0.0.1:8787/v1               (loopback, trusted)
  |
  v
Golden Bridge gateway  (LAB 8GB, local.lab-mistral-gateway, 0.0.0.0:8787)
  |
  +-- qwen2.5-3b            local   127.0.0.1:8392        Qwen2.5 3B Q4_K_M      cost: compute only
  +-- mistral-nemo-q4       cable   10.88.0.10:1234       Mistral Nemo 12B       cost: compute only
  +-- gpt-4.1-mini          cloud   Vercel AI Gateway     openai/gpt-4.1-mini    cost: compute + USD
  +-- claude-haiku-4.5      cloud   Vercel AI Gateway     anthropic/...          cost: compute + USD
  +-- gemini-2.5-flash      cloud   Vercel AI Gateway     google/...             cost: compute + USD
```

LAB 512 role: large inference only, exposed **only** on the cable
(`10.88.0.10:1234`) — never on Wi-Fi, never on the internet.
LAB 8GB role: gateway/provider front, small metabolism inference, MCP, UI backend.

## Signs

Use these as the authoritative labels:

- Provider name: `golden-bridge`
- Single URL: `https://inference.minilab.work/v1`
- Single key (internet): one Cloudflare Access service-token pair
  (`CF-Access-Client-Id` + `CF-Access-Client-Secret`)
- LAN key: gateway bearer token (`runtime/gateway-token`)
- Default model: `qwen2.5-3b` (local, free)
- Large local model: `mistral-nemo-q4`
- Cloud models: `gpt-4.1-mini`, `claude-haiku-4.5`, `gemini-2.5-flash`
  (role `cloud` — never the default; chosen only by explicit `model`)
- Upstream model name (local executors): `default`
- Protected service: `com.project-manhattan.agent`
- Manhattan policy marks old `com.minilab.llm-gateway` as retired and superseded by `golden-bridge`

## Auth model (one key per consumer)

- **Internet:** Cloudflare Access app `Golden Bridge — inference.minilab.work`,
  policy "Service Token Required". Requests arrive at the gateway via
  cloudflared from loopback, already authenticated — the gateway trusts
  loopback origins for `/v1/chat/completions` and does not re-ask for the
  bearer.
- **LAN (Wi-Fi/cable):** bearer required. Non-loopback callers without a
  valid bearer get `401`.
- **Ops endpoints** (`/ops/*`, `/metrics`) always require the bearer, even
  from loopback.

## The receipt (cost AND compute charged to the client)

Every non-streaming chat response carries:

- Headers: `x-lab-cost-usd`, `x-lab-compute-ms`, `x-lab-request-id`, `x-lab-prompt-hash`
- Body `lab`: `{client, cost_usd, compute_ms, tokens_total, routed_model, upstream_ms, ...}`

Units:

- `cost_usd` — money, estimated from `config.prices` (USD per 1M tokens,
  editable; local models = 0). Exact per-client billing is available by
  issuing one Vercel AI Gateway key per client and mapping it in the gateway.
- `compute_ms` — model time. Local: real GPU time (llama.cpp `timings`).
  Cloud: upstream wall time (providers expose tokens, not GPU time).
- `tokens_total` — the compute unit common to both worlds.

Client identity: Access JWT `common_name`/service-token id (tunnel — the
edge consumes `CF-Access-Client-*` headers, so identity arrives via
`CF-Access-Jwt-Assertion`), named bearer from `runtime/clients.json` (LAN,
chmod 600), `X-Lab-Client` header or `local` (loopback). Per-client
aggregates:

```bash
curl -H "Authorization: Bearer <key>" http://192.168.0.200:8787/ops/costs
```

## Lights

Provider manifest:

```bash
curl http://192.168.0.200:8787/
```

Gateway health (all upstreams, local and cloud):

```bash
curl http://192.168.0.200:8787/health
```

Full bridge state:

```bash
curl -H "Authorization: Bearer <key>" http://192.168.0.200:8787/ops/bridge
```

Prometheus-style metrics:

```bash
curl -H "Authorization: Bearer <key>" http://192.168.0.200:8787/metrics
```

One-command status:

```bash
npm run bridge:status
```

Manhattan-facing sidecar:

```bash
npm run bridge:manhattan -- status --pretty
```

Watchdog check:

```bash
npm run bridge:watchdog
```

The watchdog writes:

```text
runtime/bridge-watchdog.json
```

## Enforcements

The config refuses to start if:

- `mistral.host` does not point at LAB 512 `10.88.0.10`
- `mistral.supervise` is not `false`
- `defaultModel` is not one of the declared model profiles
- the `inference-512` model does not point at the bridge IP, or the
  `metabolism` model is not local
- the gateway listens beyond loopback without a bearer token configured

The gateway strips incoming system prompts by default and injects
`config/system-policy.txt` — uniformly, for local and cloud models.

The gateway logs request metadata to:

```text
logs/gateway-requests.jsonl
```

It logs no prompt text. It logs request id, client, model, upstream model,
prompt hash, durations, usage, cost_usd, compute_ms, and failures.

Secrets never live in `lab-block.json`: API keys in `runtime/keys/*` and the
client-token map in `runtime/clients.json`, all chmod 600.

## Sticky route (read before automating)

The selected route **sticks**: after any request names a `model`, requests
without a `model` field keep going to that model until another is selected
(`/ops/models/select`). Automations that must stay free/local should always
pass `model` explicitly — after any cloud call, bare requests burn money
until the route is reset to `qwen2.5-3b`.

## Full Vercel catalog (passthrough)

`config.cloud.catalogPassthrough` is on: any `provider/model` id from the
Vercel AI Gateway catalog (**316 models** as of 2026-08-06 — openai,
anthropic, google, meta, mistral, xai, ...) can be requested directly in the
`model` field, with no entry in `models[]`. Unknown ids fail cleanly with the
upstream's 400/404. Cost note: `cost_usd` is only estimated for ids present
in `config.prices`; tokens and `compute_ms` are always logged. Cloud guardrail
still applies: catalog ids are never the default — always an explicit choice.

List the live catalog:

```bash
curl -H "Authorization: Bearer $(cat runtime/keys/vercel-ai-gateway)" \
  https://ai-gateway.vercel.sh/v1/models
```

## Getting the single key (Cloudflare Access service token)

The internet key is a Cloudflare Access **service-token pair**
(`CF-Access-Client-Id` + `CF-Access-Client-Secret`), authorized on the
`Golden Bridge — inference.minilab.work` app:

1. Existing token `8525052c-c54a-46f3-89bc-606019ed18fd` is already
   authorized — reuse it if you have its id/secret pair stored (secrets are
   only shown once, at creation).
2. Or create a dedicated one: Zero Trust dashboard → **Access → Service
   auth → Service tokens → Create** (name suggestion: `golden-bridge-client`),
   then add its token id to the Access app's policy.
3. Or via API: needs a token with **Access: Service Tokens → Edit** (the
   2026-08-06 token lacks it — app/policy management works, service-token
   creation returns `Authentication error`).

Usage:

```bash
curl https://inference.minilab.work/v1/chat/completions \
  -H "CF-Access-Client-Id: <id>.access" \
  -H "CF-Access-Client-Secret: <secret>" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5-3b","messages":[{"role":"user","content":"ping"}]}'
```

## Guardrails

Never run the large Mistral model on LAB 8GB.

Never point clients directly at LAB 512 except for operator diagnostics.

Never expose LAB 512 inference beyond the cable (`10.88.0.10:1234` only).

Never make a cloud model the default or the sticky route in automation.

Never remove or stop Manhattan:

```text
com.project-manhattan.agent
```

ActGraph test services have been removed from active LAB 8GB paths. If they reappear, treat that as drift:

```text
com.minilab.actgraph
com.minilab.actgraph-mcp-http
actions.runner.danvoulez-ActGraph.lab-8gb-capital
```

## Drift Response

1. Run `npm run bridge:status`.
2. Run `npm run bridge:manhattan -- status --pretty`.
3. Check `runtime/bridge-watchdog.json`.
4. Check `/ops/bridge`.
5. Confirm LAB 512 direct health: `curl http://10.88.0.10:1234/health`.
6. Confirm LAB 8GB gateway health: `curl http://192.168.0.200:8787/health`.
7. Read `docs/AUDIT.md` before deleting or disabling anything.

If direct LAB 512 inference is clean but gateway inference hangs, the problem is on LAB 8GB.

If LAB 512 direct inference is dirty, restart only `com.minilab.mistralrs-serve`:

```bash
ssh lab-512 'launchctl kickstart -k gui/$(id -u)/com.minilab.mistralrs-serve'
```

If the service crash-loops with `dyld: Library not loaded:
@rpath/libllama-server-impl.dylib`, the binary's rpath drifted again (see
changelog 2026-08-06): it must contain `@executable_path`, not the deleted
`~/m1-llm-runtime` path. Fix with `install_name_tool` + ad-hoc `codesign`;
backup at `golden-bridge/bin/llama-server.bak-20260806` on LAB 512.

If the gateway answers on Wi-Fi but not via
`https://inference.minilab.work`, check the tunnel `lab8gb` ingress — note
the live config is **`/etc/cloudflared/config.yml`** (system daemon
`work.minilab.cloudflared`; the `~/.cloudflared/config.yml` copy is legacy)
— and the Access app: DNS CNAME `inference.minilab.work →
2b7bc384….cfargotunnel.com` must exist and stay proxied, and the app policy
must use action **Service Auth** (`non_identity` in the API) — with `allow`,
Access validates the token but still redirects to the IdP login (302).

## Changelog

### 2026-08-06 — the day the bridge actually came up

- **Root cause of "never worked":** `llama-server` on LAB 512 crash-looped
  since 2026-07-26 (`dyld: Library not loaded:
  @rpath/libllama-server-impl.dylib`) because its rpath still pointed at the
  deleted `~/m1-llm-runtime/llama.cpp/build/bin`. Fixed with
  `install_name_tool -add_rpath @executable_path` + ad-hoc codesign.
- Gateway bind widened from `10.88.0.9` (cable only, racy at boot —
  `EADDRNOTAVAIL`) to `0.0.0.0`, adding the Wi-Fi leg.
- Internet leg: `inference.minilab.work` via tunnel `lab8gb` + Cloudflare
  Access (service token). Tunnel `lab-8gb-inference` (id `92c0ee9b…`) created
  for the raw small-model endpoint, remotely managed.
- Cloud upstreams added (Vercel AI Gateway, 316-model catalog; 3 enabled).
  Supervisor made cloud-aware: no more `/health` wait + 15-min lock on cloud
  calls.
- Single-credential rule: loopback origin (tunnel/local) skips bearer on
  `/v1/chat/completions`; LAN and `/ops/*` keep requiring it.
- Cost + compute charged to the client per request; `/ops/costs` aggregates
  per client. `qwen2.5-3b` renamed from `metabolism-qwen2.5-3b` (original
  names kept for eval comparability).
- Self-SSH checks in `bridge:status` fixed (local `authorized_keys` +
  `Host 10.88.0.9` block with `IdentitiesOnly`).
