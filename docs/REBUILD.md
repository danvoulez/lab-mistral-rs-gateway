# Rebuild And Package Guide

This repository is rebuildable for the golden bridge control plane. The model file is intentionally not packaged because it is large and belongs to LAB 512 model storage.

## What Is Packaged

- LAB 8GB gateway source
- LAB 8GB watchdog
- LAB 512 `mistralrs` LaunchAgent plist
- Manhattan bridge mini-CLI
- Config and system policy
- Operator docs
- Tests and preflight checks

## External Prerequisites

LAB 512 must already have:

```text
/Users/danvoulez/.cargo/bin/mistralrs
/Users/danvoulez/models/Mistral-Nemo-Instruct-2407-Q4_K_M.gguf
```

LAB 8GB must already have:

```text
/opt/homebrew/bin/node
/opt/homebrew/bin/npm
```

The Ethernet pair must be:

```text
LAB 512: 10.88.0.10
LAB 8GB: 10.88.0.9
```

## Build A Package

From the repo:

```bash
npm run package:bridge
```

The package appears in:

```text
dist/
```

with a `.sha256` checksum.

## Reinstall LAB 512 Side

On LAB 512:

```bash
bash scripts/install-lab512.sh
```

This installs and starts:

```text
com.minilab.mistralrs-serve
```

## Reinstall LAB 8GB Side

On LAB 8GB:

```bash
bash scripts/install-lab8gb.sh
```

This installs and starts:

```text
local.lab-mistral-gateway
local.lab-bridge-watchdog
```

## Verify

```bash
npm test
npm run bridge:watchdog
npm run bridge:status
npm run bridge:manhattan -- status --pretty
```

Expected:

```text
"ok": true
```

## Current Packaging Boundary

Fully rebuildable from this repo:

- gateway
- watchdog
- service definitions
- docs
- tests
- config validation
- Manhattan-facing read-only bridge sidecar

Not embedded in package:

- model weights
- `mistralrs` binary
- Manhattan package
- old audit quarantine folders

Those are host-level prerequisites by design.

The model is represented as a chair only: `config/lab-block.json` wires the expected LAB 512 model slot, file name, model id, and safe `mistralrs` launch arguments. A rebuild must download or restore the model file onto LAB 512 separately.
