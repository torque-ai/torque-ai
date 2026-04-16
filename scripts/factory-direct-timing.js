#!/usr/bin/env node
/**
 * Direct-controller test — bypasses REST to verify the controller itself.
 * Uses the SAME database as the running server (so we can see real-world behavior)
 * via a side-channel require() of the controller module.
 *
 * This tells us whether bugs are in the controller or in the REST layer.
 */
'use strict';

const path = require('path');

// Need to point DATA_DIR at the server's data dir BEFORE requiring
process.env.TORQUE_DATA_DIR = path.resolve(__dirname, '../server');

const loopController = require('../server/factory/loop-controller');
const eventBus = require('../server/event-bus');

function now() {
  return Number(process.hrtime.bigint() / 1000000n);
}

async function main() {
  const PROJECT_ID = 'a3df749a-7869-486f-9896-64d38d25d39b';

  console.log('=== Direct controller test ===\n');

  // Subscribe to factory loop events to observe firing
  let eventCount = 0;
  eventBus.onFactoryLoopChanged((payload) => {
    eventCount++;
    console.log(`  [event-bus] factory-loop-changed #${eventCount}: ${payload.type} project=${payload.project_id?.slice(0,8)} state=${payload.loop_state} paused=${payload.paused_at_stage}`);
  });

  // Test 1: call awaitFactoryLoop with heartbeat_minutes=0, timeout_minutes=0.1 (6 seconds)
  console.log('Test A: heartbeat_minutes=0, timeout_minutes=0.1, target=nonexistent state');
  const t1 = now();
  try {
    const result = await loopController.awaitFactoryLoop(PROJECT_ID, {
      target_states: ['NEVER_REACHED_STATE'],
      heartbeat_minutes: 0,
      timeout_minutes: 0.1, // 6 seconds — should timeout
    });
    const elapsed = now() - t1;
    console.log(`  returned in ${elapsed}ms, status=${result.status}, elapsed_ms=${result.elapsed_ms}, timed_out=${result.timed_out}\n`);
  } catch (err) {
    const elapsed = now() - t1;
    console.log(`  ERROR in ${elapsed}ms: ${err.message}\n`);
  }

  // Test 2: heartbeat_minutes=0.02 (1.2 sec), timeout_minutes=0.1 (6s)
  console.log('Test B: heartbeat_minutes=0.02 (1.2s), timeout_minutes=0.1 (6s)');
  const t2 = now();
  try {
    const result = await loopController.awaitFactoryLoop(PROJECT_ID, {
      target_states: ['NEVER_REACHED_STATE'],
      heartbeat_minutes: 0.02,
      timeout_minutes: 0.1,
    });
    const elapsed = now() - t2;
    console.log(`  returned in ${elapsed}ms, status=${result.status}, elapsed_ms=${result.elapsed_ms}\n`);
  } catch (err) {
    const elapsed = now() - t2;
    console.log(`  ERROR in ${elapsed}ms: ${err.message}\n`);
  }

  // Test 3: emit a state change event from this process and see if our listener fires
  console.log('Test C: emit a synthetic event — does the listener fire?');
  eventBus.emitFactoryLoopChanged({
    type: 'test_synthetic',
    project_id: PROJECT_ID,
    instance_id: 'test',
    loop_state: 'TEST',
    paused_at_stage: null,
  });
  await new Promise((r) => setTimeout(r, 100));
  console.log(`  event count after synthetic emit: ${eventCount}\n`);

  console.log('=== Done ===');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
