#!/usr/bin/env node
/**
 * Wake-latency test — advance the newest instance directly and measure
 * how fast await_factory_loop returns after the advance fires.
 */
'use strict';

const http = require('http');
const PROJECT_ID = 'a3df749a-7869-486f-9896-64d38d25d39b';
const INSTANCE_ID = 'b6caa191-5d7b-417e-95f1-74a0e3778088';

function req(method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  const opts = {
    host: '127.0.0.1', port: 3457, method, path,
    headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
  };
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function now() { return Number(process.hrtime.bigint() / 1000000n); }

async function getInstanceState(instanceId) {
  const r = await req('GET', `/api/v2/factory/loops/${instanceId}`);
  return r.body?.data;
}

async function advanceInstance(instanceId) {
  return req('POST', `/api/v2/factory/loops/${instanceId}/advance`, {});
}

async function awaitProject(targetStates, opts = {}) {
  return req('POST', `/api/v2/factory/projects/${PROJECT_ID}/loop/await`, {
    target_states: targetStates,
    await_termination: false,
    heartbeat_minutes: 0,
    timeout_minutes: 1,
    ...opts,
  });
}

(async () => {
  console.log('=== Wake latency measurement ===\n');

  const before = await getInstanceState(INSTANCE_ID);
  console.log(`Instance ${INSTANCE_ID.slice(0,8)}: state=${before.loop_state} paused=${before.paused_at_stage}\n`);

  const wakes = [];

  // Pick 3 stage-order-ahead targets relative to the newest instance's current state
  // With stage-order awareness, any later state in the linear order satisfies.
  // We target EXECUTE (far ahead of SENSE=1), so one advance to PRIORITIZE won't satisfy.
  // Wait — we want a target the NEXT advance WILL satisfy.

  for (let i = 1; i <= 5; i++) {
    const s = await getInstanceState(INSTANCE_ID);
    const cur = s.loop_state;
    // For each run, target "any state ≥ next" — which await's stage-order check will resolve on the first advance.
    const nextMap = {
      SENSE: 'PRIORITIZE',
      PRIORITIZE: 'PLAN',
      PLAN: 'EXECUTE',
      EXECUTE: 'VERIFY',
      VERIFY: 'LEARN',
      LEARN: 'IDLE',
    };
    const target = nextMap[cur];
    if (!target) {
      console.log(`Run ${i}: stopping at ${cur} — no next target`);
      break;
    }

    console.log(`Run ${i}: ${cur} → target=${target}`);

    // Register await first (blocks)
    const aStart = now();
    const awaitP = awaitProject([target]);

    // Guarantee await is inside its wait loop before we advance
    await new Promise(r => setTimeout(r, 150));

    const advStart = now();
    const advResp = await advanceInstance(INSTANCE_ID);
    const advEnd = now();

    const awaitResp = await awaitP;
    const awaitEnd = now();

    const wake = awaitEnd - advEnd;
    const controllerElapsed = awaitResp.body?.data?.elapsed_ms;

    console.log(`  advance: ${advEnd - advStart}ms (HTTP ${advResp.status}, job=${advResp.body?.data?.job_id?.slice(0,8)})`);
    console.log(`  await:   wake=${wake}ms, controller_elapsed=${controllerElapsed}ms, status=${awaitResp.body?.data?.status}`);
    console.log(`  after: state=${awaitResp.body?.data?.instance?.loop_state} paused=${awaitResp.body?.data?.instance?.paused_at_stage}\n`);

    if (awaitResp.body?.data?.status === 'timeout' || awaitResp.body?.data?.status === 'paused') {
      console.log(`Stopping: status=${awaitResp.body?.data?.status}`);
      break;
    }

    wakes.push({ wake, controllerElapsed, cur, target });
    await new Promise(r => setTimeout(r, 400));
  }

  console.log('\n=== Summary ===');
  if (wakes.length) {
    const w = wakes.map((r) => r.wake);
    const avg = w.reduce((a, b) => a + b, 0) / w.length;
    console.log(`Wake latency: avg=${avg.toFixed(0)}ms min=${Math.min(...w)}ms max=${Math.max(...w)}ms (n=${w.length})`);
    console.log('Detail:', wakes.map(r => `${r.cur}→${r.target}: ${r.wake}ms`).join('  '));
  } else {
    console.log('No wakes measured');
  }
})().catch((e) => { console.error(e); process.exit(1); });
