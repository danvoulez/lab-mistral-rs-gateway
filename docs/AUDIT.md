# LAB Infrastructure Audit

Date: 2026-06-24

## Protected Baseline

Manhattan is protected on both computers. Do not stop, delete, rename, or edit these as part of mistral/gateway cleanup:

- LAB 512: `com.project-manhattan.agent`
- LAB 8GB: `com.project-manhattan.agent`

## Intended Path

```text
LAB 512 mistral.rs/model
  10.88.0.10:1234
  com.minilab.mistralrs-serve
  /Users/danvoulez/models/Mistral-Nemo-Instruct-2407-Q4_K_M.gguf
        |
        | Ethernet cable
        v
LAB 8GB gateway
  10.88.0.9:8787
  local.lab-mistral-gateway
        |
        v
requester
```

LAB 8GB must not run `mistralrs` or hold model inference memory.

## Current Keep Candidates

- LAB 512 `com.minilab.mistralrs-serve`: serves the model at `10.88.0.10:1234`.
- LAB 8GB `local.lab-mistral-gateway`: routes gateway requests to LAB 512.

## Suspicious Non-Manhattan Items

These were observed. ActGraph items listed below were removed from active service on 2026-06-24.

- LAB 512 `com.minilab.host-runtime`: repeatedly respawning, last exit code `1`.
- LAB 512 `com.minilab.infra-outbox-worker`: repeatedly respawning, points at `/Users/ubl-ops/...`, last exit code `78`.
- LAB 512 `com.minilab.hermes-webui`: Python process on `127.0.0.1:8787`; local-only but shares the gateway port number.
- LAB 512 `com.minilab.cloudflared-runtime`: separate tunnel stack.
- LAB 8GB `ai.openclaw.gateway`: separate gateway on localhost `18789`.
- LAB 8GB `com.minilab.host-runtime`: repeatedly respawning, last exit code `1`.

Do not remove these without a separate cleanup pass and explicit approval.

## Verified Endpoints

- LAB 512 `http://10.88.0.10:1234/health` returned `OK`.
- LAB 512 `http://10.88.0.10:1234/v1/models` returned model ids `default` and `/Users/danvoulez/models`.
- LAB 8GB gateway state is configured as `supervised: false` with `externalBaseUrl: http://10.88.0.10:1234`.
- Direct LAB 512 inference returned clean text after restarting `com.minilab.mistralrs-serve` with `--prefix-cache-n 0`.
- End-to-end request to `http://10.88.0.9:8787/v1/chat/completions` returned `cable gateway works`.

## Dated LAB 8GB LaunchAgent Inventory

- 2026-06-24 10:39:50 `/Users/danvoulez/Library/LaunchAgents/local.lab-mistral-gateway.plist`
- 2026-06-17 09:51:21 `/Users/danvoulez/Library/LaunchAgents/actions.runner.danvoulez-ActGraph.lab-8gb-capital.plist` moved to `/Users/danvoulez/Deleted-ActGraph-20260624-155411/LaunchAgents/`
- 2026-06-16 04:06:54 `/Users/danvoulez/Library/LaunchAgents/ai.openclaw.gateway.plist`
- 2026-06-13 01:01:35 `/Users/danvoulez/Library/LaunchAgents/com.minilab.actgraph-mcp-http.plist` moved to `/Users/danvoulez/Deleted-ActGraph-20260624-155411/LaunchAgents/`
- 2026-06-10 23:47:09 `/Users/danvoulez/Library/LaunchAgents/com.minilab.actgraph.plist` moved to `/Users/danvoulez/Deleted-ActGraph-20260624-155411/LaunchAgents/`

## ActGraph Test Cleanup

On LAB 8GB, these ActGraph test services were stopped, disabled, and moved out of active paths:

- `com.minilab.actgraph`
- `com.minilab.actgraph-mcp-http`
- `actions.runner.danvoulez-ActGraph.lab-8gb-capital`

Moved artifacts:

