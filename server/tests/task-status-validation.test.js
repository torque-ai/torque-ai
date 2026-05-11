'use strict';

const {
  VALID_TASK_STATUS_VALUES,
  validateTaskStatuses,
} = require('../db/schema/status-validation');

describe('task status validation', () => {
  it('accepts every runtime task status used by queue, workflow, and approval paths', () => {
    expect(VALID_TASK_STATUS_VALUES).toEqual(expect.arrayContaining([
      'pending',
      'pending_approval',
      'queued',
      'waiting',
      'running',
      'paused',
      'blocked',
      'retry_scheduled',
      'completed',
      'failed',
      'cancelled',
      'skipped',
    ]));
  });

  it('warns only for statuses outside the shared task vocabulary', () => {
    const rows = [
      { id: 'wait-1', status: 'waiting' },
      { id: 'approval-1', status: 'pending_approval' },
      { id: 'paused-1', status: 'paused' },
      { id: 'bad-1', status: 'mystery' },
    ];
    const logger = { warn: vi.fn() };
    const db = {
      prepare: vi.fn(() => ({
        all: (...validStatuses) => rows.filter((row) => !validStatuses.includes(row.status)),
      })),
    };

    const invalid = validateTaskStatuses(db, logger);

    expect(invalid).toEqual([{ id: 'bad-1', status: 'mystery' }]);
    expect(logger.warn).toHaveBeenCalledWith('[DB] Found 1 task(s) with invalid status values');
  });
});
