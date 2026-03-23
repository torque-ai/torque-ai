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
4. If a tool call fails, try ONE alternative approach. If that also fails, report the error and stop.
5. When done, respond with a COMPLETE summary that includes the actual data from tool results.
6. Be efficient - you have limited iterations. Do ONLY what the task asks.
${platformRule}

Working directory: ${WD}`;

const TASK = 'Use list_directory to list the tests/ directory. Report exact folder names and total count.';

// Prompt-injected system prompt for codestral
const toolDefs = TOOL_DEFINITIONS.map(t => JSON.stringify({
  type: t.type, function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
})).join(',');
const PI_SYSTEM = `[AVAILABLE_TOOLS][${toolDefs}][/AVAILABLE_TOOLS]
${SYSTEM}
To call a tool, respond with ONLY a JSON array: [{"name":"tool_name","arguments":{}}]
After receiving [TOOL_RESULTS], give a clear summary with the ACTUAL data returned.`;

const results = [];

async function test(name, adapter, opts, extra = {}) {
  const start = Date.now();
  try {
    const result = await runAgenticLoop({
      adapter,
      systemPrompt: extra.promptInjected ? PI_SYSTEM : SYSTEM,
      taskPrompt: TASK,
      tools: extra.promptInjected ? [] : TOOL_DEFINITIONS,
      toolExecutor: createToolExecutor(WD),
      options: opts,
      workingDir: WD,
      timeoutMs: 90000,
      maxIterations: 5,
      contextBudget: extra.contextBudget || 8000,
      promptInjectedTools: !!extra.promptInjected,
    });
    const ms = Date.now() - start;
    const tools = result.toolLog.map(t => t.name).join(',') || 'none';
    const has13 = result.output.includes('13');
    const hasApp = result.output.includes('SpudgetBooks.App.Tests');
    const hasDomain = result.output.includes('SpudgetBooks.Domain.Tests');
    const grade = (has13 && hasApp && hasDomain) ? 'A' : (hasApp && hasDomain) ? 'B+' : hasApp ? 'B' : result.toolLog.length > 0 ? 'C' : 'F';
    const row = { name, ms, iters: result.iterations, tools: result.toolLog.length, toolNames: tools, count: has13, names: hasApp && hasDomain, grade };
    results.push(row);
    console.log(
      name.padEnd(40) + ' | ' + String(ms).padStart(6) + 'ms | ' +
      result.iterations + ' iters | ' + result.toolLog.length + ' tools | ' +
      grade.padEnd(3) + ' | ' + result.output.replace(/\n/g, ' ').slice(0, 100)
    );
  } catch (e) {
    const ms = Date.now() - start;
    results.push({ name, ms, error: e.message.slice(0, 100), grade: 'ERR' });
    console.log(name.padEnd(40) + ' | ' + String(ms).padStart(6) + 'ms | ERR | ' + e.message.slice(0, 100));
  }
}

(async () => {
  console.log('=== COMPREHENSIVE MODEL BASELINE ===');
  console.log('Task: "List tests/ directory, report folder names and count"');
  console.log('Ground truth: 13 folders');
  console.log('='.repeat(160));

  // --- GROQ ---
  const groqKey = config.getApiKey('groq');
  const groqOpts = (model) => ({ host: 'https://api.groq.com/openai', apiKey: groqKey, model, temperature: 0.3 });
  await test('groq / llama-3.3-70b-versatile', openaiAdapter, groqOpts('llama-3.3-70b-versatile'));
  await test('groq / llama-3.1-8b-instant', openaiAdapter, groqOpts('llama-3.1-8b-instant'));
  await test('groq / llama-4-scout-17b', openaiAdapter, groqOpts('meta-llama/llama-4-scout-17b-16e-instruct'));
  await test('groq / qwen3-32b', openaiAdapter, groqOpts('qwen/qwen3-32b'));
  await test('groq / kimi-k2-instruct', openaiAdapter, groqOpts('moonshotai/kimi-k2-instruct'));
  await test('groq / gpt-oss-120b', openaiAdapter, groqOpts('openai/gpt-oss-120b'));

  // --- CEREBRAS ---
  const cerebrasKey = config.getApiKey('cerebras');
  const cerebrasOpts = (model) => ({ host: 'https://api.cerebras.ai', apiKey: cerebrasKey, model, temperature: 0.3 });
  await test('cerebras / qwen-3-235b', openaiAdapter, cerebrasOpts('qwen-3-235b-a22b-instruct-2507'));
  await test('cerebras / llama3.1-8b', openaiAdapter, cerebrasOpts('llama3.1-8b'));

  // --- GOOGLE AI ---
  const googleKey = config.getApiKey('google-ai');
  const googleOpts = (model) => ({ host: 'https://generativelanguage.googleapis.com', apiKey: googleKey, model });
  await test('google-ai / gemini-2.5-flash', googleAdapter, googleOpts('gemini-2.5-flash'));
  await test('google-ai / gemini-2.5-flash-lite', googleAdapter, googleOpts('gemini-2.5-flash-lite'));
  await test('google-ai / gemini-2.5-pro', googleAdapter, googleOpts('gemini-2.5-pro'));

  // --- OLLAMA CLOUD ---
  const ollamaCloudKey = config.getApiKey('ollama-cloud');
  const ollamaCloudOpts = (model) => ({ host: 'https://api.ollama.com', apiKey: ollamaCloudKey, model });
  await test('ollama-cloud / devstral-2:123b', ollamaAdapter, ollamaCloudOpts('devstral-2:123b'));
  await test('ollama-cloud / qwen3-coder:480b', ollamaAdapter, ollamaCloudOpts('qwen3-coder:480b'));
  await test('ollama-cloud / mistral-large-3:675b', ollamaAdapter, ollamaCloudOpts('mistral-large-3:675b'));
  await test('ollama-cloud / kimi-k2:1t', ollamaAdapter, ollamaCloudOpts('kimi-k2:1t'));
  await test('ollama-cloud / deepseek-v3.2', ollamaAdapter, ollamaCloudOpts('deepseek-v3.2'));
  await test('ollama-cloud / gpt-oss:120b', ollamaAdapter, ollamaCloudOpts('gpt-oss:120b'));

  // --- OPENROUTER ---
  const openrouterKey = config.getApiKey('openrouter');
  const openrouterOpts = (model) => ({ host: 'https://openrouter.ai/api', apiKey: openrouterKey, model, temperature: 0.3 });
  await test('openrouter / nemotron-3-nano-30b:free', openaiAdapter, openrouterOpts('nvidia/nemotron-3-nano-30b-a3b:free'));
  await test('openrouter / gemma-3-27b:free', openaiAdapter, openrouterOpts('google/gemma-3-27b-it:free'));
  await test('openrouter / llama-3.3-70b:free', openaiAdapter, openrouterOpts('meta-llama/llama-3.3-70b-instruct:free'));

  // --- LOCAL OLLAMA ---
  await test('local / qwen3-coder:30b', ollamaAdapter, { host: ollamaHost, model: 'qwen3-coder:30b' });
  await test('local / qwen3-coder:30b (prompt-inj)', ollamaAdapter, { host: ollamaHost, model: 'qwen3-coder:30b' }, { promptInjected: true });

  // --- SUMMARY ---
  console.log('\n' + '='.repeat(160));
  console.log('SUMMARY — sorted by grade then speed:');
  console.log('-'.repeat(100));
  const gradeOrder = { A: 0, 'B+': 1, B: 2, C: 3, F: 4, ERR: 5 };
  results.sort((a, b) => (gradeOrder[a.grade] || 9) - (gradeOrder[b.grade] || 9) || a.ms - b.ms);
  for (const r of results) {
    if (r.error) {
      console.log(r.grade.padEnd(4) + ' | ' + r.name.padEnd(40) + ' | ' + String(r.ms).padStart(6) + 'ms | ERR: ' + r.error.slice(0, 60));
    } else {
      console.log(r.grade.padEnd(4) + ' | ' + r.name.padEnd(40) + ' | ' + String(r.ms).padStart(6) + 'ms | ' + r.iters + ' iters | ' + r.tools + ' tools | count=' + r.count + ' names=' + r.names);
    }
  }

  process.exit(0);
})();