- `/Users/danvoulez/engine-park/live/actgraph-capital`
- `/Users/danvoulez/engine-park/live/actgraph-capital-run.sh`
- `/Users/danvoulez/engine-park/live/actgraph-mcp-http-run.sh`
- `/Users/danvoulez/actgraph-store`
- `/Users/danvoulez/.actgraph`
- `/Users/danvoulez/actions-runner`

Quarantine path:

- `/Users/danvoulez/Deleted-ActGraph-20260624-155411`

Post-cleanup verification:

- No ActGraph launch labels remained in `launchctl list`.
- No ActGraph plist remained in `/Users/danvoulez/Library/LaunchAgents`.
- LAB 8GB gateway still listened on `*:8787`.
- End-to-end gateway inference returned `actgraph removed gateway alive`.
- Port `7000` was still open, but by macOS `ControlCenter`, not ActGraph.

## Important Fix Applied

The old LAB 512 `com.minilab.mistralrs-serve` plist was missing the no-prefix-cache stability flags even though the repo config expected them. It has been replaced with `services/com.minilab.mistralrs-serve.plist`, which includes:

- `--prefix-cache-n 0`
- `--max-seqs 1`
- `--max-batch-size 1`
- `--max-seq-len 4096`

## Manhattan Sync

On 2026-06-24, Manhattan was checked on both LAB 512 and LAB 8GB after the bridge became real.

Findings:

- Manhattan source and policy already knew the correct Ethernet pair: LAB 512 `10.88.0.10`, LAB 8GB `10.88.0.9`.
- Passwordless sudo for Manhattan daemon control was available on both machines.
- Manhattan binaries did not need replacement; they are shell wrappers into `src/manhattan.py`.
- Manhattan policy still listed `com.minilab.llm-gateway` as blocked by `8GB-middleware`.

Applied:

- Backed up `/usr/local/project-manhattan/etc/PROJECT_MANHATTAN_POLICY_REVIEW.json` on both machines.
- Updated the `com.minilab.llm-gateway` policy entry on both machines to:
  - `status`: `retired - superseded by golden-bridge`
  - `bridge_gateway`: `http://10.88.0.9:8787/v1`
  - `bridge_inference`: `http://10.88.0.10:1234/v1`
- Restored LAB 8GB Manhattan `/usr/local/project-manhattan/etc` ownership to `root:wheel`.
- Kickstarted Manhattan agent and daemon on both machines.

Post-sync verification:

- LAB 512 Manhattan agent and daemon were running.
- LAB 8GB Manhattan agent and daemon were running.
- End-to-end gateway inference returned `manhattan bridge synced`.

## Manhattan Bridge Mini-CLI

On 2026-06-24, the bridge package gained `scripts/manhattan-bridge.js`, a read-only sidecar CLI that exposes only the commands Manhattan needs for this bridge:

- `identity`
- `services`
- `policy`
- `health`
- `status`
- `metrics`

The full Manhattan CLI was audited and found to include broader commands such as `audit`, `repair`, `receipts`, `policy-items`, `daemon`, `agent`, and `gc`. Those are intentionally not duplicated in the bridge sidecar.

The sidecar found one real policy contradiction: active ActGraph services had been removed, but the Manhattan policy row for `com.minilab.actgraph` still said `admitted`.

Applied on both LAB 512 and LAB 8GB:

- Backed up `/usr/local/project-manhattan/etc/PROJECT_MANHATTAN_POLICY_REVIEW.json`.
- Changed `com.minilab.actgraph` to `retired - deleted test infra`.
- Added retirement metadata pointing to `golden-bridge`.

Post-fix verification:

- `npm run bridge:manhattan -- policy --pretty` returned `ok: true`.
- `npm run bridge:manhattan -- status --pretty` returned `ok: true` on LAB 512.
- The status check confirmed LAB 512 inference, LAB 8GB gateway, Manhattan agent/daemon, deleted ActGraph labels absent, and the model chair not packaged.
