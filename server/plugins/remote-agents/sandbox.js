'use strict';

const vm = require('vm');

/**
 * Default execution timeout for code_agent snippets (10 seconds).
 * Prevents runaway loops from blocking the event loop indefinitely.
 */
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Maximum output length captured from console.log calls within the sandbox.
 * Prevents memory exhaustion from code that produces unbounded output.
 */
const MAX_OUTPUT_LENGTH = 1024 * 1024; // 1 MB

/**
 * Execute a code snippet in a sandboxed VM context with access to
 * a controlled set of tools.
 *
 * The sandbox follows the smolagents CodeAgent pattern: the code string
 * IS the action. It can call tools by name, use variables, loops, and
 * conditionals — but it cannot access the filesystem, network, child
 * processes, or Node.js built-in modules.
 *
 * @param {string} code - JavaScript code snippet to execute
 * @param {Record<string, Function>} tools - Map of tool name → async handler function
 * @param {object} [context={}] - Execution context (variables available as `context` in the sandbox)
 * @param {object} [options={}]
 * @param {number} [options.timeout] - Execution timeout in ms (default 10000)
 * @returns {Promise<{ success: boolean, output: string, result: *, tool_calls: Array<{ tool: string, args: *, result: * }>, error: string }>}
 */
async function executeCodeAgentCode(code, tools, context, options) {
  const timeout = (options && typeof options.timeout === 'number' && options.timeout > 0)
    ? options.timeout
    : DEFAULT_TIMEOUT_MS;

  if (typeof code !== 'string' || !code.trim()) {
    return {
      success: false,
      output: '',
      result: undefined,
      tool_calls: [],
      error: 'code must be a non-empty string',
    };
  }

  const toolCallLog = [];
  let outputBuffer = '';
  let outputTruncated = false;

  function appendOutput(text) {
    if (outputTruncated) return;
    const str = String(text);
    if (outputBuffer.length + str.length > MAX_OUTPUT_LENGTH) {
      outputBuffer += str.slice(0, MAX_OUTPUT_LENGTH - outputBuffer.length);
      outputBuffer += '\n[output truncated]';
      outputTruncated = true;
    } else {
      outputBuffer += str;
    }
  }

  // Build a tool proxy: each tool becomes a synchronous-looking function
  // that records the call and returns a promise. The code snippet should
  // be wrapped in an async IIFE by the caller if it needs to await tools.
  const toolProxy = Object.create(null);
  const safeTools = (tools && typeof tools === 'object') ? tools : {};
  for (const [name, handler] of Object.entries(safeTools)) {
    if (typeof handler !== 'function') continue;
    toolProxy[name] = async function toolCall(...args) {
      const entry = { tool: name, args: args.length === 1 ? args[0] : args, result: undefined };
      toolCallLog.push(entry);
      try {
        const result = await handler(...args);
        entry.result = result;
        return result;
      } catch (err) {
        entry.result = { error: err.message || String(err) };
        throw err;
      }
    };
  }

  // Build the sandbox globals. Only expose:
  // - console.log (captured to outputBuffer)
  // - tools object (proxied tool functions)
  // - context (read-only execution context from the caller)
  // - Promise, JSON, Math, Array, Object, String, Number, Boolean, Date,
  //   RegExp, Map, Set, Symbol, Error, parseInt, parseFloat, isNaN,
  //   isFinite, undefined, NaN, Infinity
  const sandboxGlobals = {
    console: Object.freeze({
      log: (...args) => appendOutput(args.map(String).join(' ') + '\n'),
      warn: (...args) => appendOutput('[warn] ' + args.map(String).join(' ') + '\n'),
      error: (...args) => appendOutput('[error] ' + args.map(String).join(' ') + '\n'),
      info: (...args) => appendOutput('[info] ' + args.map(String).join(' ') + '\n'),
    }),
    tools: Object.freeze(toolProxy),
    context: Object.freeze(Object.assign(Object.create(null), context || {})),
    // Safe built-ins
    Promise,
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date,
    RegExp,
    Map,
    Set,
    Symbol,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    undefined,
    NaN,
    Infinity,
  };

  const vmContext = vm.createContext(sandboxGlobals, {
    name: 'code_agent_sandbox',
    // Prevent the sandbox code from escaping to the host via constructor chains
    codeGeneration: { strings: false, wasm: false },
  });

  try {
    // Wrap the user code in an async IIFE so top-level await works
    // and we get a single return value.
    const wrappedCode = `(async () => {\n${code}\n})()`;

    const script = new vm.Script(wrappedCode, {
      filename: 'code_agent_snippet.js',
    });

    const resultPromise = script.runInContext(vmContext, { timeout });
    const result = await resultPromise;

    return {
      success: true,
      output: outputBuffer,
      result: result === undefined ? null : result,
      tool_calls: toolCallLog,
      error: '',
    };
  } catch (err) {
    return {
      success: false,
      output: outputBuffer,
      result: undefined,
      tool_calls: toolCallLog,
      error: err.message || String(err),
    };
  }
}

module.exports = { executeCodeAgentCode, DEFAULT_TIMEOUT_MS, MAX_OUTPUT_LENGTH };
