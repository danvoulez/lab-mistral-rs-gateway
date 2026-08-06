import crypto from 'node:crypto';

const allowedRoles = new Set(['system', 'user', 'assistant', 'tool']);

export function cleanText(value) {
  return String(value ?? '')
    .replace(/\uFEFF/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

export function normalizeChatRequest(body, { systemPolicy = '', systemMode = 'replace' } = {}) {
  if (!body || typeof body !== 'object') {
    throw new HttpInputError(400, 'request body must be a JSON object');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpInputError(400, 'messages must be a non-empty array');
  }

  const requestSystems = [];
  const dialogue = [];

  for (const [index, message] of body.messages.entries()) {
    if (!message || typeof message !== 'object') {
      throw new HttpInputError(400, `messages[${index}] must be an object`);
    }
    if (!allowedRoles.has(message.role)) {
      throw new HttpInputError(400, `messages[${index}].role is not supported`);
    }

    const content = normalizeContent(message.content, index);
    if (!content) continue;

    if (message.role === 'system') {
      requestSystems.push(content);
    } else {
      dialogue.push({ role: message.role, content });
    }
  }

  if (dialogue.length === 0) {
    throw new HttpInputError(400, 'at least one non-system message is required');
  }

  const cleanPolicy = cleanText(systemPolicy);
  const cleanRequestSystem = cleanText(requestSystems.join('\n\n'));
  const mode = systemMode || 'replace';
  const messages = [];

  if (mode === 'replace') {
    if (cleanPolicy) messages.push({ role: 'system', content: cleanPolicy });
  } else if (mode === 'prepend') {
    const combined = [cleanPolicy, cleanRequestSystem].filter(Boolean).join('\n\n');
    if (combined) messages.push({ role: 'system', content: combined });
  } else if (mode === 'pass') {
    if (cleanRequestSystem) messages.push({ role: 'system', content: cleanRequestSystem });
  } else {
    throw new HttpInputError(500, `unknown gateway.systemMode ${mode}`);
  }

  messages.push(...dialogue);
  return {
    messages,
    promptHash: hashMessages(messages),
    systemMode: mode,
    strippedSystemMessages: mode === 'replace' ? requestSystems.length : 0
  };
}

function normalizeContent(content, index) {
  if (typeof content === 'string') return cleanText(content);

  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part && typeof part === 'object' && part.type === 'text')
      .map((part) => cleanText(part.text))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
    throw new HttpInputError(400, `messages[${index}].content has no supported text parts`);
  }

  throw new HttpInputError(400, `messages[${index}].content must be text or text parts`);
}

function hashMessages(messages) {
  return crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

export class HttpInputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
