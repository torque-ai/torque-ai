'use strict';

const { ErrorCodes, makeError } = require('./error-codes');
const { requireTask } = require('./shared');
const StrategicBrain = require('../orchestrator/strategic-brain');
const { BenchmarkHarness } = require('../orchestrator/benchmark');
const db = require('../database');

let configLoader = null;
try {
  configLoader = require('../orchestrator/config-loader');
} catch (_e) { /* config-loader not yet available — optional dependency */ }

// Module-level usage accumulator (decoupled from instance lifecycle)
const usageByProject = new Map();

function getOrCreateUsage(workingDir) {
  const key = workingDir || '__global__';
  if (!usageByProject.has(key)) {
    usageByProject.set(key, { total_calls: 0, total_tokens: 0, fallback_calls: 0 });
  }
  return usageByProject.get(key);
}

function getBrain(workingDirectory, providerOverride, modelOverride, configOverride, sessionId) {
  // Load config from three-layer merge if config-loader is available
  let resolvedConfig = {};
  if (configLoader && typeof configLoader.resolveConfig === 'function') {
    try {
      resolvedConfig = configLoader.resolveConfig(workingDirectory);
    } catch (_e) { /* fall back to empty config if project has no config file */ }
  }

  // Apply config_override (ephemeral, per-call)
  if (configOverride && typeof configOverride === 'object') {
    if (configLoader && typeof configLoader.deepMerge === 'function') {
      resolvedConfig = configLoader.deepMerge(resolvedConfig, configOverride);
    } else {
      Object.assign(resolvedConfig, configOverride);
    }
  }

  // Explicit provider/model args override config
  if (providerOverride) resolvedConfig.provider = providerOverride;
  if (modelOverride) resolvedConfig.model = modelOverride;

  // Pass MCP session ID for sampling support
  if (sessionId) resolvedConfig.sessionId = sessionId;

  return new StrategicBrain(resolvedConfig);
}

function loadBenchmarkSuite() {
  const candidates = [
    '../orchestrator/benchmark-suite',
    '../benchmark-suite',
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      if (err?.code !== 'MODULE_NOT_FOUND' || !String(err.message || '').includes('benchmark-suite')) {
        throw err;
      }
    }
  }

  return null;
}

async function handleStrategicDecompose(args) {
  try {
    const {
      feature_name,
      feature_description,
      working_directory,
      project_structure,
      provider,
      model,
    } = args || {};

    if (!feature_name) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'feature_name is required');
    }
    if (!working_directory) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'working_directory is required');
    }

    const configOverride = args.config_override || null;
    const brain = getBrain(working_directory, provider, model, configOverride, args.__sessionId);
    const result = await brain.decompose({
      feature_name,
      feature_description,
      working_directory,
      project_structure,
    });

    const taskList = (result.tasks || [])
      .map((task, index) => {
        const dependencyText = task.depends_on?.length
          ? ` (depends on: ${task.depends_on.join(', ')})`
          : '';
        return `${index + 1}. **[${task.step}]** ${task.description}${dependencyText}`;
      })
      .join('\n');

    return {
      content: [{
        type: 'text',
        text: `## Strategic Decomposition: ${feature_name}

**Source:** ${result.source} | **Confidence:** ${result.confidence || 'N/A'}${result.fallback_reason ? ` | **Fallback reason:** ${result.fallback_reason}` : ''}

### Tasks

${taskList}${result.reasoning ? `\n### Reasoning\n${result.reasoning}\n` : ''}`,
      }],
      data: result,
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message);
  }
}

