import fs from 'node:fs';
import { HttpInputError } from './promptPolicy.js';
import { projectPath, upstreamBaseUrl } from './config.js';

const SOURCE_ORDER = ['local', 'vercel', 'cloudflare'];
const SOURCE_LABELS = { local: 'Local', vercel: 'Vercel AI Gateway', cloudflare: 'Cloudflare AI Gateway' };
const REQUIRED_CHECKS = ['conversation', 'tool_call', 'tool_result', 'schema', 'system_prompt'];

export function createDreamAgentCertifier(complete) {
  return async (model) => {
    const systemSentinel = 'DREAM_SYSTEM_OK';
    const toolSentinel = 'TOOL_RESULT_OK';
    const tool = {
      type: 'function',
      function: {
        name: 'catalog_probe',
        description: 'Return the supplied value.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string', enum: ['ok'] } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    };

    const conversation = await complete(model, {
      messages: [
        { role: 'system', content: `This is a transport test. Reply exactly ${systemSentinel}` },
        { role: 'user', content: 'Confirm the transport.' },
      ],
      temperature: 0,
    });
    const conversationText = messageText(conversation).trim();
    const conversationOk = conversationText === systemSentinel;

    const toolCallMessage = await complete(model, {
      messages: [
        { role: 'system', content: 'Call catalog_probe with value ok. Do not answer in prose.' },
        { role: 'user', content: 'Run the probe.' },
      ],
      tools: [tool],
      tool_choice: { type: 'function', function: { name: 'catalog_probe' } },
      temperature: 0,
    });
    const call = toolCallMessage?.tool_calls?.find((item) => item?.function?.name === 'catalog_probe');
    let toolCallOk = false;
    try { toolCallOk = JSON.parse(call?.function?.arguments ?? '{}').value === 'ok'; } catch { toolCallOk = false; }

    let finalMessage = null;
    if (call && toolCallOk) {
      finalMessage = await complete(model, {
        messages: [
          { role: 'system', content: `Return JSON. The system field must be ${systemSentinel}; copy the tool result into tool_result.` },
          { role: 'user', content: 'Complete the certified exchange.' },
          toolCallMessage,
          { role: 'tool', tool_call_id: call.id, content: toolSentinel },
        ],
        tools: [tool],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'dream_agent_transport_probe',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                system: { type: 'string', const: systemSentinel },
                tool_result: { type: 'string', const: toolSentinel },
              },
              required: ['system', 'tool_result'],
              additionalProperties: false,
            },
          },
        },
        temperature: 0,
      });
    }

    let structured = null;
    try { structured = JSON.parse(messageText(finalMessage)); } catch { structured = null; }
    const checks = {
      conversation: conversationOk,
      tool_call: toolCallOk,
      tool_result: structured?.tool_result === toolSentinel,
      schema: Boolean(structured && Object.keys(structured).length === 2 && structured.system === systemSentinel && structured.tool_result === toolSentinel),
      system_prompt: conversationOk && structured?.system === systemSentinel,
    };
    return {
      profile: 'dream-agent.v1',
      passed: REQUIRED_CHECKS.every((name) => checks[name]),
      checks,
      ...(!REQUIRED_CHECKS.every((name) => checks[name]) ? { reason: 'one_or_more_transport_checks_failed' } : {}),
    };
  };
}

