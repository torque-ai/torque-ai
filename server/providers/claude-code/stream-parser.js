'use strict';

const { randomUUID } = require('crypto');
const { EventType } = require('../../streaming/event-types');

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  let combined = '';
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.text === 'string') {
      combined += entry.text;
      continue;
    }
    if (entry.type === 'text' && typeof entry.content === 'string') {
      combined += entry.content;
    }
  }
  return combined;
}

function normalizeToolCall(record) {
  if (!record || typeof record !== 'object') return null;

  if ((record.type === 'tool_call' || record.type === EventType.TOOL_CALL) && record.name) {
    return {
      tool_call_id: cleanText(record.tool_call_id) || cleanText(record.id) || `tool_${randomUUID()}`,
      name: cleanText(record.name),
      args: record.args && typeof record.args === 'object' ? record.args : {},
    };
  }

  if ((record.type === 'tool_use' || record.type === 'content_block_start') && record.name) {
    return {
      tool_call_id: cleanText(record.tool_call_id) || cleanText(record.id) || `tool_${randomUUID()}`,
      name: cleanText(record.name),
      args: record.input && typeof record.input === 'object'
        ? record.input
        : (record.args && typeof record.args === 'object' ? record.args : {}),
    };
  }

  const block = record.content_block;
  if (block && block.type === 'tool_use' && block.name) {
    return {
      tool_call_id: cleanText(block.id) || `tool_${randomUUID()}`,
      name: cleanText(block.name),
      args: block.input && typeof block.input === 'object' ? block.input : {},
    };
  }

  return null;
}

function normalizeToolResult(record) {
  if (!record || typeof record !== 'object') return null;

  const toContent = (value, error = null) => {
    if (value === undefined || value === null || value === '') {
      return error ? JSON.stringify({ error }) : '';
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  };

  if ((record.type === 'tool_result' || record.type === EventType.TOOL_RESULT) && (record.tool_call_id || record.id)) {
    const error = cleanText(record.error) || null;
    return {
      tool_call_id: cleanText(record.tool_call_id) || cleanText(record.id) || `tool_${randomUUID()}`,
      content: toContent(record.result ?? record.output ?? record.content, error),
      error,
    };
  }

  const block = record.content_block;
  if (block && block.type === 'tool_result') {
    const error = cleanText(block.error) || null;
    return {
      tool_call_id: cleanText(block.tool_use_id) || cleanText(block.tool_call_id) || cleanText(block.id) || `tool_${randomUUID()}`,
      content: toContent(block.content ?? block.result ?? block.output, error),
      error,
    };
  }

  return null;
}

function normalizeUsage(record) {
  if (!record || typeof record !== 'object') return null;
  const usage = record.usage && typeof record.usage === 'object' ? record.usage : null;
  if (!usage) return null;

  const promptTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const completionTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || (promptTokens + completionTokens));

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function extractTextDelta(record) {
  if (!record || typeof record !== 'object') return '';

  if (record.type === 'text_delta' && typeof record.delta === 'string') {
    return record.delta;
  }

  if (record.type === 'content_block_delta' && typeof record.delta?.text === 'string') {
    return record.delta.text;
  }

  if (record.delta && typeof record.delta === 'string') {
    return record.delta;
  }

  return '';
}

function extractFallbackText(record) {
  if (!record || typeof record !== 'object') return '';

  if (typeof record.text === 'string') return record.text;
  if (typeof record.output === 'string') return record.output;
  if (typeof record.result === 'string') return record.result;
  if (typeof record.message === 'string') return record.message;

  if (record.message && typeof record.message === 'object') {
    if (typeof record.message.content === 'string') return record.message.content;
    const contentText = extractTextFromContent(record.message.content);
    if (contentText) return contentText;
  }

  const contentText = extractTextFromContent(record.content);
  if (contentText) return contentText;

  return '';
}

module.exports = {
  cleanText,
  extractTextFromContent,
  normalizeToolCall,
  normalizeToolResult,
  normalizeUsage,
  extractTextDelta,
  extractFallbackText,
};
