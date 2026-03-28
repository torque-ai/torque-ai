const Database = require('better-sqlite3');
const { describe, it, expect, beforeEach } = require('vitest');

describe('adversarial-reviews', () => {
  let db;
  let reviews;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE adversarial_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        review_task_id TEXT,
        reviewer_provider TEXT NOT NULL,
        reviewer_model TEXT,
        verdict TEXT,
        confidence TEXT,
        issues TEXT,
        diff_snippet TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX idx_adv_reviews_task ON adversarial_reviews(task_id)');

    const { createAdversarialReviews } = require('../db/adversarial-reviews');
    reviews = createAdversarialReviews({ db });
  });

  it('inserts and retrieves a review', () => {
    reviews.insertReview({
      task_id: 'task-1',
      review_task_id: 'review-task-1',
      reviewer_provider: 'deepinfra',
      reviewer_model: 'Qwen/Qwen2.5-72B-Instruct',
      verdict: 'concerns',
      confidence: 'medium',
      issues: JSON.stringify([{ file: 'auth.js', line: 42, severity: 'warning', category: 'security', description: 'test', suggestion: 'fix' }]),
      diff_snippet: '--- a/auth.js\n+++ b/auth.js',
      duration_ms: 15000,
    });

    const results = reviews.getReviewsForTask('task-1');
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('concerns');
    expect(results[0].reviewer_provider).toBe('deepinfra');
  });

  it('getReviewByReviewTaskId finds by spawned task ID', () => {
    reviews.insertReview({
      task_id: 'task-1',
      review_task_id: 'review-task-1',
      reviewer_provider: 'codex',
      verdict: 'approve',
      confidence: 'high',
      issues: '[]',
    });

    const result = reviews.getReviewByReviewTaskId('review-task-1');
    expect(result).toBeTruthy();
    expect(result.task_id).toBe('task-1');
  });

  it('getReviewStats aggregates verdicts', () => {
    reviews.insertReview({ task_id: 't1', reviewer_provider: 'deepinfra', verdict: 'approve', confidence: 'high', issues: '[]' });
    reviews.insertReview({ task_id: 't2', reviewer_provider: 'codex', verdict: 'reject', confidence: 'high', issues: '[]' });
    reviews.insertReview({ task_id: 't3', reviewer_provider: 'deepinfra', verdict: 'concerns', confidence: 'medium', issues: '[]' });

    const stats = reviews.getReviewStats();
    expect(stats.total).toBe(3);
    expect(stats.by_verdict.approve).toBe(1);
    expect(stats.by_verdict.reject).toBe(1);
    expect(stats.by_verdict.concerns).toBe(1);
  });

  it('returns empty array for unknown task', () => {
    expect(reviews.getReviewsForTask('no-such-task')).toEqual([]);
  });

  it('returns null for unknown review task', () => {
    expect(reviews.getReviewByReviewTaskId('no-such')).toBeNull();
  });
});
