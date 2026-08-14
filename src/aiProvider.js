import { upstreamAuthHeaders, upstreamEndpoint } from './config.js';
import { routeHeaders, verifyExecutedModel } from './routing.js';
import { HttpInputError } from './promptPolicy.js';

export async function generateCompletion(config, model, normalized, body) {
  const started = Date.now();
  const response = await upstreamFetch(config, model, normalized, body, false);
  const text = await response.text();
  if (!response.ok) throw upstreamFailure(response.status, model);

  let json;
  try { json = JSON.parse(text); } catch { throw new HttpInputError(502, 'O provedor devolveu uma resposta inválida.', 'model_unavailable'); }
  verifyExecutedModel(model, json.model);
  const timings = json.timings || null;
  return {
    message: json.choices?.[0]?.message ?? { role: 'assistant', content: '' },
    finishReason: json.choices?.[0]?.finish_reason ?? 'stop',
    usage: json.usage,
    upstream: json,
    upstreamMs: Date.now() - started,
    upstreamStatus: response.status,
    computeMs: timings ? Math.round((timings.prompt_ms || 0) + (timings.predicted_ms || 0)) : null
  };
}

export async function streamCompletion(config, model, normalized, body) {
  const response = await upstreamFetch(config, model, normalized, body, true);
  if (!response.ok) throw upstreamFailure(response.status, model);
  if (!response.body) throw new HttpInputError(502, 'O provedor não abriu o stream solicitado.', 'model_unavailable');
  return verifiedStream(response.body, model);
}

async function verifiedStream(body, model) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const initial = [];
  let text = '';
  let bytes = 0;
  let scan = { carry: '', events: 0 };
  while (scan.events === 0) {
    const { value, done } = await reader.read();
    if (done) throw new HttpInputError(502, 'O stream terminou antes de identificar a rota executada.', 'route_mismatch');
    initial.push(value);
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    scan = scanSse(text, model);
    text = scan.carry;
    if (bytes > 65536 && scan.events === 0) {
      throw new HttpInputError(502, 'O stream não identificou a rota executada.', 'route_mismatch');
    }
  }

  return new ReadableStream({
    async start(controller) {
      for (const chunk of initial) controller.enqueue(chunk);
      let carry = text;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const current = scanSse(carry + decoder.decode(value, { stream: true }), model);
          carry = current.carry;
          controller.enqueue(value);
        }
        const finalText = carry + decoder.decode();
        if (finalText.trim()) scanSse(`${finalText}\n`, model);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
}

function scanSse(text, model) {
  const boundary = text.lastIndexOf('\n');
  if (boundary < 0) return { carry: text, events: 0 };
  const complete = text.slice(0, boundary + 1);
  let events = 0;
  for (const rawLine of complete.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let event;
    try { event = JSON.parse(data); } catch { throw new HttpInputError(502, 'O provedor devolveu um evento de stream inválido.', 'model_unavailable'); }
    verifyExecutedModel(model, event.model);
    events += 1;
  }
  return { carry: text.slice(boundary + 1), events };
}

async function upstreamFetch(config, model, normalized, body, stream) {
  try {
    return await fetch(upstreamEndpoint(config, model, 'chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...upstreamAuthHeaders(config, model),
        ...routeHeaders(model)
      },
      signal: AbortSignal.timeout(config.gateway.requestTimeoutMs),
      body: JSON.stringify(toUpstreamBody(model, normalized, body, stream))
    });
  } catch (error) {
    if (error instanceof HttpInputError) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new HttpInputError(504, `O modelo ${model.id} não respondeu dentro do limite.`, 'model_timeout', { model: model.id });
    }
    throw new HttpInputError(502, `O modelo ${model.id} não pôde ser alcançado pela rota escolhida.`, 'model_unavailable', { model: model.id });
  }
}

function upstreamFailure(status, model) {
  return new HttpInputError(
    502,
    `O modelo ${model.id} não respondeu pela rota escolhida.`,
    'model_unavailable',
    { model: model.id, upstream_status: status }
  );
}

function assertCapabilities(model, body) {
  if (body.tools?.length && model.capabilities?.tools === false) {
    throw new HttpInputError(400, `O modelo ${model.id} não aceita ferramentas.`, 'model_capability_mismatch', { model: model.id, capability: 'tools' });
  }
  if (body.response_format && model.capabilities?.response_format === false) {
    throw new HttpInputError(400, `O modelo ${model.id} não aceita o formato de resposta pedido.`, 'model_capability_mismatch', { model: model.id, capability: 'response_format' });
  }
}

export function toUpstreamBody(model, normalized, body, stream) {
  assertCapabilities(model, body);
  const upstream = { ...body, model: model.modelId, messages: normalized.messages, stream };
  if (model.source === 'vercel') {
    const creator = String(model.modelId).split('/')[0];
    const requestedGateway = body.providerOptions?.gateway || {};
    const gateway = { ...requestedGateway, only: [creator] };
    delete gateway.models;
    upstream.providerOptions = { ...(body.providerOptions || {}), gateway };
  }
  return upstream;
}
