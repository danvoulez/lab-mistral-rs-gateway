import { HttpInputError } from './promptPolicy.js';

export function resolveRoute(config, body) {
  const requested = typeof body?.model === 'string' ? body.model : '';
  if (!requested.trim()) {
    throw new HttpInputError(400, 'Escolha um modelo da Golden Bridge.', 'model_required');
  }
  const model = config.models.find((candidate) => candidate.id === requested);
  if (!model) {
    throw new HttpInputError(404, `O modelo ${requested} não está no catálogo vigente da Golden Bridge.`, 'model_unknown', { model: requested });
  }
  return model;
}

export function routeHeaders(model) {
  if (model.source !== 'cloudflare') return {};
  return {
    'cf-aig-gateway-id': model.upstream?.gatewayId || 'golden-bridge',
    'cf-aig-max-attempts': '1',
    'cf-aig-skip-cache': 'true'
  };
}

export function verifyExecutedModel(model, upstreamModel) {
  if (upstreamModel !== model.modelId) {
    throw new HttpInputError(
      502,
      'A rota executada não corresponde ao modelo solicitado. Nada foi aceito como resposta.',
      'route_mismatch',
      { requested_model: model.id, expected_upstream_model: model.modelId, observed_upstream_model: upstreamModel || null }
    );
  }
}

export function sourceId(model) {
  if (model.source === 'vercel') return 'vercel-ai-gateway';
  if (model.source === 'cloudflare') return 'cloudflare-ai-gateway';
  return 'local';
}
