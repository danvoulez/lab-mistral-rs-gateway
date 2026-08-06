import http from 'node:http';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { loadConfig, modelById, projectPath, readSystemPolicy, upstreamAuthHeaders, upstreamBaseUrl, upstreamEndpoint } from './config.js';
import { normalizeChatRequest, HttpInputError } from './promptPolicy.js';
import { ModelSupervisor } from './modelSupervisor.js';
import { generateCompletion, streamCompletion } from './aiProvider.js';
import { writeRequestEvent } from './logging.js';

const config = loadConfig();
const supervisor = new ModelSupervisor(config);
const systemPolicy = readSystemPolicy(config);
const startedAt = new Date();
const counters = {
  requests: 0,
  failures: 0,
  modelSwitches: 0,
  promptSystemsStripped: 0,
  upstreamFailures: 0,
  lastRequestMs: 0,
  lastUpstreamMs: 0
};

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    counters.failures += 1;
    writeError(res, error);
  }
});

server.on('error', (error) => {
  console.error(`gateway listen failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(config.gateway.port, config.gateway.host, () => {
  console.log(`Golden Bridge gateway listening on http://${config.gateway.host}:${config.gateway.port}`);
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return writeJson(res, 200, {
      provider: 'golden-bridge',
      name: 'Golden Bridge — unified inference provider',
      publicBaseUrl: config.gateway.publicBaseUrl || null,
      auth: {
        internet: 'Cloudflare Access service token (CF-Access-Client-Id + CF-Access-Client-Secret)',
        lan: 'Authorization: Bearer <gateway token>',
        loopback: 'trusted — tunnel traffic is already Access-authenticated'
      },
      endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/ops/state', '/ops/bridge', '/ops/models/select', '/ops/costs', '/metrics'],
      models: config.models.map((model) => ({
        id: model.id,
        role: model.role,
        host: model.host,
        kind: model.upstream?.url ? 'cloud' : 'local',
        price_per_1m_tokens_usd: config.prices?.[model.id] || null
      })),
      receipt: 'every chat response carries x-lab-cost-usd + x-lab-compute-ms headers and lab.{client, cost_usd, compute_ms, tokens_total}; per-client aggregates at /ops/costs. Local models charge compute only; cloud models charge compute + money.'
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const upstreams = await upstreamHealth();
    return writeJson(res, 200, {
      ok: upstreams.every((upstream) => upstream.healthy),
      bridge: config.bridge?.name || 'lab-bridge',
      role: 'gateway',
      active: supervisor.readState(),
      upstreamHealthy: upstreams.every((upstream) => upstream.healthy),
      upstreams
    });
  }

  if (req.method === 'GET' && url.pathname === '/ops/bridge') {
    assertAuthorized(req);
    return writeJson(res, 200, await bridgeState());
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return writeJson(res, 200, {
      object: 'list',
      data: config.models.map((model) => ({
        id: model.id,
        object: 'model',
        owned_by: 'lab-8gb',
        root: model.modelId,
        quantization: model.quantization
      }))
    });
  }

  if (req.method === 'GET' && url.pathname === '/ops/state') {
    assertAuthorized(req);
    return writeJson(res, 200, {
      state: supervisor.readState(),
      config: {
        publicBaseUrl: config.gateway.publicBaseUrl,
        systemMode: config.gateway.systemMode,
        defaultModel: config.defaultModel,
        models: config.models.map(publicModel)
      },
      counters
    });
  }

  if (req.method === 'POST' && url.pathname === '/ops/models/select') {
    assertAuthorized(req);
    const body = await readJson(req, config.gateway.maxBodyBytes);
    const model = modelById(config, body.model);
    if (!model) throw new HttpInputError(404, `unknown model ${body.model}`);
    const before = supervisor.readState().activeModel;
    const state = await supervisor.ensureModel(model);
    if (before !== model.id) counters.modelSwitches += 1;
    return writeJson(res, 200, { ok: true, state });
  }

  if (req.method === 'GET' && url.pathname === '/metrics') {
    assertAuthorized(req);
    const gatewayMetrics = [
      '# HELP lab_gateway_requests_total Total chat completion requests handled by the gateway.',
      '# TYPE lab_gateway_requests_total counter',
      `lab_gateway_requests_total ${counters.requests}`,
      '# HELP lab_gateway_failures_total Total gateway request failures.',
      '# TYPE lab_gateway_failures_total counter',
      `lab_gateway_failures_total ${counters.failures}`,
      '# HELP lab_gateway_model_switches_total Total exclusive model switches.',
      '# TYPE lab_gateway_model_switches_total counter',
      `lab_gateway_model_switches_total ${counters.modelSwitches}`,
      '# HELP lab_gateway_prompt_systems_stripped_total Request system messages stripped by replace mode.',
      '# TYPE lab_gateway_prompt_systems_stripped_total counter',
      `lab_gateway_prompt_systems_stripped_total ${counters.promptSystemsStripped}`
      ,'# HELP lab_gateway_upstream_failures_total Total upstream mistral.rs failures.'
      ,'# TYPE lab_gateway_upstream_failures_total counter'
      ,`lab_gateway_upstream_failures_total ${counters.upstreamFailures}`
      ,'# HELP lab_gateway_uptime_seconds Gateway process uptime.'
      ,'# TYPE lab_gateway_uptime_seconds gauge'
      ,`lab_gateway_uptime_seconds ${Math.floor(process.uptime())}`
      ,'# HELP lab_gateway_last_request_ms Last completed chat request duration.'
      ,'# TYPE lab_gateway_last_request_ms gauge'
      ,`lab_gateway_last_request_ms ${counters.lastRequestMs}`
      ,'# HELP lab_gateway_last_upstream_ms Last upstream mistral.rs request duration.'
      ,'# TYPE lab_gateway_last_upstream_ms gauge'
      ,`lab_gateway_last_upstream_ms ${counters.lastUpstreamMs}`
    ].join('\n');
    let mistralMetrics = '';
    try {
      mistralMetrics = await supervisor.metrics();
    } catch (error) {
      mistralMetrics = `# mistralrs metrics unavailable: ${error.message}\n`;
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    return res.end(`${gatewayMetrics}\n\n${mistralMetrics}`);
  }

  if (req.method === 'GET' && url.pathname === '/ops/costs') {
    assertAuthorized(req);
    return writeJson(res, 200, aggregateCosts());
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    // Golden Bridge single-credential rule: requests arriving via loopback come
    // either from the cloudflared tunnel (already authenticated by Cloudflare
    // Access) or from trusted local processes — so only non-loopback (LAN)
    // callers must present the gateway bearer token.
    if (!isLoopbackRequest(req)) assertAuthorized(req);
    counters.requests += 1;
    const client = identifyClient(req);
    const body = await readJson(req, config.gateway.maxBodyBytes);
    const requestId = randomUUID();
    const started = Date.now();
    const requestedModel = body.model || supervisor.readState().activeModel || config.defaultModel;
    let model = modelById(config, requestedModel);
    if (!model && config.cloud?.catalogPassthrough && typeof requestedModel === 'string' && requestedModel.includes('/')) {
      // Vercel AI Gateway catalog passthrough: any "provider/model" id routes
      // straight to the cloud gateway — the full catalog (316 models) without
      // config entries. Unknown ids are rejected by the upstream (400/404).
      // cost_usd is only estimated for ids present in config.prices; usage
      // and compute are always logged.
      model = {
        id: requestedModel,
        modelId: requestedModel,
        kind: 'text',
        role: 'cloud',
        host: config.cloud.host || 'vercel-ai-gateway',
        upstream: { url: config.cloud.url, key: config.cloud.key },
        maxOutputTokens: 1024
      };
    }
    if (!model) throw new HttpInputError(404, `unknown model ${requestedModel}`);

    const before = supervisor.readState().activeModel;
    await supervisor.ensureModel(model);
    if (before !== model.id) counters.modelSwitches += 1;

    const normalized = normalizeChatRequest(body, {
      systemPolicy,
      systemMode: config.gateway.systemMode
    });
    counters.promptSystemsStripped += normalized.strippedSystemMessages;

    if (body.stream) {
      return handleStreamingChat(res, model, normalized, body);
    }
    return handleChat(res, model, normalized, body, { requestId, started, client });
  }

  throw new HttpInputError(404, 'not found');
}

async function handleChat(res, model, normalized, body, context) {
  let result;
  try {
    result = await generateCompletion(config, model, normalized, body);
  } catch (error) {
    counters.upstreamFailures += 1;
    writeRequestEvent({
      request_id: context.requestId,
      ok: false,
      client: context.client,
      model: model.id,
      routed_model: model.modelId,
      prompt_hash: normalized.promptHash,
      duration_ms: Date.now() - context.started,
      error: error.message
    });
    throw error;
  }

  counters.lastRequestMs = Date.now() - context.started;
  counters.lastUpstreamMs = result.upstreamMs || 0;
  const costUsd = estimateCostUsd(model, result.usage);
  // Unified compute metric: real GPU-ms for local llama.cpp, upstream wall-ms
  // for cloud (providers expose tokens, not GPU time). Common to both types.
  const computeMs = result.computeMs ?? result.upstreamMs ?? 0;
  const tokensTotal = result.usage?.total_tokens ??
    (result.usage?.prompt_tokens || 0) + (result.usage?.completion_tokens || 0);
  writeRequestEvent({
    request_id: context.requestId,
    ok: true,
    client: context.client,
    model: model.id,
    routed_model: model.modelId,
    upstream_model: result.upstream?.model,
    prompt_hash: normalized.promptHash,
    duration_ms: counters.lastRequestMs,
    upstream_ms: counters.lastUpstreamMs,
    finish_reason: result.finishReason || 'stop',
    usage: result.usage,
    cost_usd: costUsd,
    compute_ms: computeMs,
    tokens_total: tokensTotal
  });

  res.setHeader('x-lab-bridge', config.bridge?.name || 'lab-bridge');
  res.setHeader('x-lab-request-id', context.requestId);
  res.setHeader('x-lab-prompt-hash', normalized.promptHash);
  if (costUsd != null) res.setHeader('x-lab-cost-usd', String(costUsd));
  res.setHeader('x-lab-compute-ms', String(computeMs));
  return writeJson(res, 200, {
    id: `chatcmpl_${context.requestId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: result.finishReason || 'stop'
      }
    ],
    usage: result.usage,
    lab: {
      routed_model: model.modelId,
      upstream_model: result.upstream?.model,
      upstream_ms: result.upstreamMs,
      prompt_hash: normalized.promptHash,
      system_mode: normalized.systemMode,
      client: context.client,
      cost_usd: costUsd,
      compute_ms: computeMs,
      tokens_total: tokensTotal
    }
  });
}

async function bridgeState() {
  const upstreams = await upstreamHealth(true);

  return {
    ok: upstreams.every((upstream) => upstream.healthy),
    bridge: config.bridge || null,
    gateway: {
      host: config.gateway.host,
      port: config.gateway.port,
      publicBaseUrl: config.gateway.publicBaseUrl,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      systemMode: config.gateway.systemMode
    },
    upstreams,
    state: supervisor.readState(),
    counters
  };
}

async function upstreamHealth(includeModels = false) {
  return Promise.all(config.models.map(async (model) => {
    const baseUrl = upstreamBaseUrl(config, model);
    const isCloud = Boolean(model.upstream?.url);
    let healthy = false;
    let models = null;
    let error = null;
    try {
      if (isCloud) {
        // Cloud gateways (Vercel/Cloudflare AI Gateway) have no /health;
        // an authenticated /models listing doubles as the liveness probe.
        const response = await fetch(upstreamEndpoint(config, model, 'models'), {
          headers: upstreamAuthHeaders(config, model),
          signal: AbortSignal.timeout(5000)
        });
        healthy = response.ok;
        if (includeModels && response.ok) models = await response.json();
      } else {
        const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
        healthy = health.ok;
        if (includeModels) {
          const response = await fetch(`${baseUrl}/v1/models`, {
            signal: AbortSignal.timeout(3000)
          });
          models = response.ok ? await response.json() : null;
        }
      }
    } catch (cause) {
      error = cause.message;
    }
    return {
      id: model.id,
      role: model.role,
      host: model.host,
      baseUrl,
      healthy,
      models,
      error
    };
  }));
}

function publicModel(model) {
  return {
    id: model.id,
    modelId: model.modelId,
    role: model.role,
    host: model.host,
    quantization: model.quantization,
    maxOutputTokens: model.maxOutputTokens,
    upstream: model.upstream
  };
}

async function handleStreamingChat(res, model, normalized, body) {
  const stream = await streamCompletion(config, model, normalized, body);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-lab-prompt-hash': normalized.promptHash
  });

  for await (const chunk of stream) {
    res.write(chunk);
  }
  res.end();
}

function isLoopbackRequest(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// Client identity for cost attribution ("joga o custo no cliente"):
// Cloudflare Access service-token id when via tunnel, named bearer token from
// runtime/clients.json when on LAN, hashed token otherwise, x-lab-client
// header or "local" for trusted loopback callers.
function identifyClient(req) {
  const accessId = req.headers['cf-access-client-id'];
  if (accessId) return `access:${String(accessId).replace(/\.access$/, '')}`;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (config.clients?.[token]) return config.clients[token];
    return `bearer:${createHash('sha256').update(token).digest('hex').slice(0, 8)}`;
  }
  return req.headers['x-lab-client'] || 'local';
}

// USD per 1M tokens from config.prices (editable estimates; local models cost 0).
function estimateCostUsd(model, usage) {
  const price = config.prices?.[model.id] ?? config.prices?.[model.modelId];
  if (!price || !usage) return model.role === 'cloud' ? null : 0;
  const input = (usage.prompt_tokens || 0) * (price.input || 0) / 1e6;
  const output = (usage.completion_tokens || 0) * (price.output || 0) / 1e6;
  return Math.round((input + output) * 1e8) / 1e8;
}

function aggregateCosts() {
  const file = projectPath('logs/gateway-requests.jsonl');
  const byClient = {};
  const totals = { requests: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, compute_ms: 0, tokens_total: 0 };
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { ok: true, since: null, byClient, totals };
  }
  let since = null;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event.ok || !event.usage) continue;
    since = since || event.ts;
    const client = event.client || 'unknown';
    const entry = byClient[client] ||= { requests: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, compute_ms: 0, tokens_total: 0, models: {} };
    const usage = event.usage;
    const cost = event.cost_usd || 0;
    const compute = event.compute_ms || 0;
    const tokensTotal = event.tokens_total ?? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    entry.requests += 1;
    entry.prompt_tokens += usage.prompt_tokens || 0;
    entry.completion_tokens += usage.completion_tokens || 0;
    entry.cost_usd = Math.round((entry.cost_usd + cost) * 1e8) / 1e8;
    entry.compute_ms += compute;
    entry.tokens_total += tokensTotal;
    const modelEntry = entry.models[event.model] ||= { requests: 0, cost_usd: 0, compute_ms: 0, tokens_total: 0 };
    modelEntry.requests += 1;
    modelEntry.cost_usd = Math.round((modelEntry.cost_usd + cost) * 1e8) / 1e8;
    modelEntry.compute_ms += compute;
    modelEntry.tokens_total += tokensTotal;
    totals.requests += 1;
    totals.prompt_tokens += usage.prompt_tokens || 0;
    totals.completion_tokens += usage.completion_tokens || 0;
    totals.cost_usd = Math.round((totals.cost_usd + cost) * 1e8) / 1e8;
    totals.compute_ms += compute;
    totals.tokens_total += tokensTotal;
  }
  return { ok: true, since, unit_notes: 'cost_usd = dinheiro (estimado via config.prices); compute_ms = tempo de modelo (GPU real no local, wall-clock na nuvem); tokens_total = compute comum aos dois tipos', byClient, totals };
}

function assertAuthorized(req) {
  const expected = config.gateway.apiKey;
  if (!expected || expected === 'disabled') return;
  const actual = req.headers.authorization || '';
  if (actual !== `Bearer ${expected}`) {
    throw new HttpInputError(401, 'missing or invalid bearer token');
  }
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpInputError(413, 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpInputError(400, 'invalid JSON body');
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function writeError(res, error) {
  const status = error.status || 500;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify({
    error: {
      message: error.message || 'internal error',
      type: status >= 500 ? 'server_error' : 'invalid_request_error'
    }
  }, null, 2)}\n`);
}
