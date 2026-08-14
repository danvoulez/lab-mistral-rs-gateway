import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function projectPath(...parts) {
  return path.join(rootDir, ...parts);
}

export function loadConfig(configPath = process.env.LAB_BLOCK_CONFIG || projectPath('config/lab-block.json')) {
  const resolved = path.resolve(configPath);
  const config = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  applyEnvOverrides(config);
  applySecretFile(config);
  applyClientMap(config);
  validateConfig(config, resolved);
  config.__path = resolved;
  config.__root = rootDir;
  return config;
}

export function modelById(config, modelId) {
  return config.models.find((model) => model.id === modelId);
}

export function upstreamBaseUrl(config, model) {
  const upstream = model?.upstream || config.mistral;
  if (upstream.url) return upstream.url.replace(/\/+$/, '');
  return `http://${upstream.host}:${upstream.port}`;
}

// Chat/models endpoint for an upstream. Local llama.cpp upstreams expose /v1/*;
// cloud gateway upstreams (Vercel AI Gateway, Cloudflare AI Gateway) carry a
// full base URL that already ends in /v1.
export function upstreamEndpoint(config, model, suffix) {
  const base = upstreamBaseUrl(config, model);
  return base.endsWith('/v1') ? `${base}/${suffix}` : `${base}/v1/${suffix}`;
}

// Bearer auth for cloud upstreams. Key material lives in runtime/keys/<name>
// (chmod 600), never in lab-block.json. Local upstreams return no headers.
export function upstreamAuthHeaders(config, model) {
  const keyName = model?.upstream?.key;
  if (!keyName) return {};
  const file = projectPath('runtime', 'keys', keyName);
  if (!fs.existsSync(file)) {
    throw new Error(`missing upstream key file runtime/keys/${keyName}`);
  }
  return { authorization: `Bearer ${fs.readFileSync(file, 'utf8').trim()}` };
}

function validateConfig(config, resolved) {
  const fail = (message) => {
    throw new Error(`${resolved}: ${message}`);
  };

  if (!config.gateway || typeof config.gateway.port !== 'number') fail('gateway.port is required');
  if (!config.mistral || typeof config.mistral.port !== 'number') fail('mistral.port is required');
  if (!Array.isArray(config.models) || config.models.length === 0) fail('models must be a non-empty array');

  const ids = new Set();
  for (const model of config.models) {
    if (!model.id || !model.modelId) fail('each model needs id and modelId');
    if (ids.has(model.id)) fail(`duplicate model id ${model.id}`);
    ids.add(model.id);
    if (model.args && !Array.isArray(model.args)) fail(`${model.id}.args must be an array`);
    if (!model.upstream || (!model.upstream.url && (!model.upstream.host || typeof model.upstream.port !== 'number'))) {
      fail(`${model.id}.upstream needs either url or host+port`);
    }
  }

  if (config.cloud) {
    if (typeof config.cloud.url !== 'string' || typeof config.cloud.key !== 'string') {
      fail('cloud.url and cloud.key are required when cloud is configured');
    }
  }

  if (config.bridge) {
    if (config.mistral.supervise !== false) {
      fail('LAB 8GB gateway config must keep mistral.supervise=false');
    }
    const reader = config.models.find((model) => model.role === 'inference-512');
    if (!reader || reader.upstream.host !== config.bridge.lab512?.ip) {
      fail(`inference-512 model must point at LAB 512 (${config.bridge.lab512?.ip})`);
    }
    const metabolism = config.models.find((model) => model.role === 'metabolism');
    if (!metabolism || metabolism.upstream.host !== '127.0.0.1') {
      fail('metabolism model must remain local to LAB 8GB');
    }
  }

  if (
    config.gateway.host !== '127.0.0.1' &&
    (!config.gateway.apiKey || config.gateway.apiKey === 'disabled' ||
      config.gateway.apiKey === 'required-from-runtime-token')
  ) {
    fail('a gateway bearer token is required when listening beyond loopback');
  }
}

function applySecretFile(config) {
  const configured = process.env.LAB_GATEWAY_KEY_FILE || config.gateway.apiKeyFile;
  if (!configured) return;
  const resolved = path.isAbsolute(configured) ? configured : projectPath(configured);
  if (fs.existsSync(resolved)) {
    config.gateway.apiKey = fs.readFileSync(resolved, 'utf8').trim();
  }
}

// Optional bearer-token → client-name map for cost attribution.
// Lives in runtime/clients.json (chmod 600) so tokens never enter lab-block.json.
function applyClientMap(config) {
  const file = projectPath('runtime', 'clients.json');
  if (!fs.existsSync(file)) return;
  try {
    config.clients = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    config.clients = {};
  }
}

function applyEnvOverrides(config) {
  if (process.env.LAB_GATEWAY_HOST) config.gateway.host = process.env.LAB_GATEWAY_HOST;
  if (process.env.LAB_GATEWAY_PORT) config.gateway.port = Number(process.env.LAB_GATEWAY_PORT);
  if (process.env.LAB_GATEWAY_PUBLIC_BASE_URL) config.gateway.publicBaseUrl = process.env.LAB_GATEWAY_PUBLIC_BASE_URL;
  if (process.env.LAB_GATEWAY_KEY) config.gateway.apiKey = process.env.LAB_GATEWAY_KEY;
  if (process.env.MISTRAL_HOST) config.mistral.host = process.env.MISTRAL_HOST;
  if (process.env.MISTRAL_PORT) config.mistral.port = Number(process.env.MISTRAL_PORT);
  if (process.env.MISTRAL_SUPERVISE) config.mistral.supervise = process.env.MISTRAL_SUPERVISE !== 'false';
}
