# Model Change Runbook

## Add A Model

1. Run on LAB 8GB:

```bash
mistralrs tune -m <huggingface/model> --emit-config /tmp/model.toml
```

2. Prefer a pre-quantized GGUF profile when the machine has 8GB RAM.
3. Add a profile to `config/lab-block.json`.
4. Keep `--max-seqs 1`, `--max-batch-size 1`, and a conservative `--max-seq-len` until the model is proven stable.
5. Select it:

```bash
LAB_GATEWAY_URL=http://10.88.0.9:8787 LAB_GATEWAY_KEY=<key> npm run select -- <profile-id>
```

6. Run a smoke test.

## Remove A Model

Delete the profile from `config/lab-block.json`. If it was active, select another model before restarting the gateway.

## Roll Back

```bash
LAB_GATEWAY_URL=http://10.88.0.9:8787 LAB_GATEWAY_KEY=<key> npm run select -- mistral-nemo-q4
```

The gateway writes the current runtime state to `runtime/mistral-state.json`.
