import { upstreamAuthHeaders, upstreamEndpoint } from './config.js';

export async function generateCompletion(config, model, normalized, body) {
  const started = Date.now();
  const response = await fetch(upstreamEndpoint(config, model, 'chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...upstreamAuthHeaders(config, model) },
    signal: AbortSignal.timeout(config.gateway.requestTimeoutMs),
    body: JSON.stringify(toUpstreamBody(model, normalized, body, false))
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`mistralrs upstream returned ${response.status}: ${text.slice(0, 1000)}`);
  }

  const json = JSON.parse(text);
  // llama.cpp exposes real GPU timings; cloud providers bill tokens instead.
  const timings = json.timings || null;
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    finishReason: json.choices?.[0]?.finish_reason ?? 'stop',
    usage: json.usage,
    upstream: json,
    upstreamMs: Date.now() - started,
    upstreamStatus: response.status,
    computeMs: timings
      ? Math.round((timings.prompt_ms || 0) + (timings.predicted_ms || 0))
      : null
  };
}

export async function streamCompletion(config, model, normalized, body) {
  const response = await fetch(upstreamEndpoint(config, model, 'chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...upstreamAuthHeaders(config, model) },
    signal: AbortSignal.timeout(config.gateway.requestTimeoutMs),
    body: JSON.stringify(toUpstreamBody(model, normalized, body, true))
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`mistralrs upstream returned ${response.status}: ${text.slice(0, 1000)}`);
  }

  return response.body;
}

function toUpstreamBody(model, normalized, body, stream) {
  return {
    model: model.modelId,
    messages: normalized.messages,
    temperature: body.temperature ?? 0,
    top_p: body.top_p,
    stop: body.stop,
    max_tokens: body.max_tokens || model.maxOutputTokens || 1024,
    stream
  };
}
