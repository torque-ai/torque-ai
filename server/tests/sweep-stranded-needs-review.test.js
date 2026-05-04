'use strict';
const Database = require('better-sqlite3');
const factoryIntake = require('../db/factory-intake');
const {
  sweepStrandedNeedsReviewForProject,
  isTargetedReason,
} = require('../factory/sweep-stranded-needs-review');

function seedSchema(db) {
  db.prepare(`CREATE TABLE factory_work_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    source TEXT NOT NULL,
    origin_json TEXT,
    title TEXT NOT NULL,
    description TEXT,
    priority INTEGER NOT NULL DEFAULT 50,
    requestor TEXT,
    constraints_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reject_reason TEXT,
    linked_item_id INTEGER,
    batch_id TEXT,
    claimed_by_instance_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

function insertWi(db, { id, title, status, reject_reason, project_id = 'p1' }) {
  db.prepare(`INSERT INTO factory_work_items (id, project_id, source, title, description, priority, status, reject_reason)
              VALUES (?, ?, 'manual', ?, ?, 50, ?, ?)`)
    .run(id, project_id, title, title, status, reject_reason);
}

describe('isTargetedReason', () => {
  it('matches zero_diff_across_retries exactly', () => {
    expect(isTargetedReason('zero_diff_across_retries')).toBe(true);
  });
  it('matches with surrounding whitespace', () => {
    expect(isTargetedReason('  zero_diff_across_retries  ')).toBe(true);
  });
  it('does not match other reject reasons', () => {
    expect(isTargetedReason('plan_quality_exhausted_after_5_attempts')).toBe(false);
    expect(isTargetedReason('worktree_creation_failed: EBUSY')).toBe(false);
    expect(isTargetedReason(null)).toBe(false);
    expect(isTargetedReason('')).toBe(false);
  });
});

describe('sweepStrandedNeedsReviewForProject', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    seedSchema(db);
    factoryIntake.setDb(db);
  });

  it('does nothing when no needs_review WIs exist', () => {
    const summary = sweepStrandedNeedsReviewForProject(
      { id: 'p1', path: '/repo' },
      {
        detectorFactory: () => ({ detectShipped: () => ({ shipped: false, confidence: 'low' }) }),
      },
    );
    expect(summary).toEqual({ scanned: 0, auto_shipped: 0, auto_replanned: 0, errors: 0 });
  });

  it('does NOT touch needs_review WIs with non-targeted reject reasons', () => {
    insertWi(db, { id: 1, title: 'A', status: 'needs_review', reject_reason: 'plan_quality_exhausted_after_5_attempts' });
    insertWi(db, { id: 2, title: 'B', status: 'needs_review', reject_reason: null });

    const detectorFactory = () => ({ detectShipped: () => ({ shipped: true, confidence: 'high' }) });
    const summary = sweepStrandedNeedsReviewForProject({ id: 'p1', path: '/repo' }, { detectorFactory });

    expect(summary.scanned).toBe(0);
    expect(factoryIntake.getWorkItem(1).status).toBe('needs_review');
    expect(factoryIntake.getWorkItem(2).status).toBe('needs_review');
  });

  it('transitions matched zero_diff WI to shipped_stale on high-confidence detector match', () => {
    insertWi(db, { id: 10, title: 'Document foo bar baz', status: 'needs_review', reject_reason: 'zero_diff_across_retries' });

    const detectorFactory = () => ({
      detectShipped: ({ title }) => ({
        shipped: true,
        confidence: 'high',
        signals: { matched_subject: `docs: ${title}` },
      }),
    });
    const decisions = [];
    const summary = sweepStrandedNeedsReviewForProject(
      { id: 'p1', path: '/repo' },
      {
        detectorFactory,
        safeLogDecision: (d) => decisions.push(d),
      },
    );

    expect(summary).toEqual({ scanned: 1, auto_shipped: 1, auto_replanned: 0, errors: 0 });
    const wi = factoryIntake.getWorkItem(10);
    expect(wi.status).toBe('shipped_stale');
    expect(wi.reject_reason).toMatch(/auto_resolved_post_zero_diff_fix/);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('auto_resolved_stranded_needs_review_shipped');
  });

  it('transitions unmatched zero_diff WI to needs_replan when detector says low/none', () => {
    insertWi(db, { id: 20, title: 'Add CI security checks', status: 'needs_review', reject_reason: 'zero_diff_across_retries' });

    const detectorFactory = () => ({
      detectShipped: () => ({ shipped: false, confidence: 'low' }),
    });
    const decisions = [];
    const summary = sweepStrandedNeedsReviewForProject(
      { id: 'p1', path: '/repo' },
      {
        detectorFactory,
        safeLogDecision: (d) => decisions.push(d),
      },
    );

    expect(summary).toEqual({ scanned: 1, auto_shipped: 0, auto_replanned: 1, errors: 0 });
    const wi = factoryIntake.getWorkItem(20);
    expect(wi.status).toBe('needs_replan');
    expect(wi.reject_reason).toMatch(/auto_replan_post_zero_diff_fix/);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('auto_resolved_stranded_needs_review_replan');
  });

  it('treats low-confidence shipped result as no-match (route to needs_replan)', () => {
    insertWi(db, { id: 30, title: 'X', status: 'needs_review', reject_reason: 'zero_diff_across_retries' });
    const detectorFactory = () => ({
      detectShipped: () => ({ shipped: true, confidence: 'low' }),
    });
    const summary = sweepStrandedNeedsReviewForProject({ id: 'p1', path: '/repo' }, { detectorFactory });
    expect(summary.auto_shipped).toBe(0);
    expect(summary.auto_replanned).toBe(1);
    expect(factoryIntake.getWorkItem(30).status).toBe('needs_replan');
  });

  it('handles a mixed batch — shipped + replan + skip — in one pass', () => {
    insertWi(db, { id: 100, title: 'Match me', status: 'needs_review', reject_reason: 'zero_diff_across_retries' });
    insertWi(db, { id: 101, title: 'No match', status: 'needs_review', reject_reason: 'zero_diff_across_retries' });
    insertWi(db, { id: 102, title: 'Different reject', status: 'needs_review', reject_reason: 'execute_exception' });
    insertWi(db, { id: 103, title: 'Already shipped', status: 'shipped', reject_reason: 'zero_diff_across_retries' });

    const detectorFactory = () => ({
      detectShipped: ({ title }) => title === 'Match me'
        ? { shipped: true, confidence: 'medium' }
        : { shipped: false, confidence: 'none' },
    });
    const summary = sweepStrandedNeedsReviewForProject({ id: 'p1', path: '/repo' }, { detectorFactory });

    expect(summary).toEqual({ scanned: 2, auto_shipped: 1, auto_replanned: 1, errors: 0 });
    expect(factoryIntake.getWorkItem(100).status).toBe('shipped_stale');
    expect(factoryIntake.getWorkItem(101).status).toBe('needs_replan');
    expect(factoryIntake.getWorkItem(102).status).toBe('needs_review');  // untouched
    expect(factoryIntake.getWorkItem(103).status).toBe('shipped');         // untouched
  });

  it('counts errors but continues when detector throws on one item', () => {
    insertWi(db, { id: 200, title: 'Throw', status: 'needs_review', reject_reason: 'zero_diff_across_retries' });
    insertWi(db, { id: 201, title: 'OK', status: 'needs_review', reject_reason: 'zero_diff_across_retries' });

    let calls = 0;
    const detectorFactory = () => ({
      detectShipped: ({ title }) => {
        calls += 1;
        if (title === 'Throw') throw new Error('detector boom');
        return { shipped: false, confidence: 'low' };
      },
    });
    const summary = sweepStrandedNeedsReviewForProject({ id: 'p1', path: '/repo' }, { detectorFactory });
    expect(summary.scanned).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.auto_replanned).toBe(1);  // the OK one still got processed
    expect(calls).toBe(2);
    expect(factoryIntake.getWorkItem(200).status).toBe('needs_review');  // unchanged on error
    expect(factoryIntake.getWorkItem(201).status).toBe('needs_replan');
  });

  it('returns early without errors when detector init throws', () => {
    insertWi(db, { id: 300, title: 'X', status: 'needs_review', reject_reason: 'zero_diff_across_retries' });
    const detectorFactory = () => { throw new Error('init boom'); };
    const summary = sweepStrandedNeedsReviewForProject({ id: 'p1', path: '/repo' }, { detectorFactory });
    expect(summary.scanned).toBe(1);
    expect(summary.errors).toBe(1);
    expect(factoryIntake.getWorkItem(300).status).toBe('needs_review');
  });
});
