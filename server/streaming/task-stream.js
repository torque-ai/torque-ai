'use strict';

const { randomUUID } = require('crypto');
const { selectToolsForTask, createToolExecutor } = require('../providers/ollama-tools');
const { chatCompletion: openaiChatCompletion } = require('../providers/adapters/openai-chat');
const { chatCompletion: googleChatCompletion } = require('../providers/adapters/google-chat');

const CHAT_ADAPTERS = {
  'google-ai': googleChatCompletion,
  groq: openaiChatCompletion,
  cerebras: openaiChatCompletion,
  openrouter: openaiChatCompletion,
};

function normalizeMessageContent(content) {
  if (typeof content !== 'string') {
    return JSON.stringify(content ?? '');
  }

  try {
    const parsed = JSON.parse(content);
    return typeof parsed === 'string' ? parsed : content;
  } catch {
    return content;
  }
}

function normalizeToolCall(call) {
  if (!call || typeof call !== 'object') {
    return null;
  }

  if (call.function && typeof call.function === 'object') {
    return {
      id: call.id || call.tool_call_id || randomUUID(),
      type: call.type || 'function',
      function: {
        name: call.function.name,
        arguments: call.function.arguments ?? {},
      },
    };
  }

  const name = call.name || call.function_name;
  if (!name) {
    return null;
  }

  return {
    id: call.tool_call_id || call.id || randomUUID(),
    type: 'function',
    function: {
      name,
      arguments: call.args ?? call.arguments ?? {},
    },
  };
}

function normalizeMessages(messages = []) {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') {
      return message;
    }

    const normalized = {
      ...message,
      content: normalizeMessageContent(message.content),
    };

    if (Array.isArray(message.tool_calls)) {
      normalized.tool_calls = message.tool_calls
        .map(normalizeToolCall)
        .filter(Boolean);
    }

    return normalized;
  });
}

function renderPromptFromMessages(messages = []) {
  const normalizedMessages = normalizeMessages(messages);
  const rendered = [];

  for (const message of normalizedMessages) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (content) {
      rendered.push(`${message.role || 'message'}: ${content}`);
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        rendered.push(
          `assistant_tool_call: ${call.function?.name || 'unknown'} ${JSON.stringify(call.function?.arguments ?? {})}`,
        );
      }
    }
  }

  return rendered.join('\n\n').trim();
}

function extractToolDefinitions(tools = {}) {
  return Object.values(tools)
    .map((tool) => tool?.definition)
    .filter(Boolean);
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const normalized = { ...usage };
  const promptTokens = Number(normalized.prompt_tokens ?? normalized.input_tokens ?? 0);
  const completionTokens = Number(normalized.completion_tokens ?? normalized.output_tokens ?? 0);

  if (!Number.isNaN(promptTokens) && promptTokens > 0) {
    normalized.prompt_tokens = promptTokens;
  }
  if (!Number.isNaN(completionTokens) && completionTokens > 0) {
    normalized.completion_tokens = completionTokens;
  }
  if (!normalized.total_tokens && (normalized.prompt_tokens || normalized.completion_tokens)) {
    normalized.total_tokens = (normalized.prompt_tokens || 0) + (normalized.completion_tokens || 0);
  }

  return normalized;
}

function createEventQueue() {
  const items = [];
  let waiter = null;
  let failure = null;
  let closed = false;

  function notify() {
    if (typeof waiter === 'function') {
      const next = waiter;
      waiter = null;
      next();
    }
  }

  return {
    push(item) {
      if (closed) return;
      items.push(item);
      notify();
    },
    close() {
      if (closed) return;
      closed = true;
      notify();
    },
    fail(err) {
      if (closed) return;
      failure = err;
      closed = true;
      notify();
    },
    async *iterate() {
      while (items.length > 0 || !closed) {
        if (items.length === 0) {
          await new Promise((resolve) => {
            waiter = resolve;
          });
          if (items.length === 0 && closed && failure) {
            throw failure;
          }
        }

        while (items.length > 0) {
          yield items.shift();
        }
      }

      if (failure) {
        throw failure;
      }
    },
  };
}

