'use strict';

const path = require('path');

function defaultToRepoPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

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

function toIdMap(items, idField = 'id') {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = typeof item?.[idField] === 'string' ? item[idField].trim() : '';
    if (!id) continue;
    map.set(id, item);
  }
  return map;
}

function createProposals(deps = {}) {
  const toRepoPath = typeof deps.toRepoPath === 'function' ? deps.toRepoPath : defaultToRepoPath;
  const uniqueStrings = typeof deps.uniqueStrings === 'function' ? deps.uniqueStrings : defaultUniqueStrings;
  const uniquePaths = typeof deps.uniquePaths === 'function' ? deps.uniquePaths : createDefaultUniquePaths(toRepoPath);
  const getSubsystemForFile = typeof deps.getSubsystemForFile === 'function'
    ? deps.getSubsystemForFile
    : (() => ({ id: 'unknown', label: 'unknown' }));
  const getSubsystemPriority = typeof deps.getSubsystemPriority === 'function' ? deps.getSubsystemPriority : (() => 30);
  const findTestsForFiles = typeof deps.findTestsForFiles === 'function' ? deps.findTestsForFiles : (() => []);
  const buildValidationCommands = typeof deps.buildValidationCommands === 'function' ? deps.buildValidationCommands : (() => []);
  const STUDY_DELTA_FILE = typeof deps.STUDY_DELTA_FILE === 'string' ? deps.STUDY_DELTA_FILE : 'docs/architecture/study-delta.json';
  const KNOWLEDGE_PACK_FILE = typeof deps.KNOWLEDGE_PACK_FILE === 'string' ? deps.KNOWLEDGE_PACK_FILE : 'docs/architecture/knowledge-pack.json';
  const STUDY_DELTA_VERSION = Number.isInteger(deps.STUDY_DELTA_VERSION) ? deps.STUDY_DELTA_VERSION : 1;
  const DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL = typeof deps.DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL === 'string'
    && deps.DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL.trim()
    ? deps.DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL.trim()
    : 'moderate';
  const DEFAULT_PROPOSAL_MIN_SCORE = Number.isInteger(deps.DEFAULT_PROPOSAL_MIN_SCORE)
    ? deps.DEFAULT_PROPOSAL_MIN_SCORE
    : 0;
  const SIGNIFICANCE_REASON_LIMIT = Number.isInteger(deps.SIGNIFICANCE_REASON_LIMIT) && deps.SIGNIFICANCE_REASON_LIMIT > 0
    ? deps.SIGNIFICANCE_REASON_LIMIT
    : 4;
  const MAX_PROPOSAL_LIMIT = Number.isInteger(deps.MAX_PROPOSAL_LIMIT) && deps.MAX_PROPOSAL_LIMIT > 0
    ? deps.MAX_PROPOSAL_LIMIT
    : 5;

  function intersectPaths(left, right) {
    const rightSet = new Set(uniquePaths(right));
    return uniquePaths(left).filter(value => rightSet.has(value));
  }

  function buildCoverageDelta(previousKnowledgePack, nextKnowledgePack) {
    const previous = previousKnowledgePack?.coverage || {};
    const next = nextKnowledgePack?.coverage || {};
    return {
      tracked_files: {
        previous: previous.tracked_files || 0,
        current: next.tracked_files || 0,
        delta: (next.tracked_files || 0) - (previous.tracked_files || 0),
      },
      indexed_modules: {
        previous: previous.indexed_modules || 0,
        current: next.indexed_modules || 0,
        delta: (next.indexed_modules || 0) - (previous.indexed_modules || 0),
      },
      pending_files: {
        previous: previous.pending_files || 0,
        current: next.pending_files || 0,
        delta: (next.pending_files || 0) - (previous.pending_files || 0),
      },
    };
  }

  function buildChangedSubsystems(signalFiles, previousKnowledgePack, nextKnowledgePack, subsystemLookup, activeProfile) {
    const previousSubsystems = toIdMap(previousKnowledgePack?.subsystems || []);
    const nextSubsystems = toIdMap(nextKnowledgePack?.subsystems || []);
    const grouped = new Map();

    for (const filePath of uniquePaths(signalFiles)) {
      const subsystem = subsystemLookup.get(filePath) || getSubsystemForFile(filePath, activeProfile);
      if (!grouped.has(subsystem.id)) {
        const previousCoverage = previousSubsystems.get(subsystem.id)?.coverage || {};
        const nextCoverage = nextSubsystems.get(subsystem.id)?.coverage || {};
        grouped.set(subsystem.id, {
          id: subsystem.id,
          label: subsystem.label,
          changed_files: [],
          coverage_delta: {
            tracked_files: (nextCoverage.tracked_files || 0) - (previousCoverage.tracked_files || 0),
            indexed_modules: (nextCoverage.indexed_modules || 0) - (previousCoverage.indexed_modules || 0),
            pending_files: (nextCoverage.pending_files || 0) - (previousCoverage.pending_files || 0),
          },
        });
      }
      grouped.get(subsystem.id).changed_files.push(filePath);
    }

    return Array.from(grouped.values())
      .map((item) => ({ ...item, changed_files: uniquePaths(item.changed_files) }))
      .sort((left, right) => {
        const priorityDiff = getSubsystemPriority(activeProfile, right.id) - getSubsystemPriority(activeProfile, left.id);
        if (priorityDiff !== 0) return priorityDiff;
        return right.changed_files.length - left.changed_files.length || left.label.localeCompare(right.label);
      });
  }

  function buildAffectedFlows(signalFiles, knowledgePack) {
    return (knowledgePack?.flows || [])
      .map((flow) => {
        const matchedFiles = intersectPaths(flow.files || [], signalFiles);
        if (matchedFiles.length === 0) return null;
        return {
          id: flow.id,
          label: flow.label,
          question: flow.questions_it_answers?.[0] || null,
          matched_files: matchedFiles,
          read_first: uniquePaths(flow.files || []).slice(0, 5),
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.matched_files.length - left.matched_files.length || left.label.localeCompare(right.label));
  }

  function buildInvariantHits(signalFiles, knowledgePack) {
    return (knowledgePack?.expertise?.invariants || [])
      .map((item) => {
        const matchedFiles = intersectPaths(item.evidence_files || [], signalFiles);
        if (matchedFiles.length === 0) return null;
        return {
          id: item.id,
          label: item.label,
          scope_type: item.scope_type,
          scope_id: item.scope_id,
          statement: item.statement,
          matched_files: matchedFiles,
          related_tests: uniquePaths(item.related_tests || []).slice(0, 4),
          evidence_files: uniquePaths(item.evidence_files || []).slice(0, 5),
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.matched_files.length - left.matched_files.length || left.label.localeCompare(right.label));
  }

  function buildFailureModeHits(signalFiles, knowledgePack) {
    return (knowledgePack?.expertise?.failure_modes || [])
      .map((item) => {
        const matchedFiles = intersectPaths(item.investigate_first || [], signalFiles);
        if (matchedFiles.length === 0) return null;
        return {
          id: item.id,
          label: item.label,
          scope_type: item.scope_type,
          scope_id: item.scope_id,
          symptoms: item.symptoms,
          matched_files: matchedFiles,
          related_tests: uniquePaths(item.related_tests || []).slice(0, 4),
          investigate_first: uniquePaths(item.investigate_first || []).slice(0, 5),
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.matched_files.length - left.matched_files.length || left.label.localeCompare(right.label));
  }

  function buildHotspotChanges(signalFiles, previousKnowledgePack, nextKnowledgePack) {
    const previousHotspots = new Map((previousKnowledgePack?.hotspots || []).map(item => [item.file, item]));
    const nextHotspots = new Map((nextKnowledgePack?.hotspots || []).map(item => [item.file, item]));
    const entered = [];
    const exited = [];
    const touched = [];

    for (const [file, item] of nextHotspots.entries()) {
      if (!previousHotspots.has(file)) entered.push(item);
    }
    for (const [file, item] of previousHotspots.entries()) {
      if (!nextHotspots.has(file)) exited.push(item);
    }
    for (const file of uniquePaths(signalFiles)) {
      if (nextHotspots.has(file)) touched.push(nextHotspots.get(file));
    }

    return {
      entered: entered.sort((left, right) => left.file.localeCompare(right.file)),
      exited: exited.sort((left, right) => left.file.localeCompare(right.file)),
      touched: uniquePaths(touched.map(item => item.file)).map(file => nextHotspots.get(file)),
    };
  }

  function scoreStudyDelta(delta, activeProfile) {
    if (delta.run?.mode === 'baseline') {
      return {
        level: 'baseline',
        score: 10,
        reasons: ['Initial baseline generated for the repository.'],
      };
    }

    let score = 0;
    const reasons = [];
    const addReason = (points, message) => {
      score += points;
      reasons.push(message);
    };

    if ((delta.changed_files.repo_delta || []).length > 0) {
      addReason(Math.min(18, delta.changed_files.repo_delta.length * 3), `${delta.changed_files.repo_delta.length} repo files changed since the previous study SHA.`);
    }
    if ((delta.affected_flows || []).length > 0) {
      addReason(Math.min(18, delta.affected_flows.length * 7), `${delta.affected_flows.length} canonical flows were touched by the change set.`);
    }
    if ((delta.invariant_hits || []).length > 0) {
      addReason(Math.min(16, delta.invariant_hits.length * 6), `${delta.invariant_hits.length} critical invariants were touched.`);
    }
    if ((delta.failure_mode_hits || []).length > 0) {
      addReason(Math.min(16, delta.failure_mode_hits.length * 6), `${delta.failure_mode_hits.length} known failure modes intersect the changed seams.`);
    }
    const hotspotPressure = (delta.hotspot_changes?.entered?.length || 0) + (delta.hotspot_changes?.touched?.length || 0);
    if (hotspotPressure > 0) {
      addReason(Math.min(14, hotspotPressure * 5), `${hotspotPressure} hotspot files moved or were directly touched.`);
    }
    const highPrioritySubsystems = (delta.changed_subsystems || []).filter(item => getSubsystemPriority(activeProfile, item.id) >= 85);
    if (highPrioritySubsystems.length > 0) {
      addReason(Math.min(14, highPrioritySubsystems.length * 5), `${highPrioritySubsystems.length} high-priority subsystems changed.`);
    }
    if ((delta.changed_files.processed || []).length > 0 && (delta.changed_files.repo_delta || []).length === 0) {
      addReason(Math.min(8, Math.ceil(delta.changed_files.processed.length / 25)), 'The study advanced coverage without any new repository delta.');
    }

    const level = score >= 55
      ? 'critical'
      : score >= 35
        ? 'high'
        : score >= 18
          ? 'medium'
          : score > 0
            ? 'low'
            : 'none';

    return {
      level,
      score,
      reasons: reasons.slice(0, SIGNIFICANCE_REASON_LIMIT),
    };
  }

  function createProposalRecord(key, proposal) {
    return {
      key,
      title: proposal.title,
      rationale: proposal.rationale,
      task: proposal.task,
      tags: uniqueStrings(proposal.tags),
      files: uniquePaths(proposal.files),
      related_tests: uniquePaths(proposal.related_tests),
      validation_commands: uniqueStrings(proposal.validation_commands),
      affected_invariants: uniqueStrings(proposal.affected_invariants),
      priority: Number.isInteger(proposal.priority) ? proposal.priority : 50,
      kind: proposal.kind || 'study-followup',
      trace: proposal.trace && typeof proposal.trace === 'object' ? { ...proposal.trace } : null,
    };
  }

  function buildStudyProposalTrace(studyDelta, focus = {}) {
    const significance = studyDelta?.significance || {};
    const run = studyDelta?.run || {};

    return {
      study_delta_path: STUDY_DELTA_FILE.replace(/\\/g, '/'),
      study_delta_generated_at: studyDelta?.generated_at || null,
      delta_significance_level: significance.level || 'none',
      delta_significance_score: significance.score || 0,
      significance_reasons: uniqueStrings(significance.reasons || []),
      run_mode: run.mode || null,
      manual_run_now: run.manual_run_now === true,
      schedule_id: run.schedule_id || null,
      schedule_name: run.schedule_name || null,
      schedule_run_id: run.schedule_run_id || null,
      wrapper_task_id: run.wrapper_task_id || null,
      changed_subsystems: uniqueStrings((studyDelta?.changed_subsystems || []).map((item) => item.label || item.id)),
      affected_flows: uniqueStrings((studyDelta?.affected_flows || []).map((item) => item.label || item.id)),
      focus_scope_id: focus.scope_id || null,
      focus_label: focus.label || null,
    };
  }

  function buildStudyProposals(studyDelta, knowledgePack, workingDirectory) {
    if (!studyDelta || studyDelta.significance?.level === 'none' || studyDelta.run?.mode === 'baseline') {
      return [];
    }

    const proposals = [];
    const seen = new Set();
    const impactGuidance = Array.isArray(knowledgePack?.expertise?.impact_guidance)
      ? knowledgePack.expertise.impact_guidance
      : [];
    const impactByScopeId = new Map(impactGuidance.map((item) => [item.scope_id, item]));
    const addProposal = (key, proposal) => {
      if (!key || seen.has(key)) return;
      seen.add(key);
      proposals.push(createProposalRecord(key, proposal));
    };
    const priorityBase = studyDelta.significance.level === 'critical'
      ? 80
      : studyDelta.significance.level === 'high'
        ? 70
        : studyDelta.significance.level === 'moderate'
          ? 60
          : 45;

    for (const hit of (studyDelta.invariant_hits || []).slice(0, 2)) {
      const impact = impactByScopeId.get(hit.scope_id);
      const trace = buildStudyProposalTrace(studyDelta, {
        scope_id: hit.scope_id,
        label: hit.label,
      });
      addProposal(`invariant:${hit.scope_id}`, {
        title: `Review ${hit.label} changes for invariant drift`,
        rationale: `Changed files intersect a critical invariant for ${hit.label}.`,
        task: [
          `Review recent changes in ${workingDirectory} that touched the ${hit.label} seam.`,
          `Focus on this invariant: ${hit.statement}`,
          `Changed files: ${hit.matched_files.join(', ') || 'n/a'}.`,
          `Inspect first: ${hit.evidence_files.join(', ') || 'n/a'}.`,
          `Relevant tests: ${(hit.related_tests || []).join(', ') || 'none identified'}.`,
          `Validation commands: ${(impact?.validation_commands || []).join(' ; ') || 'none suggested'}.`,
          'Return findings in APPROVE/FLAG style and call out any missing validation or architectural drift.',
        ].join('\n'),
        tags: ['study-delta', 'study-followup', 'invariant-review'],
        files: [...(hit.matched_files || []), ...(hit.evidence_files || [])],
        related_tests: [...(hit.related_tests || []), ...(impact?.related_tests || [])],
        validation_commands: impact?.validation_commands || [],
        affected_invariants: [hit.statement],
        priority: priorityBase,
        kind: 'invariant-review',
        trace,
      });
    }

    for (const hit of (studyDelta.failure_mode_hits || []).slice(0, 1)) {
      const impact = impactByScopeId.get(hit.scope_id);
      const trace = buildStudyProposalTrace(studyDelta, {
        scope_id: hit.scope_id,
        label: hit.label,
      });
      addProposal(`failure:${hit.scope_id}`, {
        title: `Validate ${hit.label} risk after recent changes`,
        rationale: `The change set intersects a known failure mode: ${hit.label}.`,
        task: [
          `Investigate the ${hit.label} risk in ${workingDirectory}.`,
          `Symptoms to guard against: ${hit.symptoms}`,
          `Changed files: ${hit.matched_files.join(', ') || 'n/a'}.`,
          `Investigate first: ${(hit.investigate_first || []).join(', ') || 'n/a'}.`,
          `Relevant tests: ${(hit.related_tests || []).join(', ') || 'none identified'}.`,
          `Validation commands: ${(impact?.validation_commands || []).join(' ; ') || 'none suggested'}.`,
          'Decide whether the current changes need follow-up fixes, stronger tests, or no action.',
        ].join('\n'),
        tags: ['study-delta', 'study-followup', 'failure-mode-review'],
        files: [...(hit.matched_files || []), ...(hit.investigate_first || [])],
        related_tests: [...(hit.related_tests || []), ...(impact?.related_tests || [])],
        validation_commands: impact?.validation_commands || [],
        affected_invariants: (impact?.invariants_to_recheck || []).map(item => item.statement),
        priority: priorityBase - 5,
        kind: 'failure-mode-review',
        trace,
      });
    }

    const hotspotFiles = uniquePaths([
      ...((studyDelta.hotspot_changes?.entered || []).map(item => item.file)),
      ...((studyDelta.hotspot_changes?.touched || []).map(item => item.file)),
    ]);
    if (hotspotFiles.length > 0) {
      const trace = buildStudyProposalTrace(studyDelta, {
        scope_id: 'hotspot-audit',
        label: path.basename(hotspotFiles[0]),
      });
      addProposal(`hotspot:${hotspotFiles[0]}`, {
        title: `Audit hotspot coupling around ${path.basename(hotspotFiles[0])}`,
        rationale: 'A hotspot file entered or was touched by the latest repo delta.',
        task: [
          `Audit the coupling and blast radius around these hotspot files in ${workingDirectory}:`,
          hotspotFiles.join(', '),
          `Use the current knowledge pack at ${KNOWLEDGE_PACK_FILE.replace(/\\/g, '/')} and the study delta at ${STUDY_DELTA_FILE.replace(/\\/g, '/')} for context.`,
          'Identify whether the change increased architectural risk, hidden dependencies, or missing regression coverage.',
        ].join('\n'),
        tags: ['study-delta', 'study-followup', 'hotspot-audit'],
        files: hotspotFiles,
        related_tests: findTestsForFiles(hotspotFiles, { tests: knowledgePack?.expertise?.test_matrix ? [] : [] }),
        validation_commands: buildValidationCommands({
          workingDirectory,
          relatedTests: findTestsForFiles(hotspotFiles, { tests: [] }),
          relatedFiles: hotspotFiles,
          activeProfile: null,
          scopeId: 'hotspot-audit',
        }),
        priority: priorityBase - 10,
        kind: 'hotspot-audit',
        trace,
      });
    }

    const changedLabels = (studyDelta.changed_subsystems || []).slice(0, 3).map(item => item.label);
    if ((studyDelta.affected_flows || []).length >= 2 || changedLabels.length >= 2) {
      const trace = buildStudyProposalTrace(studyDelta, {
        scope_id: 'cross-subsystem-impact',
        label: 'Cross-subsystem impact',
      });
      addProposal('cross-subsystem-impact', {
        title: 'Validate cross-subsystem impact from recent architectural delta',
        rationale: 'The change set touched multiple core subsystems or flows.',
        task: [
          `Review the latest architectural delta in ${workingDirectory}.`,
          `Changed subsystems: ${changedLabels.join(', ') || 'n/a'}.`,
          `Affected flows: ${(studyDelta.affected_flows || []).map(item => item.label).join(', ') || 'n/a'}.`,
          `Use ${STUDY_DELTA_FILE.replace(/\\/g, '/')} and ${KNOWLEDGE_PACK_FILE.replace(/\\/g, '/')} to assess whether any follow-up work is needed.`,
          'Focus on cross-subsystem regressions, missing tests, and scheduler/provider workflow interactions.',
        ].join('\n'),
        tags: ['study-delta', 'study-followup', 'cross-subsystem-review'],
        files: uniquePaths((studyDelta.changed_files?.repo_delta || []).slice(0, 10)),
        related_tests: uniquePaths((studyDelta.affected_flows || []).flatMap(item => impactByScopeId.get(item.id)?.related_tests || [])),
        validation_commands: uniqueStrings((studyDelta.affected_flows || []).flatMap(item => impactByScopeId.get(item.id)?.validation_commands || [])),
        affected_invariants: uniqueStrings((studyDelta.invariant_hits || []).map(item => item.statement)),
        priority: priorityBase - 8,
        kind: 'cross-subsystem-review',
        trace,
      });
    }

    return proposals.slice(0, MAX_PROPOSAL_LIMIT);
  }

  function buildStudyDelta(previousKnowledgePack, nextKnowledgePack, context = {}) {
    const signalFiles = uniquePaths(context.signalFiles || []);
    const processedFiles = uniquePaths(context.processedFiles || []);
    const removedFiles = uniquePaths(context.removedFiles || []);
    const subsystemLookup = context.subsystemLookup || new Map();
    const activeProfile = context.activeProfile || null;
    const comparisonBase = (!context.isBaseline && (!previousKnowledgePack || !previousKnowledgePack.generated_at))
      ? nextKnowledgePack
      : previousKnowledgePack;
    const coverageDelta = buildCoverageDelta(comparisonBase, nextKnowledgePack);
    const changedSubsystems = buildChangedSubsystems(signalFiles, comparisonBase, nextKnowledgePack, subsystemLookup, activeProfile);
    const affectedFlows = buildAffectedFlows(signalFiles, nextKnowledgePack);
    const invariantHits = buildInvariantHits(signalFiles, nextKnowledgePack);
    const failureModeHits = buildFailureModeHits(signalFiles, nextKnowledgePack);
    const hotspotChanges = buildHotspotChanges(signalFiles, comparisonBase, nextKnowledgePack);
    const runMode = context.isBaseline
      ? 'baseline'
      : signalFiles.length > 0
        ? 'repo-delta'
        : processedFiles.length > 0 || removedFiles.length > 0
          ? 'study-progress'
          : context.forceRefresh === true
            ? 'refresh'
            : 'up-to-date';

    const delta = {
      version: STUDY_DELTA_VERSION,
      generated_at: context.generatedAt || new Date().toISOString(),
      repo: {
        name: nextKnowledgePack?.repo?.name || path.basename(context.workingDirectory || process.cwd()),
        working_directory: context.workingDirectory || nextKnowledgePack?.repo?.working_directory || null,
        previous_sha: context.previousSha || null,
        current_sha: context.currentSha || null,
        study_profile_id: nextKnowledgePack?.study_profile?.id || null,
      },
      run: {
        mode: runMode,
        manual_run_now: context.manualRunNow === true,
        force_refresh: context.forceRefresh === true,
        batch_count: context.batchCount || 0,
        schedule_id: context.scheduleId || null,
        schedule_name: context.scheduleName || null,
        schedule_run_id: context.scheduleRunId || null,
        wrapper_task_id: context.currentTaskId || null,
      },
      coverage_delta: coverageDelta,
      significance: {
        level: 'none',
        score: 0,
        reasons: [],
      },
      changed_files: {
        repo_delta: signalFiles,
        processed: processedFiles,
        removed: removedFiles,
      },
      changed_subsystems: changedSubsystems,
      affected_flows: affectedFlows,
      invariant_hits: invariantHits,
      failure_mode_hits: failureModeHits,
      hotspot_changes: hotspotChanges,
      proposals: {
        policy: {
          allowed: false,
          reason: 'submission_disabled',
          threshold_level: DEFAULT_PROPOSAL_SIGNIFICANCE_LEVEL,
          threshold_score: DEFAULT_PROPOSAL_MIN_SCORE,
          suppressed_count: 0,
        },
        suggested: [],
        submitted: [],
        errors: [],
      },
    };
    delta.significance = scoreStudyDelta(delta, activeProfile);
    delta.proposals.suggested = buildStudyProposals(delta, nextKnowledgePack, context.workingDirectory);
    return delta;
  }

  return {
    buildStudyProposals,
    buildStudyProposalTrace,
    createProposalRecord,
    scoreStudyDelta,
    buildStudyDelta,
    buildCoverageDelta,
    buildChangedSubsystems,
    buildAffectedFlows,
    buildInvariantHits,
    buildFailureModeHits,
    buildHotspotChanges,
  };
}

module.exports = { createProposals };
