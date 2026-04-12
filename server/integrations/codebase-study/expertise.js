'use strict';

function defaultUniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function defaultToRepoPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function createDefaultUniquePaths(toRepoPath) {
  return function uniquePaths(values) {
    const seen = new Set();
    const output = [];
    for (const value of Array.isArray(values) ? values : []) {
      const normalized = toRepoPath(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      output.push(normalized);
    }
    return output;
  };
}

function createExpertise(deps = {}) {
  const uniqueStrings = typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : defaultUniqueStrings;
  const uniquePaths = typeof deps.uniquePaths === 'function'
    ? deps.uniquePaths
    : createDefaultUniquePaths(defaultToRepoPath);
  const findTestsForFiles = typeof deps.findTestsForFiles === 'function' ? deps.findTestsForFiles : (() => []);
  const buildValidationCommands = typeof deps.buildValidationCommands === 'function' ? deps.buildValidationCommands : (() => []);
  const SUMMARY_SUBSYSTEM_LIMIT = Number.isInteger(deps.SUMMARY_SUBSYSTEM_LIMIT) && deps.SUMMARY_SUBSYSTEM_LIMIT > 0
    ? deps.SUMMARY_SUBSYSTEM_LIMIT
    : 6;
  const TRACE_LIMIT = Number.isInteger(deps.TRACE_LIMIT) && deps.TRACE_LIMIT > 0 ? deps.TRACE_LIMIT : 5;
  const NAVIGATION_HINT_LIMIT = Number.isInteger(deps.NAVIGATION_HINT_LIMIT) && deps.NAVIGATION_HINT_LIMIT > 0
    ? deps.NAVIGATION_HINT_LIMIT
    : 6;
  const GENERIC_FLOW_IDS = deps.GENERIC_FLOW_IDS && typeof deps.GENERIC_FLOW_IDS === 'object'
    ? deps.GENERIC_FLOW_IDS
    : Object.freeze({
        ENTRY_RUNTIME: 'generic-entry-runtime',
        CONFIG_CONTRACTS: 'generic-config-contracts',
        CHANGE_VALIDATION: 'generic-change-validation',
      });

  function findRelevantInvariants(files, invariants, limit = 3) {
    const targetSet = new Set(uniquePaths(files));
    if (targetSet.size === 0) return [];
    return (Array.isArray(invariants) ? invariants : [])
      .map((item) => ({
        item,
        matches: (item.evidence_files || []).filter(file => targetSet.has(file)).length,
      }))
      .filter(({ matches }) => matches > 0)
      .sort((left, right) => right.matches - left.matches || left.item.label.localeCompare(right.item.label))
      .slice(0, limit)
      .map(({ item }) => ({
        id: item.id,
        label: item.label,
        statement: item.statement,
      }));
  }

  function getSubsystemGuidance(activeProfile, subsystem) {
    const guidance = activeProfile?.subsystem_guidance?.[subsystem?.id];
    if (guidance) return guidance;
    return {
      invariants: [`Keep ${subsystem?.label || 'this subsystem'} as a coherent seam instead of scattering its responsibilities across the repo.`],
      watchouts: [`Edits in ${subsystem?.label || 'this subsystem'} should be checked for dependency ripple and representative tests.`],
    };
  }

  function buildOperationalInvariants(subsystems, flows, testInventory, activeProfile) {
    const invariants = [];

    for (const flow of flows || []) {
      const guidance = activeProfile?.flow_guidance?.[flow.id];
      for (const statement of guidance?.invariants || []) {
        const evidenceFiles = uniquePaths(flow.files).slice(0, 5);
        invariants.push({
          id: `${flow.id}:${invariants.length + 1}`,
          label: flow.label,
          scope_type: 'flow',
          scope_id: flow.id,
          statement,
          why_it_matters: flow.summary,
          evidence_files: evidenceFiles,
          related_files: evidenceFiles,
          related_tests: findTestsForFiles(flow.files, testInventory),
        });
      }
    }

    for (const subsystem of (subsystems || []).slice(0, SUMMARY_SUBSYSTEM_LIMIT + 2)) {
      const guidance = getSubsystemGuidance(activeProfile, subsystem);
      for (const statement of guidance.invariants || []) {
        const evidenceFiles = uniquePaths(subsystem.entrypoints || subsystem.representative_files).slice(0, 4);
        invariants.push({
          id: `${subsystem.id}:${invariants.length + 1}`,
          label: subsystem.label,
          scope_type: 'subsystem',
          scope_id: subsystem.id,
          statement,
          why_it_matters: subsystem.description,
          evidence_files: evidenceFiles,
          related_files: evidenceFiles,
          related_tests: findTestsForFiles(subsystem.representative_files || subsystem.entrypoints || [], testInventory),
        });
      }
    }

    return invariants.slice(0, 12);
  }

  function buildFailureModes(flows, hotspots, testInventory, activeProfile) {
    const failureModes = [];

    for (const flow of flows || []) {
      const guidance = activeProfile?.flow_guidance?.[flow.id];
      for (const failureMode of guidance?.failure_modes || []) {
        failureModes.push({
          id: `${flow.id}:${failureModes.length + 1}`,
          label: failureMode.label,
          scope_type: 'flow',
          scope_id: flow.id,
          symptoms: failureMode.symptoms,
          why_it_happens: flow.summary,
          investigate_first: uniquePaths(failureMode.investigate_first || flow.files).slice(0, 5),
          related_tests: findTestsForFiles(failureMode.investigate_first || flow.files, testInventory),
        });
      }
    }

    for (const hotspot of (hotspots || []).slice(0, 2)) {
      failureModes.push({
        id: `hotspot:${hotspot.file}`,
        label: `Hotspot drift around ${hotspot.file}`,
        scope_type: 'hotspot',
        scope_id: hotspot.file,
        symptoms: hotspot.reason,
        why_it_happens: 'High fan-in or fan-out files are common places for implicit coupling to accumulate over time.',
        investigate_first: [hotspot.file],
        related_tests: findTestsForFiles([hotspot.file], testInventory),
      });
    }

    return failureModes.slice(0, 10);
  }

  function buildCanonicalTraces(flows, testInventory, activeProfile) {
    return (flows || [])
      .slice(0, TRACE_LIMIT)
      .map((flow) => ({
        id: flow.id,
        label: flow.label,
        question: flow.questions_it_answers?.[0] || `How does ${flow.label.toLowerCase()} work?`,
        summary: flow.summary,
        sequence: (flow.steps || []).map((step) => ({
          label: step.label,
          description: step.description,
          files: uniquePaths(step.files).slice(0, 3),
        })),
        success_signals: activeProfile?.flow_guidance?.[flow.id]?.success_signals || [],
        related_tests: findTestsForFiles(flow.files, testInventory),
      }));
  }

  function buildChangePlaybooks(subsystems, flows, testInventory, activeProfile, workingDirectory, invariants) {
    const playbooks = [];

    for (const subsystem of (subsystems || []).slice(0, SUMMARY_SUBSYSTEM_LIMIT + 2)) {
      const guidance = getSubsystemGuidance(activeProfile, subsystem);
      const readFirst = uniquePaths(subsystem.entrypoints || subsystem.representative_files).slice(0, 4);
      const inspectAlso = uniquePaths([
        ...(subsystem.representative_files || []),
        ...((subsystem.central_files || []).map(file => file.file)),
      ]).slice(0, 5);
      const relatedTests = findTestsForFiles(subsystem.representative_files || subsystem.entrypoints || [], testInventory);
      const relatedFiles = uniquePaths([...readFirst, ...inspectAlso]);
      playbooks.push({
        id: `${subsystem.id}-playbook`,
        label: `Editing ${subsystem.label}`,
        when_to_use: subsystem.description,
        read_first: readFirst,
        inspect_also: inspectAlso,
        related_files: relatedFiles,
        edit_surface: relatedFiles,
        related_tests: relatedTests,
        validation_commands: buildValidationCommands({
          workingDirectory,
          relatedTests,
          relatedFiles,
          activeProfile,
          scopeId: subsystem.id,
        }),
        invariants_to_recheck: findRelevantInvariants(relatedFiles, invariants),
        watchouts: (guidance.watchouts || []).slice(0, 3),
      });
    }

    for (const flow of (flows || []).slice(0, 2)) {
      const readFirst = uniquePaths(flow.files).slice(0, 5);
      const inspectAlso = uniquePaths(flow.steps.flatMap(step => step.files || [])).slice(0, 6);
      const relatedTests = findTestsForFiles(flow.files, testInventory);
      const relatedFiles = uniquePaths([...readFirst, ...inspectAlso]);
      playbooks.push({
        id: `${flow.id}-playbook`,
        label: `Tracing ${flow.label}`,
        when_to_use: flow.summary,
        read_first: readFirst,
        inspect_also: inspectAlso,
        related_files: relatedFiles,
        edit_surface: relatedFiles,
        related_tests: relatedTests,
        validation_commands: buildValidationCommands({
          workingDirectory,
          relatedTests,
          relatedFiles,
          activeProfile,
          scopeId: flow.id,
        }),
        invariants_to_recheck: findRelevantInvariants(relatedFiles, invariants),
        watchouts: (activeProfile?.flow_guidance?.[flow.id]?.failure_modes || []).map(item => item.label).slice(0, 3),
      });
    }

    return playbooks.slice(0, 10);
  }

  function buildImpactGuidance(subsystems, flows, invariants, testInventory, activeProfile, workingDirectory) {
    const guidance = [];

    for (const subsystem of (subsystems || []).slice(0, SUMMARY_SUBSYSTEM_LIMIT + 2)) {
      const readFirst = uniquePaths(subsystem.entrypoints || subsystem.representative_files).slice(0, 4);
      const inspectAlso = uniquePaths([
        ...(subsystem.representative_files || []),
        ...((subsystem.central_files || []).map(file => file.file)),
      ]).slice(0, 5);
      const relatedFiles = uniquePaths([...readFirst, ...inspectAlso]);
      const relatedTests = findTestsForFiles(relatedFiles, testInventory);
      guidance.push({
        id: `${subsystem.id}-impact`,
        scope_type: 'subsystem',
        scope_id: subsystem.id,
        label: subsystem.label,
        summary: subsystem.description,
        read_first: readFirst,
        related_files: relatedFiles,
        related_tests: relatedTests,
        validation_commands: buildValidationCommands({
          workingDirectory,
          relatedTests,
          relatedFiles,
          activeProfile,
          scopeId: subsystem.id,
        }),
        invariants_to_recheck: findRelevantInvariants(relatedFiles, invariants),
      });
    }

    for (const flow of (flows || []).slice(0, 3)) {
      const readFirst = uniquePaths(flow.files).slice(0, 5);
      const inspectAlso = uniquePaths(flow.steps.flatMap(step => step.files || [])).slice(0, 6);
      const relatedFiles = uniquePaths([...readFirst, ...inspectAlso]);
      const relatedTests = findTestsForFiles(relatedFiles, testInventory);
      guidance.push({
        id: `${flow.id}-impact`,
        scope_type: 'flow',
        scope_id: flow.id,
        label: flow.label,
        summary: flow.summary,
        read_first: readFirst,
        related_files: relatedFiles,
        related_tests: relatedTests,
        validation_commands: buildValidationCommands({
          workingDirectory,
          relatedTests,
          relatedFiles,
          activeProfile,
          scopeId: flow.id,
        }),
        invariants_to_recheck: findRelevantInvariants(relatedFiles, invariants),
      });
    }

    return guidance.slice(0, 12);
  }

  function buildExpertiseOnramp(profile, entrypoints, flows, invariants, subsystems) {
    const readOrder = uniquePaths([
      ...(entrypoints || []).slice(0, 4).map(item => item.file),
      ...((flows || [])[0]?.files || []).slice(0, 3),
      ...((flows || [])[1]?.files || []).slice(0, 2),
      ...((flows || [])[2]?.files || []).slice(0, 2),
      ...((subsystems || []).slice(0, 3).flatMap(item => item.representative_files || [])).slice(0, 4),
    ]).slice(0, 8);
    return {
      profile: profile.label,
      summary: `${profile.description} Start with the top entrypoints and canonical flows, then use invariants and playbooks to reason about changes safely.`,
      read_order: readOrder,
      confidence: readOrder.length >= 6 ? 'high' : 'medium',
      first_questions: uniqueStrings((flows || []).flatMap(flow => flow.questions_it_answers || [])).slice(0, 5),
      first_invariants: (invariants || []).slice(0, 3).map(item => item.statement),
    };
  }

  function buildCapabilityList(subsystems, flows) {
    const subsystemIds = new Set((subsystems || []).map(subsystem => subsystem.id));
    const flowIds = new Set((flows || []).map(flow => flow.id));
    const capabilities = [];

    if (flowIds.has('task-lifecycle') || subsystemIds.has('task-execution')) {
      capabilities.push('Multi-provider task execution with verification and completion handling');
    }
    if (flowIds.has('workflow-lifecycle') || subsystemIds.has('workflow-orchestration')) {
      capabilities.push('Workflow DAG orchestration and dependency-driven task unblocking');
    }
    if (flowIds.has('provider-routing') || subsystemIds.has('provider-adapters')) {
      capabilities.push('Provider routing, fallback, and health-aware execution');
    }
    if (flowIds.has('scheduled-automation') || subsystemIds.has('governance-maintenance')) {
      capabilities.push('Scheduled automation and background maintenance loops');
    }
    if (subsystemIds.has('tooling-mcp-surface') || subsystemIds.has('control-plane-api')) {
      capabilities.push('MCP and HTTP control-plane surfaces for tools, tasks, and governance');
    }
    if (subsystemIds.has('dashboard-ui')) {
      capabilities.push('Dashboard visibility for tasks, providers, workflows, budgets, and schedules');
    }
    if (flowIds.has(GENERIC_FLOW_IDS.ENTRY_RUNTIME)) {
      capabilities.push('Fast entrypoint-to-implementation map for the main runtime, CLI, or UI surface');
    }
    if (flowIds.has(GENERIC_FLOW_IDS.CONFIG_CONTRACTS)) {
      capabilities.push('Config, manifest, locale, or schema files tied back to their consuming modules');
    }
    if (flowIds.has(GENERIC_FLOW_IDS.CHANGE_VALIDATION)) {
      capabilities.push('Change guidance that links risky seams to tests, harnesses, or build surfaces');
    }
    return capabilities.slice(0, 6);
  }

  function buildNavigationHints(flows, subsystems, entrypoints) {
    const hints = [];
    const seenQuestions = new Set();

    for (const flow of flows || []) {
      const question = flow.questions_it_answers?.[0] || `How does ${flow.label.toLowerCase()} work?`;
      if (seenQuestions.has(question)) continue;
      seenQuestions.add(question);
      hints.push({
        question,
        read_first: uniquePaths(flow.files).slice(0, 5),
        rationale: flow.summary,
      });
      if (hints.length >= NAVIGATION_HINT_LIMIT) return hints;
    }

    for (const subsystem of subsystems || []) {
      const question = `What lives in the ${subsystem.label.toLowerCase()}?`;
      if (seenQuestions.has(question)) continue;
      seenQuestions.add(question);
      hints.push({
        question,
        read_first: uniquePaths(subsystem.entrypoints || subsystem.representative_files).slice(0, 4),
        rationale: subsystem.overview,
      });
      if (hints.length >= NAVIGATION_HINT_LIMIT) return hints;
    }

    if (hints.length === 0 && Array.isArray(entrypoints) && entrypoints.length > 0) {
      hints.push({
        question: 'Where should a model start reading this repository?',
        read_first: entrypoints.slice(0, 5).map(entrypoint => entrypoint.file),
        rationale: 'These entrypoints are the highest-signal starting points discovered by the study.',
      });
    }

    return hints;
  }

  return {
    buildOperationalInvariants,
    findRelevantInvariants,
    getSubsystemGuidance,
    buildFailureModes,
    buildCanonicalTraces,
    buildChangePlaybooks,
    buildImpactGuidance,
    buildExpertiseOnramp,
    buildCapabilityList,
    buildNavigationHints,
  };
}

module.exports = { createExpertise };
