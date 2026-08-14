import crypto from 'node:crypto';

const allowedRoles = new Set(['system', 'user', 'assistant', 'tool']);

export function normalizeChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpInputError(400, 'request body must be a JSON object', 'invalid_request');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpInputError(400, 'messages must be a non-empty array', 'messages_required');
  }

  let nonSystem = 0;
  for (const [index, message] of body.messages.entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new HttpInputError(400, `messages[${index}] must be an object`, 'message_invalid');
    }
    if (!allowedRoles.has(message.role)) {
      throw new HttpInputError(400, `messages[${index}].role is not supported`, 'message_role_invalid');
    }
    if (message.role !== 'system') nonSystem += 1;
    validateContent(message, index);
    validateToolShape(message, index);
  }
  if (nonSystem === 0) {
    throw new HttpInputError(400, 'at least one non-system message is required', 'dialogue_required');
  }

  return {
    messages: body.messages,
    promptHash: crypto.createHash('sha256').update(JSON.stringify(body.messages)).digest('hex')
  };
}

function validateContent(message, index) {
  const { content } = message;
  if (typeof content === 'string') return;
  if (Array.isArray(content) && content.every((part) => part && typeof part === 'object' && !Array.isArray(part) && typeof part.type === 'string')) return;
  if (message.role === 'assistant' && content === null && Array.isArray(message.tool_calls) && message.tool_calls.length) return;
  throw new HttpInputError(400, `messages[${index}].content must be text, content parts, or null with tool_calls`, 'message_content_invalid');
}

function validateToolShape(message, index) {
  if (message.tool_calls !== undefined) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      throw new HttpInputError(400, `messages[${index}].tool_calls is invalid`, 'tool_calls_invalid');
    }
    for (const call of message.tool_calls) {
      if (!call || typeof call !== 'object' || typeof call.id !== 'string' ||
          call.type !== 'function' || !call.function || typeof call.function.name !== 'string' ||
          typeof call.function.arguments !== 'string') {
        throw new HttpInputError(400, `messages[${index}].tool_calls contains an invalid call`, 'tool_call_invalid');
      }
    }
  }
  if (message.role === 'tool' && typeof message.tool_call_id !== 'string') {
    throw new HttpInputError(400, `messages[${index}].tool_call_id is required`, 'tool_call_id_required');
  }
}

export class HttpInputError extends Error {
  constructor(status, message, code = 'invalid_request', detail = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
