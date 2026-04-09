'use strict';

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function resetCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Ignore modules that were not loaded.
  }
}

describe('study-telemetry', () => {
  let analyticsRows;
  let recordedEvents;
  let telemetry;

  beforeEach(() => {
    analyticsRows = [];
    recordedEvents = [];

    resetCjsModule('../db/study-telemetry');
    resetCjsModule('../database');
    resetCjsModule('../db/cost-tracking');
    resetCjsModule('../db/event-tracking');

    installCjsModuleMock('../database', {
      getDbInstance() {
        return {
          prepare() {
            return {
              all() {
                return analyticsRows;
              },
            };
          },
        };
      },
    });
    installCjsModuleMock('../db/cost-tracking', {
      getTaskTokenUsage(taskId) {
        if (taskId === 'task-with-context') {
          return [{ input_tokens: 1200, output_tokens: 400, total_tokens: 1600, estimated_cost_usd: 0.011 }];
        }
        return [];
      },
    });
    installCjsModuleMock('../db/event-tracking', {
      recordEvent(eventType, taskId, data) {
        recordedEvents.push({ eventType, taskId, data });
      },
    });

    telemetry = require('../db/study-telemetry');
  });

  afterEach(() => {
    resetCjsModule('../db/study-telemetry');
    resetCjsModule('../database');
    resetCjsModule('../db/cost-tracking');
    resetCjsModule('../db/event-tracking');
  });

  it('records completion telemetry for study-aware tasks', () => {
    const recorded = telemetry.recordStudyTaskCompleted({
      id: 'task-with-context',
      working_directory: 'C:/Projects/MyRepo',
      status: 'completed',
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
      retry_count: 1,
      files_modified: ['src/index.js', 'src/runtime.js'],
      metadata: JSON.stringify({
        study_context_summary: {
          study_profile_id: 'generic-javascript-repo',
          grade: 'A',
          score: 93,
          benchmark_grade: 'A',
          benchmark_score: 95,
        },
      }),
    });

    expect(recorded).toBe(true);
    expect(recordedEvents).toEqual([
      expect.objectContaining({
        eventType: 'study_task_completed',
        taskId: 'task-with-context',
        data: expect.objectContaining({
          working_directory: 'c:\\projects\\myrepo',
          study_context_applied: true,
          study_profile_id: 'generic-javascript-repo',
          total_tokens: 1600,
          cost_usd: 0.011,
          files_modified_count: 2,
        }),
      }),
    ]);
  });

  it('aggregates impact summary across with-context, without-context, and review events', () => {
    analyticsRows = [
      {
        event_type: 'study_task_completed',
        task_id: 'task-1',
        timestamp: '2026-04-09T10:00:00.000Z',
        data: JSON.stringify({
          working_directory: 'C:/Projects/MyRepo',
          study_context_applied: true,
          status: 'completed',
          retry_count: 0,
          provider_switch_count: 0,
          input_tokens: 1000,
          output_tokens: 500,
          total_tokens: 1500,
          cost_usd: 0.01,
          files_modified_count: 3,
        }),
      },
      {
        event_type: 'study_task_completed',
        task_id: 'task-2',
        timestamp: '2026-04-09T11:00:00.000Z',
        data: JSON.stringify({
          working_directory: 'C:/Projects/MyRepo',
          study_context_applied: false,
          status: 'failed',
          retry_count: 2,
          provider_switch_count: 1,
          input_tokens: 1800,
          output_tokens: 700,
          total_tokens: 2500,
          cost_usd: 0.02,
          files_modified_count: 1,
        }),
      },
      {
        event_type: 'study_review_completed',
        task_id: 'review-1',
        timestamp: '2026-04-09T12:00:00.000Z',
        data: JSON.stringify({
          working_directory: 'C:/Projects/MyRepo',
          source_study_context_applied: true,
          review_verdict: 'flag',
          review_issue_count: 2,
        }),
      },
    ];

    const summary = telemetry.getStudyImpactSummary({
      workingDirectory: 'C:/Projects/MyRepo',
      sinceDays: 30,
    });

    expect(summary).toEqual(expect.objectContaining({
      has_data: true,
      task_outcomes: expect.objectContaining({
        with_context: expect.objectContaining({
          count: 1,
          success_rate: 100,
          avg_total_tokens: 1500,
        }),
        without_context: expect.objectContaining({
          count: 1,
          success_rate: 0,
          avg_retry_count: 2,
        }),
        delta: expect.objectContaining({
          comparison_available: true,
          success_rate_points: 100,
          total_tokens_delta: -1000,
        }),
      }),
      review_outcomes: expect.objectContaining({
        with_context_source: expect.objectContaining({
          count: 1,
          flag_rate: 100,
          avg_issue_count: 2,
        }),
      }),
      recommendation: expect.objectContaining({
        status: 'insufficient_data',
        settings: null,
      }),
    }));
  });

  it('recommends a permissive policy when study context clearly outperforms the baseline', () => {
    analyticsRows = [
      {
        event_type: 'study_task_completed',
        task_id: 'task-1',
        timestamp: '2026-04-09T10:00:00.000Z',
        data: JSON.stringify({
          working_directory: 'C:/Projects/MyRepo',
          study_context_applied: true,
          status: 'completed',
          retry_count: 0,
          provider_switch_count: 0,
          total_tokens: 1200,
          cost_usd: 0.01,
          files_modified_count: 3,
        }),
      },
      {
        event_type: 'study_task_completed',
        task_id: 'task-2',
        timestamp: '2026-04-09T11:00:00.000Z',
        data: JSON.stringify({
          working_directory: 'C:/Projects/MyRepo',
          study_context_applied: true,
          status: 'completed',
          retry_count: 0,
          provider_switch_count: 0,
          total_tokens: 1300,
          cost_usd: 0.011,
          files_modified_count: 2,
        }),
      },
      {
        event_type: 'study_task_completed',
        task_id: 'task-3',
        timestamp: '2026-04-09T12:00:00.000Z',
        data: JSON.stringify({
          working_directory: 'C:/Projects/MyRepo',
          study_context_applied: false,
          status: 'failed',
          retry_count: 2,
          provider_switch_count: 1,
          total_tokens: 2600,
          cost_usd: 0.024,
          files_modified_count: 1,
        }),
      },
      {
        event_type: 'study_task_completed',
        task_id: 'task-4',
        timestamp: '2026-04-09T12:30:00.000Z',
        data: JSON.stringify({
          working_directory: 'C:/Projects/MyRepo',
          study_context_applied: false,
          status: 'completed',
          retry_count: 1,
          provider_switch_count: 0,
          total_tokens: 2100,
          cost_usd: 0.019,
          files_modified_count: 1,
        }),
      },
    ];

    const summary = telemetry.getStudyImpactSummary({
      workingDirectory: 'C:/Projects/MyRepo',
      sinceDays: 30,
    });

    expect(summary.recommendation).toEqual(expect.objectContaining({
      status: 'favorable',
      confidence: 'medium',
      settings: expect.objectContaining({
        submit_proposals: true,
        proposal_significance_level: 'low',
        proposal_min_score: 8,
      }),
    }));
  });
});
