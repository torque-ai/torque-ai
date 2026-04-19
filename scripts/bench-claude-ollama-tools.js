#!/usr/bin/env node
// Tool-use benchmark: multi-step Read+Edit task on a controlled Python fixture.
// Compares claude-ollama (via ollama launch claude harness, real agentic tool use)
// against ollama direct (one-shot "rewrite this file" prompt).
//
// Runs on a host with ollama + claude binaries. Expects two fresh fixture dirs
// already set up. Point at them via env vars:
//   BENCH_CO_DIR       (for claude-ollama)
//   BENCH_OLLAMA_DIR   (for ollama direct)
//
// Each dir must contain fixture.py with identical starting content.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MODEL = process.env.MODEL || 'qwen3-coder:30b';
const OLLAMA_URL = process.env.OLLAMA_HOST_URL || 'http://localhost:11434';

const CO_DIR = process.env.BENCH_CO_DIR;
const OLLAMA_DIR = process.env.BENCH_OLLAMA_DIR;
if (!CO_DIR || !OLLAMA_DIR) {
  console.error('Set BENCH_CO_DIR and BENCH_OLLAMA_DIR env vars to the fixture directories.');
  process.exit(2);
}
const FIXTURE = 'fixture.py';

const TASK = 'In the file fixture.py in the current working directory, rename every occurrence of the local variable `total` to `accumulator`. Do not change function names. The `sum(numbers)` call should remain unchanged — `sum` is a built-in, not our variable. After making the edits, stop.';

function now() { return process.hrtime.bigint(); }
function msBetween(a, b) { return Number((b - a) / 1_000_000n); }

function verify(original, modified) {
  const origTotal = (original.match(/\btotal\b/g) || []).length;
  const modTotal = (modified.match(/\btotal\b/g) || []).length;
  const modAccum = (modified.match(/\baccumulator\b/g) || []).length;
  const funcsUnchanged = /calculate_sum/.test(modified) && /calculate_product/.test(modified) && /calculate_average/.test(modified);
  const sumCallPreserved = /sum\(numbers\)/.test(modified);
  return {
    orig_total_count: origTotal,
    mod_total_count: modTotal,
    mod_accumulator_count: modAccum,
    functions_unchanged: funcsUnchanged,
    sum_call_preserved: sumCallPreserved,
    rename_complete: modTotal === 0 && modAccum === origTotal,
    semantic_pass: funcsUnchanged && sumCallPreserved && modTotal === 0 && modAccum === origTotal,
  };
}

async function runClaudeOllama() {
  const startContent = fs.readFileSync(path.join(CO_DIR, FIXTURE), 'utf8');
  const started = now();
  const result = await new Promise((resolve) => {
    const args = ['launch', 'claude', '--model', MODEL, '--',
      '-p', TASK,
      '--output-format', 'text',
      '--permission-mode', 'bypassPermissions',
      '--add-dir', CO_DIR];
    const child = spawn(process.platform === 'win32' ? 'ollama.exe' : 'ollama', args, {
      cwd: CO_DIR,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdin.end('');
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.once('error', (e) => resolve({ error: e.message, stdout, stderr }));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  const ended = now();
  const endContent = fs.readFileSync(path.join(CO_DIR, FIXTURE), 'utf8');
  return {
    provider: 'claude-ollama',
    wall_ms: msBetween(started, ended),
    exit_code: result.code,
    error: result.error,
    harness_stdout_preview: (result.stdout || '').slice(0, 300),
    harness_stderr_preview: (result.stderr || '').slice(0, 300),
    verify: verify(startContent, endContent),
    file_unchanged: startContent === endContent,
  };
}

async function runOllamaDirect() {
  const fixturePath = path.join(OLLAMA_DIR, FIXTURE);
  const startContent = fs.readFileSync(fixturePath, 'utf8');
  const prompt = `${TASK}

Here is fixture.py:
\`\`\`python
${startContent}
\`\`\`

Return ONLY the complete modified file content, wrapped in a single \`\`\`python code block, with no explanation before or after.`;

  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  });
  const started = now();
  let result;
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    result = await resp.json();
  } catch (e) {
    return { provider: 'ollama-direct', error: e.message, wall_ms: msBetween(started, now()) };
  }
  const ended = now();
  const content = (result.message && result.message.content) || '';
  const match = content.match(/```(?:python)?\s*\n([\s\S]*?)```/);
  const extracted = match ? match[1] : content;
  fs.writeFileSync(fixturePath, extracted, 'utf8');
  const endContent = fs.readFileSync(fixturePath, 'utf8');
  return {
    provider: 'ollama-direct',
    wall_ms: msBetween(started, ended),
    input_tokens: result.prompt_eval_count || 0,
    output_tokens: result.eval_count || 0,
    verify: verify(startContent, endContent),
    file_unchanged: startContent === endContent,
    raw_response_preview: content.slice(0, 300),
  };
}

async function main() {
  console.log(`# Tool-use benchmark — model=${MODEL}`);
  console.log(`# Fixture: rename local variable 'total' -> 'accumulator' in 3 functions`);
  console.log('');

  const coResult = await runClaudeOllama();
  console.log(JSON.stringify(coResult, null, 2));
  console.log('');
  const ollamaResult = await runOllamaDirect();
  console.log(JSON.stringify(ollamaResult, null, 2));
  console.log('');

  console.log('# Summary');
  console.log('| provider | wall_ms | semantic_pass | total_remaining | accumulator_count | file_unchanged |');
  console.log('|---|---:|:---:|---:|---:|:---:|');
  for (const r of [coResult, ollamaResult]) {
    const v = r.verify || {};
    console.log(`| ${r.provider} | ${r.wall_ms} | ${v.semantic_pass ? 'YES' : 'no'} | ${v.mod_total_count ?? '-'} | ${v.mod_accumulator_count ?? '-'} | ${r.file_unchanged ? 'YES (NO-OP)' : 'no'} |`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