export function createCatalogService(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const ttlMs = dependencies.ttlMs ?? 5 * 60 * 1000;
  const certificationTtlMs = dependencies.certificationTtlMs ?? 15 * 60 * 1000;
  const certify = dependencies.certify ?? (async () => ({ profile: 'dream-agent.v1', passed: false, checks: {}, reason: 'certifier_not_configured' }));
  const readKey = dependencies.readKey ?? readRuntimeKey;
  const states = new Map();
  const certifications = new Map();
  let selectable = new Map();

  async function read({ refresh = false } = {}) {
    const observedAt = now();
    const sourceStates = await Promise.all(SOURCE_ORDER.map(async (source) => {
      const previous = states.get(source);
      if (!refresh && previous && observedAt.getTime() < previous.expiresAt) return previous.value;
      const value = await refreshSource(source, observedAt);
      states.set(source, { value, expiresAt: observedAt.getTime() + ttlMs });
      return value;
    }));
    const data = sourceStates.flatMap((source) => source.data ?? []);
    selectable = new Map(data.filter((model) => model.selectable).map((model) => [model.id, model.route]));
    return {
      object: 'list',
      provider: 'golden-bridge',
      generated_at: observedAt.toISOString(),
      ttl_seconds: Math.floor(ttlMs / 1000),
      certification_profile: 'dream-agent.v1',
      sources: sourceStates.map(({ data: _data, ...source }) => source),
      data: data.map(({ route: _route, ...model }) => model),
    };
  }

  function requireSelectable(modelId) {
    const model = selectable.get(modelId);
    if (!model) {
      throw new HttpInputError(
        503,
        `O modelo ${modelId} não está disponível e certificado no catálogo vigente da Golden Bridge.`,
        'model_unavailable',
        { model: modelId },
      );
    }
    return model;
  }

  async function refreshSource(source, observedAt) {
    const candidates = config.models.filter((model) => model.source === source);
    if (!candidates.length) return sourceState(source, 'not_configured', observedAt, [], 'Nenhum modelo foi configurado para esta origem.');
    if (source === 'cloudflare' && !cloudflareConfigured(config)) {
      return sourceState(source, 'not_configured', observedAt, [], 'Conta, token e gateway da Cloudflare não estão configurados.');
    }
    try {
      const discovery = source === 'local'
        ? await discoverLocal(candidates, fetchImpl, config)
        : source === 'vercel'
          ? await discoverVercel(candidates, fetchImpl, config)
          : await discoverCloudflare(candidates, fetchImpl, config, readKey);
      const data = await Promise.all(discovery.models.map(async (model) => {
        const cached = certifications.get(model.id);
        if (cached && observedAt.getTime() < cached.expiresAt) return { ...model, ...cached.value };
        const value = await certifyCandidate(model, observedAt, certify, certificationTtlMs);
        certifications.set(model.id, { value: certificationFields(value), expiresAt: new Date(value.certification.expires_at).getTime() });
        return value;
      }));
      return sourceState(source, discovery.issues.length ? 'degraded' : 'available', observedAt, data, discovery.issues.join(' '));
    } catch (error) {
      return sourceState(source, 'degraded', observedAt, [], honestCatalogError(error));
    }
  }

  return { read, requireSelectable };
}

async function discoverLocal(candidates, fetchImpl, config) {
  const found = [];
  const issues = [];
  for (const model of candidates) {
    try {
      const base = upstreamBaseUrl(config, model);
      const [health, models] = await Promise.all([
        fetchJson(fetchImpl, `${base}/health`, {}, 3000),
        fetchJson(fetchImpl, `${base}/v1/models`, {}, 3000),
      ]);
      if (health?.ok === false) throw new Error('health respondeu ok=false');
      const exact = arrayData(models).some((item) => item?.id === model.modelId);
      if (!exact) throw new Error(`o upstream não anunciou ${model.modelId}`);
      found.push(publicCandidate(model, findModel(arrayData(models), model.modelId)));
    } catch (error) {
      issues.push(`${model.id}: ${honestCatalogError(error)}`);
    }
  }
  return { models: found, issues };
}

async function discoverVercel(candidates, fetchImpl, config) {
  const url = config.vercel?.catalogUrl ?? 'https://ai-gateway.vercel.sh/v1/models';
  const catalog = await fetchJson(fetchImpl, url, {}, 5000);
  const language = arrayData(catalog).filter((item) => !item?.type || item.type === 'language');
  const models = candidates.flatMap((candidate) => {
    const live = findModel(language, candidate.modelId);
    return live ? [publicCandidate(candidate, live)] : [];
  });
  const found = new Set(models.map((model) => model.id));
  return { models, issues: candidates.filter((candidate) => !found.has(candidate.id)).map((candidate) => `${candidate.id}: ausente do catálogo Vercel vigente.`) };
}