async function handleStrategicDiagnose(args) {
  try {
    const {
      task_id,
      error_output,
      provider,
      exit_code,
      auto_act,
      strategic_provider,
    } = args || {};

    let diagInput = { error_output, provider, exit_code };

    if (task_id) {
      const { task, error: taskErr } = requireTask(db, task_id);
      if (taskErr) return taskErr;

      diagInput = {
        task_description: task.task_description || task.description,
        error_output: error_output || task.error_output || task.output,
        provider: provider || task.provider,
        exit_code: exit_code !== undefined ? exit_code : task.exit_code,
        retry_count: task.retry_count || 0,
      };
    }

    if (!diagInput.error_output) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Either task_id or error_output is required');
    }

    const workingDir = args.working_directory || null;
    const configOverride = args.config_override || null;
    const brain = getBrain(workingDir, strategic_provider, null, configOverride, args.__sessionId);
    const result = await brain.diagnose(diagInput);

    let actionText = `**Action:** ${result.action}\n**Reason:** ${result.reason}`;
    if (result.fix_description) {
      actionText += `\n**Fix:** ${result.fix_description}`;
    }
    if (result.suggested_provider) {
      actionText += `\n**Suggested provider:** ${result.suggested_provider}`;
    }

    return {
      content: [{
        type: 'text',
        text: `## Failure Diagnosis

**Source:** ${result.source} | **Confidence:** ${result.confidence || 'N/A'}${result.fallback_reason ? ` | **Fallback reason:** ${result.fallback_reason}` : ''}

${actionText}
`,
      }],
      data: result,
      auto_act: auto_act || false,
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message);
  }
}

async function handleStrategicReview(args) {
  try {
    const {
      task_id,
      task_output,
      validation_failures,
      file_size_delta_pct,
      strategic_provider,
    } = args || {};

    let reviewInput = { task_output, validation_failures, file_size_delta_pct };

    if (task_id) {
      const { task, error: taskErr } = requireTask(db, task_id);
      if (taskErr) return taskErr;

      reviewInput = {
        task_description: task.task_description || task.description,
        task_output: task_output || task.output,
        validation_failures: validation_failures ?? [],
        file_size_delta_pct: file_size_delta_pct ?? 0,
      };
    }

    const workingDir = args.working_directory || null;
    const configOverride = args.config_override || null;
    const brain = getBrain(workingDir, strategic_provider, null, configOverride, args.__sessionId);
    const result = await brain.review(reviewInput);
    const issueList = (result.issues || [])
      .map((issue) => `- [${issue.severity}] ${issue.file || 'general'}: ${issue.description}`)
      .join('\n');

    return {
      content: [{
        type: 'text',
        text: `## Quality Review

**Decision:** ${result.decision} | **Score:** ${result.quality_score || 'N/A'}/100
**Source:** ${result.source} | **Confidence:** ${result.confidence || 'N/A'}${result.fallback_reason ? ` | **Fallback reason:** ${result.fallback_reason}` : ''}

**Reason:** ${result.reason}${issueList ? `\n### Issues\n${issueList}\n` : ''}`,
      }],
      data: result,
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message);
  }
}

async function handleStrategicUsage(_args) {
  try {
    const brain = getBrain(null);
    const usage = brain.getUsage();
  const totalRuns = usage.total_calls + usage.fallback_calls;
  const fallbackRate = totalRuns > 0 ? ((usage.fallback_calls / totalRuns) * 100).toFixed(1) : '0';

  return {
    content: [{
      type: 'text',
      text: `## Strategic Brain Usage

| Metric | Value |
|--------|-------|
| LLM Calls | ${usage.total_calls} |
| Fallback Calls | ${usage.fallback_calls} |
| Total Tokens | ${usage.total_tokens.toLocaleString()} |
| Total Cost | $${usage.total_cost.toFixed(4)} |
| Total Duration | ${(usage.total_duration_ms / 1000).toFixed(1)}s |
| Fallback Rate | ${fallbackRate}% |
`,
    }],
    data: usage,
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message);
  }
}

