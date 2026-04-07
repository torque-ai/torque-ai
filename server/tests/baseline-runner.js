'use strict';

const path = require('path');
const os = require('os');
process.env.TORQUE_DATA_DIR = process.env.TORQUE_DATA_DIR || path.join(os.tmpdir(), 'torque-baseline-test');
const db = require('../database');
db.init();
const config = require('../config');
config.init({ db });

const { runAgenticLoop } = require('../providers/ollama-agentic');
const { createToolExecutor, TOOL_DEFINITIONS } = require('../providers/ollama-tools');
const openaiAdapter = require('../providers/adapters/openai-chat');
const ollamaAdapter = require('../providers/adapters/ollama-chat');
const googleAdapter = require('../providers/adapters/google-chat');
const { TOOL_DEFINITIONS: TOOL_DEFS_FOR_PROMPT } = require('../providers/ollama-tools');

const WD = process.env.BASELINE_WORKING_DIR || process.cwd();
const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
const platformRule = process.platform === 'win32'
  ? '8. This is a Windows environment. Use PowerShell or cmd syntax, not Unix.'
  : '8. This is a Linux/macOS environment. Use bash commands.';

const SYSTEM = `You are an expert software engineer.

You are an autonomous coding agent with tool access. Complete the task using ONLY the provided tools.

RULES:
1. Use tools to read files, make edits, list directories, search code, and run commands.
2. NEVER describe what you would do - actually do it with tools.
3. ONLY modify files explicitly mentioned in the task. Do NOT touch unrelated files.
4. If a build/test fails for reasons UNRELATED to your change, report the failure and stop.
5. If a tool call fails, try ONE alternative approach. If that also fails, report the error and stop.
6. When done, respond with a COMPLETE summary that includes the actual data from tool results.
7. Be efficient - you have limited iterations. Do ONLY what the task asks.
${platformRule}

Working directory: ${WD}`;

const TASK = 'Use list_directory to list the tests/ directory. Report exact folder names and total count.';

async function test(name, adapter, opts) {
  const start = Date.now();
  try {
    const result = await runAgenticLoop({
      adapter, systemPrompt: SYSTEM, taskPrompt: TASK,
      tools: TOOL_DEFINITIONS, toolExecutor: createToolExecutor(WD),
      options: opts, workingDir: WD, timeoutMs: 90000, maxIterations: 5, contextBudget: 8000,
    });
    const ms = Date.now() - start;
    const tools = result.toolLog.map(t => t.name).join(',') || 'none';
    const has13 = result.output.includes('13');
    const hasApp = result.output.includes('example-project.App.Tests');
    const hasDomain = result.output.includes('example-project.Domain.Tests');
    console.log(
      name.padEnd(22) + ' | ' + String(ms).padStart(6) + 'ms | ' +
      result.iterations + ' iters | ' + result.toolLog.length + ' tools (' + tools + ') | ' +
      'count=' + has13 + ' names=' + (hasApp && hasDomain) + ' | ' +
      result.output.replace(/\n/g, ' ').slice(0, 120)
    );
  } catch (e) {
    const ms = Date.now() - start;
    console.log(name.padEnd(22) + ' | ' + String(ms).padStart(6) + 'ms | ERROR: ' + e.message.slice(0, 120));
  }
}

(async () => {
  console.log('=== FULL BASELINE TEST: List tests/ directory ===');
  console.log('Provider'.padEnd(22) + ' |   Time  | Iters | Tools               | Accuracy          | Output preview');
  console.log('-'.repeat(160));

  // Cloud providers in parallel
  await Promise.all([
    test('cerebras', openaiAdapter, {
      host: 'https://api.cerebras.ai', apiKey: config.getApiKey('cerebras'),
      model: 'qwen-3-235b-a22b-instruct-2507', temperature: 0.3,
    }),
    test('groq', openaiAdapter, {
      host: 'https://api.groq.com/openai', apiKey: config.getApiKey('groq'),
      model: 'llama-3.3-70b-versatile', temperature: 0.3,
    }),
    test('ollama-cloud', ollamaAdapter, {
      host: 'https://api.ollama.com', apiKey: config.getApiKey('ollama-cloud'),
      model: 'devstral-2:123b',
    }),
    test('google-ai', googleAdapter, {
      host: 'https://generativelanguage.googleapis.com',
      apiKey: config.getApiKey('google-ai'),
      model: 'gemini-2.5-flash',
    }),
    test('openrouter (free)', openaiAdapter, {
      host: 'https://openrouter.ai/api', apiKey: config.getApiKey('openrouter'),
      model: 'nvidia/nemotron-3-nano-30b-a3b:free', temperature: 0.3,
    }),
  ]);

  // Local Ollama (sequential - shared GPU)
  await test('ollama (qwen2.5-32b)', ollamaAdapter, {
    host: ollamaHost, model: 'qwen3-coder:30b',
  });

  // Codestral needs prompt-injected tools
  const toolDefs = TOOL_DEFS_FOR_PROMPT.map(t => JSON.stringify({
    type: t.type, function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
  })).join(',');
  const codestralSystem = '[AVAILABLE_TOOLS][' + toolDefs + '][/AVAILABLE_TOOLS]\n' + SYSTEM +
    '\nTo call a tool, respond with ONLY a JSON array: [{"name":"tool_name","arguments":{}}]\nAfter receiving [TOOL_RESULTS], give a clear summary with the ACTUAL data returned.';

  // Custom test for codestral with prompt injection
  const csStart = Date.now();
  try {
    const csResult = await runAgenticLoop({
      adapter: ollamaAdapter,
      systemPrompt: codestralSystem,
      taskPrompt: TASK, tools: [], promptInjectedTools: true,
      toolExecutor: createToolExecutor(WD),
      options: { host: ollamaHost, model: 'qwen3-coder:30b' },
      workingDir: WD, timeoutMs: 90000, maxIterations: 5, contextBudget: 8000,
    });
    const ms = Date.now() - csStart;
    const tools = csResult.toolLog.map(t => t.name).join(',') || 'none';
    const has13 = csResult.output.includes('13');
    const hasApp = csResult.output.includes('example-project.App.Tests');
    const hasDomain = csResult.output.includes('example-project.Domain.Tests');
    console.log(
      'codestral (prompt-inj)'.padEnd(22) + ' | ' + String(ms).padStart(6) + 'ms | ' +
      csResult.iterations + ' iters | ' + csResult.toolLog.length + ' tools (' + tools + ') | ' +
      'count=' + has13 + ' names=' + (hasApp && hasDomain) + ' | ' +
      csResult.output.replace(/\n/g, ' ').slice(0, 120)
    );
  } catch (e) {
    console.log('codestral (prompt-inj)'.padEnd(22) + ' | ' + String(Date.now() - csStart).padStart(6) + 'ms | ERROR: ' + e.message.slice(0, 120));
  }

  process.exit(0);
})();
