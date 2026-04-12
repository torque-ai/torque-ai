'use strict';

const { createProposer } = require('../integrations/codebase-study/proposal');

function createSchedulingAutomationMock() {
  return {
    listApprovalRules: vi.fn(() => []),
    createApprovalRule: vi.fn(() => 'study-rule-1'),
    createApprovalRequest: vi.fn((taskId) => `approval-${taskId}`),
  };
}

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

describe('codebase-study proposal module', () => {
  it('submits follow-up tasks for suggested study proposals', async () => {
    const taskCore = {
      listTasks: vi.fn(() => []),
      submitTask: vi.fn(),
    };
    const schedulingAutomation = createSchedulingAutomationMock();
    const proposer = createProposer({
      taskCore,
      schedulingAutomation,
      logger: createLogger(),
    });

    const evaluation = {
      project: 'study-repo',
      workingDirectory: 'C:/tmp/study-repo',
      proposalLimit: 5,
      proposals: {
        policy: {
          allowed: true,
          threshold_level: 'high',
          threshold_score: 40,
          suppressed_count: 0,
        },
        suggested: [
          {
            key: 'parser-coverage',
            title: 'Tighten parser coverage',
            rationale: 'The parser seam has no direct regression test.',
            task: 'Add parser regression coverage for the exported parser helpers.',
            tags: ['study', 'parser'],
            files: ['server/integrations/codebase-study/parsers/index.js'],
            related_tests: ['server/tests/codebase-study-parsers.test.js'],
            validation_commands: ['cd server && npx vitest run tests/codebase-study-parsers.test.js'],
            affected_invariants: ['Parser helpers stay language-agnostic.'],
            priority: 70,
            kind: 'study-followup',
            trace: { scope: 'parsers' },
          },
          {
            key: 'profile-roundtrip',
            title: 'Cover profile override round-trip',
            rationale: 'Override persistence needs explicit regression coverage.',
            task: 'Add save/load round-trip tests for profile overrides.',
            tags: ['study', 'profile'],
            files: ['server/integrations/codebase-study/profile.js'],
            related_tests: ['server/tests/codebase-study-profile.test.js'],
            validation_commands: ['cd server && npx vitest run tests/codebase-study-profile.test.js'],
            affected_invariants: ['Profile overrides stay repo-local and deterministic.'],
            priority: 55,
            kind: 'study-followup',
            trace: { scope: 'profile' },
          },
        ],
        submitted: [],
        errors: [],
      },
    };

    const result = await proposer.submitProposals('study-123', evaluation);

    expect(taskCore.submitTask).toHaveBeenCalledTimes(2);
    expect(schedulingAutomation.createApprovalRule).toHaveBeenCalledWith(
      'Study proposal review',
      'all',
      {},
      {
        project: 'study-repo',
        requiredApprovers: 1,
      }
    );
    expect(schedulingAutomation.createApprovalRequest).toHaveBeenCalledTimes(2);

    const submittedTasks = taskCore.submitTask.mock.calls.map((call) => call[0]);
    expect(submittedTasks).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        status: 'pending',
        task_description: '[Study Proposal] Tighten parser coverage\n\nAdd parser regression coverage for the exported parser helpers.',
        working_directory: 'C:/tmp/study-repo',
        project: 'study-repo',
        tags: expect.arrayContaining(['study', 'parser', 'study-delta-proposal', 'pending-approval']),
        timeout_minutes: 30,
        auto_approve: false,
        priority: 70,
        approval_status: 'pending',
        metadata: expect.objectContaining({
          version_intent: 'internal',
          study_proposal: expect.objectContaining({
            source: 'codebase-study',
            key: 'parser-coverage',
            title: 'Tighten parser coverage',
            files: ['server/integrations/codebase-study/parsers/index.js'],
            related_tests: ['server/tests/codebase-study-parsers.test.js'],
            validation_commands: ['cd server && npx vitest run tests/codebase-study-parsers.test.js'],
            affected_invariants: ['Parser helpers stay language-agnostic.'],
            trace: { scope: 'parsers' },
            created_at: expect.any(String),
          }),
        }),
      }),
      expect.objectContaining({
        id: expect.any(String),
        status: 'pending',
        task_description: '[Study Proposal] Cover profile override round-trip\n\nAdd save/load round-trip tests for profile overrides.',
        working_directory: 'C:/tmp/study-repo',
        project: 'study-repo',
        tags: expect.arrayContaining(['study', 'profile', 'study-delta-proposal', 'pending-approval']),
        timeout_minutes: 30,
        auto_approve: false,
        priority: 55,
        approval_status: 'pending',
        metadata: expect.objectContaining({
          version_intent: 'internal',
          study_proposal: expect.objectContaining({
            source: 'codebase-study',
            key: 'profile-roundtrip',
            title: 'Cover profile override round-trip',
            files: ['server/integrations/codebase-study/profile.js'],
            related_tests: ['server/tests/codebase-study-profile.test.js'],
            validation_commands: ['cd server && npx vitest run tests/codebase-study-profile.test.js'],
            affected_invariants: ['Profile overrides stay repo-local and deterministic.'],
            trace: { scope: 'profile' },
            created_at: expect.any(String),
          }),
        }),
      }),
    ]);

    expect(result).toEqual({
      policy: evaluation.proposals.policy,
      suggested: [
        expect.objectContaining({
          key: 'parser-coverage',
          title: 'Tighten parser coverage',
        }),
        expect.objectContaining({
          key: 'profile-roundtrip',
          title: 'Cover profile override round-trip',
        }),
      ],
      submitted: [
        {
          title: 'Tighten parser coverage',
          task_id: submittedTasks[0].id,
          approval_id: `approval-${submittedTasks[0].id}`,
        },
        {
          title: 'Cover profile override round-trip',
          task_id: submittedTasks[1].id,
          approval_id: `approval-${submittedTasks[1].id}`,
        },
      ],
      errors: [],
    });
  });

  it('filters duplicate proposals while preserving policy threshold metadata', () => {
    const taskCore = {
      listTasks: vi.fn(() => [
        {
          id: 'existing-proposal-task',
          status: 'pending',
          metadata: {
            study_proposal: {
              key: 'duplicate-proposal',
            },
          },
        },
      ]),
    };
    const proposer = createProposer({
      taskCore,
      schedulingAutomation: createSchedulingAutomationMock(),
      logger: createLogger(),
    });

    const result = proposer.filterProposals(
      [
        {
          key: 'keep-parser',
          title: 'Keep parser follow-up',
          task: 'Retain parser coverage follow-up.',
          tags: ['parser'],
        },
        {
          key: 'duplicate-proposal',
          title: 'Suppress duplicate',
          task: 'This should be suppressed because a proposal is already active.',
          tags: ['duplicate'],
        },
        {
          key: 'keep-profile',
          title: 'Keep profile follow-up',
          task: 'Retain profile override follow-up.',
          tags: ['profile'],
        },
      ],
      {
        project: 'study-repo',
        workingDirectory: 'C:/tmp/study-repo',
        submitProposals: true,
        proposalSignificanceLevel: 'moderate',
        proposalMinScore: 20,
        studyDelta: {
          run: { mode: 'incremental' },
          changed_files: {
            repo_delta: ['server/integrations/codebase-study/profile.js'],
          },
          significance: {
            level: 'high',
            score: 42,
            reasons: ['profile override path changed'],
          },
        },
      }
    );

    expect(taskCore.listTasks).toHaveBeenCalledWith({
      project: 'study-repo',
      tag: 'study-delta-proposal',
      limit: 500,
      includeArchived: true,
    });
    expect(result.policy).toEqual({
      allowed: true,
      reason: null,
      threshold_level: 'moderate',
      threshold_score: 20,
      suppressed_count: 1,
    });
    expect(result.suggested.map((proposal) => proposal.key)).toEqual([
      'keep-parser',
      'keep-profile',
    ]);
    expect(result.errors).toEqual([
      {
        title: 'Suppress duplicate',
        error: 'Suppressed duplicate proposal (existing_pending_or_active_proposal)',
        existing_task_id: 'existing-proposal-task',
      },
    ]);
    expect(result.submitted).toEqual([]);
  });
});
