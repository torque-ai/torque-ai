const Database = require('better-sqlite3');

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
    const review = {
      task_id: 'task-1',
      review_task_id: 'review-task-1',
      reviewer_provider: 'deepinfra',
      reviewer_model: 'Qwen/Qwen2.5-72B-Instruct',
      verdict: 'concerns',
      confidence: 'medium',
      issues: JSON.stringify([{ file: 'auth.js', line: 42, severity: 'warning', category: 'security', description: 'test', suggestion: 'fix' }]),
      diff_snippet: '--- a/auth.js\n+++ b/auth.js',
      duration_ms: 15000,
    };

    reviews.insertReview(review);

    const results = reviews.getReviewsForTask('task-1');
    expect(results).toHaveLength(1);
    expect(results[0].task_id).toBe(review.task_id);
    expect(results[0].review_task_id).toBe(review.review_task_id);
    expect(results[0].reviewer_provider).toBe(review.reviewer_provider);
    expect(results[0].reviewer_model).toBe(review.reviewer_model);
    expect(results[0].verdict).toBe(review.verdict);
    expect(results[0].confidence).toBe(review.confidence);
    expect(results[0].issues).toBe(review.issues);
    expect(results[0].diff_snippet).toBe(review.diff_snippet);
    expect(results[0].duration_ms).toBe(review.duration_ms);
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
    expect(stats.by_confidence.high).toBe(2);
    expect(stats.by_confidence.medium).toBe(1);
  });

  it('returns empty array for unknown task', () => {
    expect(reviews.getReviewsForTask('no-such-task')).toEqual([]);
  });

  it('returns null for unknown review task', () => {
    expect(reviews.getReviewByReviewTaskId('no-such')).toBeNull();
  });
});
