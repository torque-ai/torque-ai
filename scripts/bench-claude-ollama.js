#!/usr/bin/env node
// Benchmark: claude-ollama (via ollama launch claude) vs ollama direct HTTP API.
// Run on a host that has both ollama + claude binaries. Emits one JSON line per
// run + a final markdown summary.

'use strict';

const { spawn } = require('child_process');

const MODEL = process.env.MODEL || 'qwen3-coder:30b';
const OLLAMA_URL = process.env.OLLAMA_HOST_URL || 'http://localhost:11434';

const PROMPTS = [
  { id: 'q-and-a', prompt: 'Respond with exactly the single word: OK' },
  { id: 'code-gen', prompt: 'Write a Python function named square(n) that returns n times n. Only the code, no explanation, no markdown fencing.' },
];

function now() { return process.hrtime.bigint(); }
function msBetween(a, b) { return Number((b - a) / 1_000_000n); }

async function runOllamaDirect(label, prompt) {
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
    return { provider: 'ollama-direct', label, error: e.message, wall_ms: msBetween(started, now()) };
  }
  const ended = now();
  return {
    provider: 'ollama-direct',
    label,
    wall_ms: msBetween(started, ended),
    input_tokens: result.prompt_eval_count || 0,
    output_tokens: result.eval_count || 0,
    content: (result.message && result.message.content) || '',
  };
}

function runClaudeOllama(label, prompt) {
  return new Promise((resolve) => {
    const args = ['launch', 'claude', '--model', MODEL, '--',
      '-p', prompt, '--output-format', 'text'];
    const started = now();
    const bin = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdin.end('ok\n');
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.once('error', (e) => {
      resolve({ provider: 'claude-ollama', label, error: e.message, wall_ms: msBetween(started, now()) });
    });
    child.once('close', (code) => {
      const ended = now();
      if (code !== 0) {
        resolve({
          provider: 'claude-ollama', label, error: `exit ${code}: ${stderr.trim() || stdout.trim()}`,
          wall_ms: msBetween(started, ended),
        });
        return;
      }
      resolve({
        provider: 'claude-ollama',
        label,
        wall_ms: msBetween(started, ended),
        content: stdout.trim(),
      });
    });
  });
}

async function main() {
  const results = [];
  console.log(`# Benchmark start — model=${MODEL}, host=${OLLAMA_URL}`);
  console.log('');
  for (const p of PROMPTS) {
    const a = await runOllamaDirect(p.id, p.prompt);
    results.push(a);
    console.log(JSON.stringify(a));
    const b = await runClaudeOllama(p.id, p.prompt);
    results.push(b);
    console.log(JSON.stringify(b));
  }

  console.log('');
  console.log('# Summary');
  console.log('| label | provider | wall_ms | input_tok | output_tok | content_preview |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) {
    const preview = (r.content || r.error || '').replace(/\s+/g, ' ').slice(0, 60);
    console.log(`| ${r.label} | ${r.provider} | ${r.wall_ms} | ${r.input_tokens ?? '-'} | ${r.output_tokens ?? '-'} | ${preview} |`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