async function* streamWithChatAdapter({
  adapter,
  providerName,
  provider,
  model,
  messages,
  tools,
  signal,
}) {
  const queue = createEventQueue();
  let sawChunk = false;

  const run = adapter({
    host: provider.baseUrl,
    apiKey: provider.apiKey,
    model: model || provider.defaultModel || null,
    providerName,
    messages: normalizeMessages(messages),
    tools: extractToolDefinitions(tools),
    options: { stream: true },
    signal,
    onChunk: (delta) => {
      if (typeof delta === 'string' && delta.length > 0) {
        sawChunk = true;
        queue.push({ type: 'text_delta', delta });
      }
    },
  }).then((response) => {
    const message = response?.message || {};
    if (!sawChunk && typeof message.content === 'string' && message.content.length > 0) {
      queue.push({ type: 'text_delta', delta: message.content });
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      queue.push({
        type: 'tool_call',
        tool_call_id: call.id || randomUUID(),
        name: call.function?.name || 'unknown_tool',
        args: call.function?.arguments ?? {},
      });
    }

    const usage = normalizeUsage(response?.usage);
    if (usage) {
      queue.push({ type: 'usage', ...usage });
    }

    queue.push({
      type: 'step_completed',
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    });
    queue.close();
  }).catch((err) => {
    queue.fail(err);
  });

  for await (const item of queue.iterate()) {
    yield item;
  }

  await run;
}

async function* streamWithProviderFallback({
  provider,
  model,
  messages,
  workingDirectory,
  timeoutMinutes,
  signal,
}) {
  const queue = createEventQueue();
  let sawChunk = false;

  const prompt = renderPromptFromMessages(messages);
  const options = {
    working_directory: workingDirectory,
    timeout: timeoutMinutes,
    signal,
  };

  const run = (typeof provider.submitStream === 'function'
    ? provider.submitStream(prompt, model || provider.defaultModel || null, {
      ...options,
      onChunk: (delta) => {
        if (typeof delta === 'string' && delta.length > 0) {
          sawChunk = true;
          queue.push({ type: 'text_delta', delta });
        }
      },
    })
    : provider.submit(prompt, model || provider.defaultModel || null, options)
  ).then((result) => {
    if (!sawChunk && typeof result?.output === 'string' && result.output.length > 0) {
      queue.push({ type: 'text_delta', delta: result.output });
    }

    const usage = normalizeUsage(result?.usage);
    if (usage) {
      queue.push({ type: 'usage', ...usage });
    }

    queue.push({ type: 'step_completed', finish_reason: 'stop' });
    queue.close();
  }).catch((err) => {
    queue.fail(err);
  });

  for await (const item of queue.iterate()) {
    yield item;
  }

  await run;
}

function buildToolSurface(task, options = {}) {
  const taskDescription = typeof task?.task_description === 'string' ? task.task_description : '';
  const workingDirectory = typeof task?.working_directory === 'string' && task.working_directory.trim()
    ? task.working_directory
    : process.cwd();
  const commandMode = options.commandMode || 'unrestricted';

  const definitions = selectToolsForTask(taskDescription, { commandMode });
  const executor = createToolExecutor(workingDirectory, { commandMode });

  return Object.fromEntries(definitions.map((definition) => {
    const name = definition?.function?.name;
    return [
      name,
      {
        definition,
        async handler(args = {}) {
          const result = await Promise.resolve(executor.execute(name, args));
          if (result?.error) {
            throw new Error(
              typeof result.error === 'string'
                ? result.error
                : (typeof result.result === 'string' ? result.result : `Tool failed: ${name}`),
            );
          }
          return result?.result;
        },
      },
    ];
  }).filter(([name]) => Boolean(name)));
}

function createTaskCallProvider(task, provider, options = {}) {
  const providerName = task?.provider || provider?.name || '';
  const adapter = CHAT_ADAPTERS[providerName] || null;
  const model = task?.model || provider?.defaultModel || null;
  const workingDirectory = typeof task?.working_directory === 'string' && task.working_directory.trim()
    ? task.working_directory
    : process.cwd();
  const timeoutMinutes = Number(task?.timeout_minutes) || 30;
  const signal = options.signal;

  return async function* callProvider({ messages, tools }) {
    if (adapter && provider?.baseUrl && provider?.apiKey) {
      yield* streamWithChatAdapter({
        adapter,
        providerName,
        provider,
        model,
        messages,
        tools,
        signal,
      });
      return;
    }

    yield* streamWithProviderFallback({
      provider,
      model,
      messages,
      workingDirectory,
      timeoutMinutes,
      signal,
    });
  };
}

module.exports = {
  buildToolSurface,
  createTaskCallProvider,
  normalizeMessages,
  renderPromptFromMessages,
};