async function discoverCloudflare(candidates, fetchImpl, config, readKey) {
  const accountId = config.cloudflare.accountId;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search`;
  const token = readKey(config.cloudflare.key);
  if (!token) throw new Error('o token do catálogo Cloudflare não está disponível');
  const catalog = await fetchJson(fetchImpl, url, { headers: { authorization: `Bearer ${token}` } }, 5000);
  if (catalog?.success === false) throw new Error('a API de modelos Cloudflare recusou a consulta');
  const language = arrayData(catalog).filter(isTextGenerationModel);
  const models = candidates.flatMap((candidate) => {
    const live = findModel(language, candidate.modelId);
    return live ? [publicCandidate(candidate, live)] : [];
  });
  const found = new Set(models.map((model) => model.id));
  return { models, issues: candidates.filter((candidate) => !found.has(candidate.id)).map((candidate) => `${candidate.id}: ausente do catálogo Workers AI vigente.`) };
}

async function certifyCandidate(candidate, observedAt, certify, certificationTtlMs) {
  const certifiedAt = observedAt.toISOString();
  const expiresAt = new Date(observedAt.getTime() + certificationTtlMs).toISOString();
  try {
    const result = await certify(candidate.route);
    const checks = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, result?.checks?.[name] === true]));
    const passed = result?.profile === 'dream-agent.v1' && result?.passed === true && REQUIRED_CHECKS.every((name) => checks[name]);
    return {
      ...candidate,
      selectable: passed,
      certification: {
        profile: 'dream-agent.v1',
        status: passed ? 'current' : 'failed',
        certified_at: certifiedAt,
        expires_at: expiresAt,
        checks,
        ...(result?.reason ? { reason: String(result.reason) } : {}),
      },
    };
  } catch (error) {
    return {
      ...candidate,
      selectable: false,
      certification: {
        profile: 'dream-agent.v1', status: 'failed', certified_at: certifiedAt, expires_at: expiresAt,
        checks: Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, false])),
        reason: honestCatalogError(error),
      },
    };
  }
}

function publicCandidate(route, live) {
  return {
    id: route.id,
    object: 'model',
    name: live?.name || live?.display_name || route.id,
    source: route.source,
    upstream_model: route.modelId,
    context_window: live?.context_window ?? live?.context_length ?? null,
    capabilities: route.capabilities ?? {},
    route,
  };
}

function certificationFields(model) {
  return { selectable: model.selectable, certification: model.certification };
}

function sourceState(id, status, observedAt, data, message) {
  return {
    id,
    label: SOURCE_LABELS[id],
    status,
    checked_at: observedAt.toISOString(),
    model_count: data.length,
    ...(message ? { message } : {}),
    data,
  };
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${new URL(url).host} respondeu HTTP ${response.status}`);
  return response.json();
}

function arrayData(value) {
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value)) return value;
  return [];
}

function findModel(models, id) {
  return models.find((item) => item?.id === id || item?.name === id);
}

function isTextGenerationModel(model) {
  const values = [model?.task?.name, model?.task, ...(Array.isArray(model?.tasks) ? model.tasks : [])]
    .filter(Boolean).map((value) => String(value).toLowerCase());
  return values.some((value) => value === 'text generation' || value === 'text-generation' || value === 'text_generation');
}

function cloudflareConfigured(config) {
  return Boolean(config.cloudflare?.accountId && config.cloudflare?.gatewayId && config.cloudflare?.key);
}

function readRuntimeKey(name) {
  if (!name) return '';
  const file = projectPath('runtime', 'keys', name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
}

function honestCatalogError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'A consulta desta origem expirou.';
  return error instanceof Error && error.message ? error.message : 'A consulta desta origem falhou.';
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('');
  return '';
}
