#!/usr/bin/env node
/**
 * Factory loop timing harness — measures wake latency of await_factory_loop.
 *
 * For each stage transition:
 *   1. Start the await (it blocks until state changes or timeout)
 *   2. In parallel, fire an async /loop/advance
 *   3. Record how long from advance-returned to await-returned
 *
 * With pure polling (POLL_MS=2000), average wake latency is ~1000ms.
 * With event-bus wakeup, wake latency should be <100ms.
 */

'use strict';

const http = require('http');

const BASE = 'http://127.0.0.1:3457';
const PROJECT_ID = 'a3df749a-7869-486f-9896-64d38d25d39b';

function request(method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  const opts = {
    host: '127.0.0.1',
    port: 3457,
    method,
    path,
    headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
  };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, body: text });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function now() {
  const hr = process.hrtime.bigint();
  return Number(hr / 1000000n); // ms
}

async function getState() {
  const r = await request('GET', `/api/v2/factory/projects/${PROJECT_ID}/loop`);
  return r.body?.data?.loop_state;
}

async function startLoop() {
  const r = await request('POST', `/api/v2/factory/projects/${PROJECT_ID}/loop/start`, {});
  return r.body?.data;
}

async function measureAdvanceAndAwait(targetStates, label) {
  // Snapshot state before
  const beforeState = await getState();

  // Start the await call FIRST so it's already blocking when advance fires
  const awaitStart = now();
  const awaitPromise = request('POST', `/api/v2/factory/projects/${PROJECT_ID}/loop/await`, {
    target_states: targetStates,
    heartbeat_minutes: 0,
    timeout_minutes: 2,
  });

  // Brief delay to ensure await is registered before we trigger the advance
  await new Promise((r) => setTimeout(r, 50));

  // Fire async advance
  const advStart = now();
  const advResp = await request('POST', `/api/v2/factory/projects/${PROJECT_ID}/loop/advance`, {});
  const advEnd = now();

  // Wait for await to return
  const awaitResp = await awaitPromise;
  const awaitEnd = now();

  const wakeLatencyMs = awaitEnd - advEnd;
  const stageWallMs = awaitEnd - advStart;

  console.log(`[${label}] ${beforeState} → ${awaitResp.body?.data?.instance?.loop_state || awaitResp.body?.data?.instance?.paused_at_stage || '?'}`);
  console.log(`  /loop/advance returned in ${advEnd - advStart}ms (job_id=${advResp.body?.data?.job_id})`);
  console.log(`  await wake latency: ${wakeLatencyMs}ms (total stage wall: ${stageWallMs}ms)`);
  console.log(`  await status: ${awaitResp.body?.data?.status}, elapsed_ms=${awaitResp.body?.data?.elapsed_ms}`);
  console.log('');
  return { wakeLatencyMs, stageWallMs, status: awaitResp.body?.data?.status };
}

(async () => {
  console.log('=== Factory loop timing test ===\n');

  const state = await getState();
  console.log(`Initial state: ${state}\n`);

  if (state !== 'IDLE') {
    console.log(`Warning: loop not in IDLE state, results may be skewed`);
  }

  // Start a fresh loop
  const started = await startLoop();
  console.log(`Started loop: instance=${started?.instance_id}, state=${started?.state}\n`);

  const results = [];
  // SENSE → PRIORITIZE → PLAN → EXECUTE → VERIFY → LEARN(pause) — autonomous trust
  const transitions = [
    { targets: ['PRIORITIZE'], label: 'SENSE→PRIORITIZE' },
    { targets: ['PLAN'], label: 'PRIORITIZE→PLAN' },
    { targets: ['EXECUTE'], label: 'PLAN→EXECUTE' },
    { targets: ['VERIFY'], label: 'EXECUTE→VERIFY' },
    { targets: ['LEARN', 'IDLE', 'PAUSED'], label: 'VERIFY→LEARN/IDLE' },
  ];

  for (const t of transitions) {
    try {
      const r = await measureAdvanceAndAwait(t.targets, t.label);
      results.push({ label: t.label, ...r });
      if (r.status === 'paused' || r.status === 'timeout') {
        console.log(`Stopping chain: await status = ${r.status}`);
        break;
      }
    } catch (err) {
      console.log(`[${t.label}] ERROR: ${err.message}`);
      break;
    }
  }

  console.log('=== Summary ===');
  const waits = results.map((r) => r.wakeLatencyMs).filter((x) => Number.isFinite(x));
  if (waits.length) {
    const avg = waits.reduce((a, b) => a + b, 0) / waits.length;
    const max = Math.max(...waits);
    const min = Math.min(...waits);
    console.log(`Wake latency: avg=${avg.toFixed(0)}ms min=${min}ms max=${max}ms`);
  }
  results.forEach((r) => console.log(`  ${r.label}: wake=${r.wakeLatencyMs}ms wall=${r.stageWallMs}ms status=${r.status}`));
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
