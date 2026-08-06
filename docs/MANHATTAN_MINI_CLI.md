# Manhattan Bridge Mini-CLI

This repo packages a small read-only CLI for Manhattan to inspect the golden bridge without carrying the whole Manhattan runtime.

```bash
npm run bridge:manhattan -- status --pretty
```

Direct form:

```bash
node scripts/manhattan-bridge.js status --pretty
```

## Why It Exists

Manhattan is the survival layer. Its full CLI is broad by design:

- `audit [--write]`
- `repair [--apply] [--item <id>...]`
- `health`
- `status`
- `metrics`
- `receipts`
- `policy-items`
- `daemon`
- `agent`
- `gc [--apply]`

The golden bridge does not need that entire surface to be rebuildable. It needs a tiny stable contract that can answer:

- Which LAB am I on?
- Is this host wearing the correct role?
- Are the required bridge services present?
- Are deleted test labels absent?
- Does Manhattan policy point to `golden-bridge`?
- Do LAB 8GB gateway and LAB 512 inference answer?
- Is there a Prometheus-style metric for watchdogs?

## Commands

```bash
node scripts/manhattan-bridge.js commands --pretty
```

Shows the Manhattan CLI audit and the intentionally smaller sidecar surface.

```bash
node scripts/manhattan-bridge.js identity --pretty
```

Detects LAB identity from hostname and local IPs. It also prints the model chair: the slot and launch arguments for the model, without packaging the model file.

```bash
node scripts/manhattan-bridge.js services --pretty
```

Checks local `launchctl` state:

- Manhattan agent/daemon must be present.
- LAB 512 must have `com.minilab.mistralrs-serve`.
- LAB 8GB must have `local.lab-mistral-gateway` and `local.lab-bridge-watchdog`.
- ActGraph deleted labels must be absent.

```bash
node scripts/manhattan-bridge.js policy --pretty
```

Checks `/usr/local/project-manhattan/etc/PROJECT_MANHATTAN_POLICY_REVIEW.json` unless `MANHATTAN_POLICY` points elsewhere. The policy must:

- Keep LAB 8GB at `10.88.0.9`.
- Keep LAB 512 at `10.88.0.10`.
- Mark `com.minilab.llm-gateway` as retired and superseded by `golden-bridge`.
- Avoid admitting deleted ActGraph labels.

```bash
node scripts/manhattan-bridge.js health --pretty
```

Checks the real cable path:

- `http://10.88.0.10:1234/health`
- `http://10.88.0.10:1234/v1/models`
- `http://10.88.0.9:8787/health`
- `http://10.88.0.9:8787/ops/bridge`

```bash
node scripts/manhattan-bridge.js status --pretty
```

Aggregates identity, services, policy, and health. Exits nonzero when the bridge contract is broken.

```bash
node scripts/manhattan-bridge.js metrics
```

Emits Prometheus text for Manhattan or another watchdog.

## Packaging Boundary

Included:

- `scripts/manhattan-bridge.js`
- Config-driven bridge identity
- Service labels
- Policy checks
- Endpoint checks
- Metrics output

Not included:

- Model weights
- `mistralrs` binary
- Manhattan repair engine
- Manhattan daemon/agent loops
- Receipt garbage collection
- HTML dashboard

The model is a chair only: `config/lab-block.json` says which model file belongs in the slot on LAB 512, but the package does not carry the model file.
