'use strict';

process.env.TORQUE_DATA_DIR = 'C:/Users/Werem/Projects/torque/server';
const db = require('../database');
db.init();
const config = require('../config');
config.init({ db });

const { runAgenticLoop } = require('../providers/ollama-agentic');
const { createToolExecutor, TOOL_DEFINITIONS } = require('../providers/ollama-tools');
const openaiAdapter = require('../providers/adapters/openai-chat');
const ollamaAdapter = require('../providers/adapters/ollama-chat');

const WD = 'C:/Users/Werem/Projects/SpudgetBooks';
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
    const hasApp = result.output.includes('SpudgetBooks.App.Tests');
    const hasDomain = result.output.includes('SpudgetBooks.Domain.Tests');
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
  ]);

  // Local Ollama (sequential - shared GPU)
  await test('ollama (qwen2.5-32b)', ollamaAdapter, {
    host: 'http://192.168.1.183:11434', model: 'qwen2.5-coder:32b',
  });
  await test('ollama (codestral)', ollamaAdapter, {
    host: 'http://192.168.1.183:11434', model: 'codestral:22b',
  });

  // Expected to fail
  console.log('-'.repeat(160));
  await test('openrouter (free)', openaiAdapter, {
    host: 'https://openrouter.ai/api', apiKey: config.getApiKey('openrouter'),
    model: 'nvidia/nemotron-3-nano-30b-a3b:free', temperature: 0.3,
  });

  process.exit(0);
})();
