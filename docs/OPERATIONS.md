# Golden Bridge Operations

Golden Bridge is the only inference provider exposed to Dream. It transports one explicitly selected canonical model request to one exact upstream route. It does not own Dream's system prompt, tools, LogLine semantics or fallback policy.

## Runtime truth

- Active checkout: `/Users/danvoulez/lab-mistral-rs-gateway`
- Active listener: `0.0.0.0:8787`
- Candidate checkout: `/Users/danvoulez/lab-mistral-rs-gateway-candidate`
- Candidate listener: `127.0.0.1:8788`
- LaunchAgent: `local.lab-mistral-gateway`
- Local model endpoints are external processes. The gateway never starts a second model as fallback.
- Runtime keys stay in `runtime/`; they are never copied into Git or printed by operational commands.

Record the active commit before every change:

```bash
cd /Users/danvoulez/lab-mistral-rs-gateway
git status --short --branch
git rev-parse HEAD
/usr/sbin/lsof -nP -iTCP:8787 -sTCP:LISTEN
```

Stop if the checkout is dirty or the listener is not the expected Node process.

## Catalog and certification

`GET /v1/models` is the only model catalog. It returns `Local`, `Vercel AI Gateway` and `Cloudflare AI Gateway` source states separately:

- `available`: the live catalog probe succeeded;
- `degraded`: at least one configured candidate could not be proved; no stale candidate is substituted;
- `not_configured`: required route/account/gateway/token configuration is absent.

A model is selectable only while its `dream-agent.v1` certificate is current. Certification actually exercises normal conversation, the intact system prompt, a tool call, a tool result and JSON Schema output. A model name or `/health` response is not certification.

```bash
curl -sS http://127.0.0.1:8787/v1/models | jq '{generated_at,sources,data:[.data[]|{id,source,selectable,certification}]}'
```

## Honest request failures

Every chat request must include a canonical `model`. The gateway returns:

- `model_required` when absent;
- `model_unknown` when the ID is outside configured candidates;
- `model_unavailable` when the selected current route fails;
- `model_timeout` when its single attempt expires;
- `route_mismatch` when the upstream reports a different executed model;
- `model_capability_mismatch` when the client asks for an unsupported transport feature.

Successful responses and streams carry `x-lab-request-id`, `x-lab-requested-model`, `x-lab-executed-model`, `x-lab-source` and `x-lab-fallback: false`. Logs contain hashes and route receipts, not prompt or key content.

## Candidate on 8788

Create the candidate as a Git worktree. Give it its own state/log directories and symlink only the required ignored credentials from the active checkout.

```bash
cd /Users/danvoulez/lab-mistral-rs-gateway
git worktree add /Users/danvoulez/lab-mistral-rs-gateway-candidate feat/strict-routing
cd /Users/danvoulez/lab-mistral-rs-gateway-candidate
mkdir -p runtime/keys logs
ln -s /Users/danvoulez/lab-mistral-rs-gateway/runtime/gateway-token runtime/gateway-token
ln -s /Users/danvoulez/lab-mistral-rs-gateway/runtime/clients.json runtime/clients.json
for key in /Users/danvoulez/lab-mistral-rs-gateway/runtime/keys/*; do ln -s "$key" "runtime/keys/$(basename "$key")"; done
nohup env LAB_GATEWAY_HOST=127.0.0.1 LAB_GATEWAY_PORT=8788 /opt/homebrew/bin/node src/server.js > logs/candidate.stdout.log 2> logs/candidate.stderr.log &
echo $! > runtime/candidate.pid
```

From LAB 256, forward the loopback port and run the Dream acceptance script:

```bash
ssh -N -L 18788:127.0.0.1:8788 lab-8gb
GOLDEN_BRIDGE_URL=http://127.0.0.1:18788 node scripts/acceptance/model-routing.mjs
```

The acceptance report must name every configured source it exercised. `not_configured` is an honest blocked state, not a pass.

## Activation and rollback proof

Only after candidate acceptance:

```bash
cd /Users/danvoulez/lab-mistral-rs-gateway
candidate_commit=$(git rev-parse feat/strict-routing)
git switch --detach "$candidate_commit"
launchctl kickstart -k gui/$(id -u)/local.lab-mistral-gateway
curl -fsS http://127.0.0.1:8787/health
```

The candidate branch remains checked out by the 8788 worktree, so the active checkout uses its exact commit in detached mode. Rollback once to the recorded prior commit/branch and prove `/health`; then reactivate the candidate commit and repeat catalog plus tool acceptance. Do not edit the plist or create a second release system for this change.

## Stop candidate

```bash
cd /Users/danvoulez/lab-mistral-rs-gateway-candidate
kill "$(cat runtime/candidate.pid)"
cd /Users/danvoulez/lab-mistral-rs-gateway
git worktree remove /Users/danvoulez/lab-mistral-rs-gateway-candidate
```

Never use a broad kill command. Resolve and stop only the PID recorded for port 8788.