async function handleStrategicBenchmark(args) {
  try {
    const {
      suite = 'all',
      provider,
      model,
      output_format = 'summary',
    } = args || {};

    const benchmarkSuite = loadBenchmarkSuite();
  if (!benchmarkSuite) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'Strategic benchmark suite not found');
  }

  const { DECOMPOSE_CASES, DIAGNOSE_CASES, REVIEW_CASES } = benchmarkSuite;
  const caseMap = {
    decompose: DECOMPOSE_CASES,
    diagnose: DIAGNOSE_CASES,
    review: REVIEW_CASES,
  };
  const suites = suite === 'all' ? ['decompose', 'diagnose', 'review'] : [suite];
  const brain = getBrain(null, provider, model);
  const harness = new BenchmarkHarness();

  for (const currentSuite of suites) {
    const cases = caseMap[currentSuite];
    if (!Array.isArray(cases)) {
      return makeError(ErrorCodes.INVALID_PARAM, `Unknown suite: ${currentSuite}`);
    }

    for (const testCase of cases) {
      const start = Date.now();
      try {
        const result = await brain[currentSuite](testCase.input);
        harness.record({
          task_name: `${currentSuite}/${testCase.name}`,
          source: result.source,
          duration_ms: Date.now() - start,
          tokens: result.usage?.tokens || 0,
          cost: result.usage?.cost || 0,
          confidence: result.confidence || 0,
          quality_score: result.quality_score || null,
          tasks_generated: result.tasks?.length || null,
          expected_met: currentSuite === 'decompose'
            ? result.tasks?.length >= testCase.expected_min_tasks && result.tasks?.length <= testCase.expected_max_tasks
            : currentSuite === 'diagnose'
              ? result.action === testCase.expected_action
              : result.decision === testCase.expected_decision,
        });
      } catch (err) {
        harness.record({
          task_name: `${currentSuite}/${testCase.name}`,
          source: 'error',
          duration_ms: Date.now() - start,
          tokens: 0,
          cost: 0,
          confidence: 0,
          error: err.message,
          expected_met: false,
        });
      }
    }
  }

  const summary = harness.summarize();
  const passed = harness.results.filter((result) => result.expected_met).length;
  const total = harness.results.length;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(0) : '0';

  if (output_format === 'csv') {
    return {
      content: [{ type: 'text', text: harness.toCsv() }],
      data: { summary, results: harness.results },
    };
  }

  if (output_format === 'full') {
    const details = harness.results
      .map((result) => `- **${result.task_name}**: ${result.source} | ${result.duration_ms}ms | ${result.expected_met ? 'PASS' : 'FAIL'}${result.error ? ` (${result.error})` : ''}`)
      .join('\n');

    return {
      content: [{
        type: 'text',
        text: `## Benchmark Results

${details}

**${passed}/${total} passed** | Cost: $${summary.total_cost.toFixed(4)}`,
      }],
      data: { summary, results: harness.results },
    };
  }

  return {
    content: [{
      type: 'text',
      text: `## Benchmark Summary

| Metric | Value |
|--------|-------|
| Total Runs | ${summary.total_runs} |
| Passed | ${passed}/${total} (${passRate}%) |
| LLM Runs | ${summary.llm_runs} |
| Fallback Runs | ${summary.fallback_runs} |
| Avg Duration | ${summary.avg_duration_ms.toFixed(0)}ms |
| Total Cost | $${summary.total_cost.toFixed(4)} |
| Avg Confidence | ${(summary.avg_confidence * 100).toFixed(0)}% |
`,
    }],
    data: { summary, results: harness.results },
  };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message);
  }
}

function getStrategicStatus() {
  const brain = getBrain(null);
  const usage = brain.getUsage();
  return {
    provider: brain.provider,
    model: brain.model,
    confidence_threshold: brain.confidenceThreshold,
    usage,
    fallback_chain: ['deepinfra', 'hyperbolic', 'ollama'],
  };
}

module.exports = {
  handleStrategicDecompose,
  handleStrategicDiagnose,
  handleStrategicReview,
  handleStrategicUsage,
  handleStrategicBenchmark,
  getStrategicStatus,
};
