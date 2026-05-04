'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PLAN_PATH = path.join(
  DEFAULT_REPO_ROOT,
  'docs',
  'superpowers',
  'plans',
  '2026-04-11-fabro-1-workflow-as-code.md'
);
const DEFAULT_DATA_DIR = path.join(
  os.homedir(),
  '.codex',
  'memories',
  'torque-public-factory-data'
);
const DEFAULT_FIXTURE_PATH = path.join(
  DEFAULT_REPO_ROOT,
  'server',
  'tests',
  'fixtures',
  'factory-plan1-decision-log.json'
);
const DEFAULT_GAPS_PATH = path.join(
  DEFAULT_REPO_ROOT,
  'server',
  'tests',
  'fixtures',
  'factory-plan1-gaps.json'
);

function parseArgs(argv) {
  const options = {
    repoRoot: DEFAULT_REPO_ROOT,
    planPath: DEFAULT_PLAN_PATH,
    dataDir: process.env.TORQUE_DATA_DIR || DEFAULT_DATA_DIR,
    fixturePath: DEFAULT_FIXTURE_PATH,
    gapsPath: DEFAULT_GAPS_PATH,
    projectId: null,
    allowLiveExecute: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--project-id':
        options.projectId = argv[index + 1];
        index += 1;
        break;
      case '--plan-path':
        options.planPath = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case '--data-dir':
        options.dataDir = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case '--fixture-path':
        options.fixturePath = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case '--gaps-path':
        options.gapsPath = path.resolve(argv[index + 1]);
        index += 1;
        break;
      case '--allow-live-execute':
        options.allowLiveExecute = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function getDatabase() {
  return require(path.join(__dirname, '..', 'database'));
}

function toStructuredData(result) {
  if (!result) {
    return null;
  }
  if (result.structuredData) {
    return result.structuredData;
  }
  const text = result.content && result.content[0] && result.content[0].text;
  return text ? JSON.parse(text) : null;
}

function parseConfig(project) {
  if (project && project.config && typeof project.config === 'object') {
    return project.config;
  }
  if (project && project.config_json) {
    try {
      return JSON.parse(project.config_json);
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeWorkItem(row) {
  if (!row) {
    return null;
  }

  const normalized = { ...row };
  if (normalized.origin_json && !normalized.origin) {
    try {
      normalized.origin = JSON.parse(normalized.origin_json);
    } catch {
      normalized.origin = null;
    }
  }
  if (normalized.constraints_json && !normalized.constraints) {
    try {
      normalized.constraints = JSON.parse(normalized.constraints_json);
    } catch {
      normalized.constraints = null;
    }
  }
  return normalized;
}

function getObservedExecuteWorkItem(db, projectId, fallbackId) {
  const row = db.prepare(`
    SELECT *
    FROM factory_work_items
    WHERE project_id = ? AND status = 'executing'
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(projectId);

  if (row) {
    return normalizeWorkItem(row);
  }

  if (fallbackId) {
    return normalizeWorkItem(
      db.prepare('SELECT * FROM factory_work_items WHERE id = ?').get(fallbackId)
    );
  }

  return null;
}

function createGapCollector(gaps) {
  return function addGap(code, message, details = {}) {
    gaps.push({
      code,
      message,
      details,
    });
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.env.TORQUE_DATA_DIR = options.dataDir;

  const factoryHealth = require('../db/factory/health');
  const factoryIntake = require('../db/factory/intake');
  const factoryDecisions = require('../db/factory/decisions');
  const loopStates = require('../factory/loop-states');
  const { logDecision } = require('../factory/decision-log');
  const {
    handleScanPlansDirectory,
    handleStartFactoryLoop,
    handleAdvanceFactoryLoop,
    handleApproveFactoryGate,
    handleFactoryLoopStatus,
    handleDecisionLog,
  } = require('../handlers/factory-handlers');

  const runId = `factory-plan1-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const gaps = [];
  const addGap = createGapCollector(gaps);
  let fixturePayload = null;
  const database = getDatabase();

  try {
    database.init();
    const db = database.getDbInstance();
    factoryDecisions.setDb(db);

    if (!fs.existsSync(options.planPath)) {
      throw new Error(`Plan file not found: ${options.planPath}`);
    }

    if (!fs.existsSync(path.join(options.repoRoot, 'server', 'mcp-tools'))) {
      addGap(
        'mcp_tools_directory_missing',
        'Expected Phase 9 MCP tool directory server/mcp-tools was not present.',
        {
          expected_path: path.join(options.repoRoot, 'server', 'mcp-tools'),
          actual_registry: [
            'server/tool-defs/factory-defs.js',
            'server/handlers/factory-handlers.js',
          ],
        }
      );
    }

    addGap(
      'factory_decision_log_table_missing',
      'Expected factory_decision_log table was not present; this repo uses factory_decisions.',
      {
        expected_table: 'factory_decision_log',
        actual_table: 'factory_decisions',
        schema_file: path.join(options.repoRoot, 'server', 'db', 'migrations.js'),
      }
    );

    addGap(
      'approve_factory_transition_missing',
      'Expected approve_factory_transition tool was not present; using approve_factory_gate/approveGate.',
      {
        expected_tool: 'approve_factory_transition',
        actual_tool: 'approve_factory_gate',
        implementation_file: path.join(options.repoRoot, 'server', 'factory', 'loop-controller.js'),
      }
    );

    addGap(
      'tick_factory_loop_missing',
      'Expected tick_factory_loop tool was not present; using advance_factory_loop/advanceLoop.',
      {
        expected_tool: 'tick_factory_loop',
        actual_tool: 'advance_factory_loop',
        implementation_file: path.join(options.repoRoot, 'server', 'factory', 'loop-controller.js'),
      }
    );

    let project = options.projectId
      ? factoryHealth.getProject(options.projectId)
      : factoryHealth.getProjectByPath(options.repoRoot);

    if (!project) {
      throw new Error(
        `PREREQUISITE FAILED: no factory_projects row found for ${options.projectId || options.repoRoot}`
      );
    }

    const projectConfig = parseConfig(project);
    const plansDir = projectConfig.plans_dir;
    if (!plansDir) {
      throw new Error(`Project ${project.id} has no config.plans_dir`);
    }

    console.log(`[drive-plan1] project_id=${project.id}`);
    console.log(`[drive-plan1] data_dir=${options.dataDir}`);
    console.log(`[drive-plan1] plans_dir=${plansDir}`);
    console.log(`[drive-plan1] run_id=${runId}`);

    const scanResult = toStructuredData(await handleScanPlansDirectory({
      project_id: project.id,
      plans_dir: plansDir,
    }));
    console.log(
      `[drive-plan1] scan_plans_directory scanned=${scanResult.scanned} created=${scanResult.created_count} skipped=${scanResult.skipped_count}`
    );

    const workItemRow = db.prepare(`
      SELECT w.*
      FROM factory_plan_file_intake intake
      JOIN factory_work_items w ON w.id = intake.work_item_id
      WHERE intake.project_id = ? AND intake.plan_path = ?
      ORDER BY intake.created_at DESC
      LIMIT 1
    `).get(project.id, options.planPath);

    const initialWorkItem = normalizeWorkItem(workItemRow);
    if (!initialWorkItem) {
      throw new Error(`Plan intake row not found for ${options.planPath}`);
    }

    const initialPriority = initialWorkItem.priority;

    logDecision({
      project_id: project.id,
      stage: 'sense',
      actor: 'human',
      action: 'scan_plans_directory',
      reasoning: 'Task 2 fixture-capture run scanned the configured plans directory.',
      inputs: {
        plans_dir: plansDir,
        plan_path: options.planPath,
      },
      outcome: {
        scanned: scanResult.scanned,
        created_count: scanResult.created_count,
        skipped_count: scanResult.skipped_count,
        work_item_id: initialWorkItem.id,
      },
      confidence: 1,
      batch_id: runId,
    });

    const started = toStructuredData(await handleStartFactoryLoop({ project: project.id }));
    console.log(`[drive-plan1] start_factory_loop state=${started.state}`);

    const senseAdvance = toStructuredData(await handleAdvanceFactoryLoop({ project: project.id }));
    console.log(
      `[drive-plan1] advance_factory_loop (SENSE) previous=${senseAdvance.previous_state} new=${senseAdvance.new_state} paused_at=${senseAdvance.paused_at_stage || 'none'}`
    );

    if (
      senseAdvance.new_state !== loopStates.LOOP_STATES.PAUSED
      || senseAdvance.paused_at_stage !== loopStates.LOOP_STATES.PRIORITIZE
    ) {
      addGap(
        'sense_to_prioritize_gate_unexpected',
        'SENSE did not pause at PRIORITIZE as expected for supervised trust.',
        {
          advance_result: senseAdvance,
        }
      );
    }

    toStructuredData(await handleApproveFactoryGate({
      project: project.id,
      stage: loopStates.LOOP_STATES.PRIORITIZE,
    }));

    const prioritizeStatus = toStructuredData(await handleFactoryLoopStatus({ project: project.id }));
    console.log(`[drive-plan1] approve_factory_gate stage=PRIORITIZE loop_state=${prioritizeStatus.loop_state}`);

    const prioritizedWorkItem = factoryIntake.getWorkItem(initialWorkItem.id);
    logDecision({
      project_id: project.id,
      stage: 'sense',
      actor: 'human',
      action: 'transition_approved',
      reasoning: 'Supervised trust required human approval before entering PRIORITIZE.',
      inputs: {
        previous_state: loopStates.LOOP_STATES.SENSE,
        paused_at_stage: senseAdvance.paused_at_stage,
      },
      outcome: {
        from_state: loopStates.LOOP_STATES.SENSE,
        to_state: prioritizeStatus.loop_state,
        approval: 'approved',
        work_item_id: prioritizedWorkItem && prioritizedWorkItem.id,
        priority: prioritizedWorkItem && prioritizedWorkItem.priority,
      },
      confidence: 1,
      batch_id: runId,
    });

    if (!prioritizedWorkItem || prioritizedWorkItem.priority === initialPriority) {
      addGap(
        'prioritize_stage_did_not_score_work_item',
        'WI_1 priority did not change during the PRIORITIZE gate.',
        {
          work_item_id: initialWorkItem.id,
          before_priority: initialPriority,
          after_priority: prioritizedWorkItem ? prioritizedWorkItem.priority : null,
        }
      );
    }

    const planAdvance = toStructuredData(await handleAdvanceFactoryLoop({ project: project.id }));
    console.log(
      `[drive-plan1] advance_factory_loop (PRIORITIZE) previous=${planAdvance.previous_state} new=${planAdvance.new_state} reason=${planAdvance.reason || 'n/a'}`
    );

    if (planAdvance.reason !== 'pre-written plan detected') {
      addGap(
        'plan_stage_skip_reason_missing',
        'PLAN stage did not report the expected pre-written plan skip reason.',
        {
          advance_result: planAdvance,
        }
      );
    }

    const observedExecuteWorkItem = getObservedExecuteWorkItem(
      db,
      project.id,
      planAdvance.stage_result && planAdvance.stage_result.work_item_id
    );
    if (!observedExecuteWorkItem) {
      addGap(
        'execute_work_item_unresolved',
        'Could not resolve which work item the loop moved into EXECUTE.',
        {
          stage_result: planAdvance.stage_result || null,
        }
      );
    } else if (observedExecuteWorkItem.id !== initialWorkItem.id) {
      addGap(
        'wi1_not_selected_by_loop',
        'The loop advanced a different plan-file work item into EXECUTE instead of WI_1.',
        {
          requested_work_item_id: initialWorkItem.id,
          requested_plan_path: options.planPath,
          observed_execute_work_item_id: observedExecuteWorkItem.id,
          observed_execute_plan_path: observedExecuteWorkItem.origin && observedExecuteWorkItem.origin.plan_path,
        }
      );
    }

    logDecision({
      project_id: project.id,
      stage: 'plan',
      actor: 'human',
      action: 'plan_stage_skipped',
      reasoning: planAdvance.reason || 'pre-written plan detection was expected in Phase 10.',
      inputs: {
        work_item_id: initialWorkItem.id,
        plan_path: options.planPath,
      },
      outcome: {
        from_state: planAdvance.previous_state,
        to_state: planAdvance.new_state,
        reason: planAdvance.reason || null,
        work_item_id: observedExecuteWorkItem && observedExecuteWorkItem.id,
      },
      confidence: 1,
      batch_id: runId,
    });

    logDecision({
      project_id: project.id,
      stage: 'execute',
      actor: 'human',
      action: 'enter_execute',
      reasoning: 'Loop advanced directly into EXECUTE because the selected work item has origin.plan_path.',
      inputs: {
        loop_state: planAdvance.new_state,
        work_item_id: initialWorkItem.id,
      },
      outcome: {
        from_state: planAdvance.previous_state,
        to_state: planAdvance.new_state,
        requested_work_item_id: initialWorkItem.id,
        work_item_id: observedExecuteWorkItem && observedExecuteWorkItem.id,
        work_item_status: observedExecuteWorkItem && observedExecuteWorkItem.status,
      },
      confidence: 1,
      batch_id: runId,
    });

    addGap(
      'factory_decisions_stage_enum_missing_learn',
      'factory_decisions only allows stages sense/prioritize/plan/execute/verify/ship; there is no learn stage for exact loop replay capture.',
      {
        valid_stages: ['sense', 'prioritize', 'plan', 'execute', 'verify', 'ship'],
        db_module: path.join(options.repoRoot, 'server', 'db', 'factory-decisions.js'),
      }
    );

    let executionMode = 'stopped_at_execute';
    let stoppedReason = 'Live EXECUTE run was not attempted: no dry-run support and Plan 1 would make broad repo changes plus commits.';

    if (options.allowLiveExecute) {
      addGap(
        'allow_live_execute_not_implemented',
        'This driver currently records a safe stop at EXECUTE only. Live plan execution was intentionally not automated in this Task 2 pass.',
        {
          requested: true,
        }
      );
      stoppedReason = 'Live execute flag was provided, but the safe-stop Task 2 driver does not automate the full EXECUTE/VERIFY/LEARN path.';
    } else {
      addGap(
        'execute_stage_not_attempted_live',
        stoppedReason,
        {
          loop_state: planAdvance.new_state,
          plan_path: options.planPath,
        }
      );
    }

    const finalLoopStatus = toStructuredData(await handleFactoryLoopStatus({ project: project.id }));
    const finalWorkItem = factoryIntake.getWorkItem(initialWorkItem.id);
    const finalObservedExecuteWorkItem = observedExecuteWorkItem
      ? factoryIntake.getWorkItem(observedExecuteWorkItem.id)
      : null;
    const decisionRows = toStructuredData(await handleDecisionLog({
      project: project.id,
      batch_id: runId,
    }));

    fixturePayload = {
      captured_at: new Date().toISOString(),
      run_id: runId,
      execution_mode: executionMode,
      stopped_reason: stoppedReason,
      project: {
        id: project.id,
        name: project.name,
        path: project.path,
        trust_level: project.trust_level,
      },
      plan_path: options.planPath,
      work_item: finalWorkItem ? {
        id: finalWorkItem.id,
        title: finalWorkItem.title,
        status: finalWorkItem.status,
        priority: finalWorkItem.priority,
        origin: finalWorkItem.origin || null,
      } : null,
      observed_execute_work_item: finalObservedExecuteWorkItem ? {
        id: finalObservedExecuteWorkItem.id,
        title: finalObservedExecuteWorkItem.title,
        status: finalObservedExecuteWorkItem.status,
        priority: finalObservedExecuteWorkItem.priority,
        origin: finalObservedExecuteWorkItem.origin || null,
      } : null,
      final_state: finalLoopStatus.loop_state,
      loop_status: finalLoopStatus,
      decision_log: decisionRows && Array.isArray(decisionRows.decisions)
        ? decisionRows.decisions
        : [],
      gaps: gaps.map((gap) => gap.code),
    };

    writeJson(options.fixturePath, fixturePayload);
    writeJson(options.gapsPath, {
      captured_at: fixturePayload.captured_at,
      run_id: runId,
      project_id: project.id,
      plan_path: options.planPath,
      gaps,
    });

    console.log(`[drive-plan1] fixture=${options.fixturePath}`);
    console.log(`[drive-plan1] gaps=${options.gapsPath}`);
    console.log(`[drive-plan1] final loop_state=${fixturePayload.final_state}`);
    console.log(`[drive-plan1] WI_1 status=${fixturePayload.work_item ? fixturePayload.work_item.status : 'missing'}`);
  } finally {
    try {
      database.close();
    } catch {
      // Best-effort shutdown for one-shot script.
    }
  }

  return fixturePayload;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  writeJson,
  toStructuredData,
  normalizeWorkItem,
  createGapCollector,
  main,
};
