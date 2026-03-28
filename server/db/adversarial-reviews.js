'use strict';

function createAdversarialReviews({ db }) {
  function insertReview(review) {
    const now = new Date().toISOString();
    const issues = typeof review.issues === 'string' ? review.issues : JSON.stringify(review.issues || []);
    db.prepare(`
      INSERT INTO adversarial_reviews (task_id, review_task_id, reviewer_provider, reviewer_model, verdict, confidence, issues, diff_snippet, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      review.task_id,
      review.review_task_id || null,
      review.reviewer_provider,
      review.reviewer_model || null,
      review.verdict || null,
      review.confidence || null,
      issues,
      review.diff_snippet || null,
      review.duration_ms || null,
      now,
    );
  }

  function getReviewsForTask(taskId) {
    return db.prepare('SELECT * FROM adversarial_reviews WHERE task_id = ? ORDER BY created_at DESC').all(taskId);
  }

  function getReviewByReviewTaskId(reviewTaskId) {
    return db.prepare('SELECT * FROM adversarial_reviews WHERE review_task_id = ?').get(reviewTaskId) || null;
  }

  function getReviewStats(since) {
    const params = [];
    let sql = 'SELECT verdict, confidence, COUNT(*) as cnt FROM adversarial_reviews';
    const sinceValue = since instanceof Date ? since.toISOString() : since;
    if (since) {
      sql += ' WHERE created_at >= ?';
      params.push(sinceValue);
    }
    sql += ' GROUP BY verdict, confidence';
    const rows = db.prepare(sql).all(...params);

    const stats = {
      total: 0,
      by_verdict: {
        approve: 0,
        reject: 0,
        concerns: 0,
      },
      by_confidence: {},
    };
    for (const row of rows) {
      stats.total += row.cnt;
      if (Object.prototype.hasOwnProperty.call(stats.by_verdict, row.verdict)) {
        stats.by_verdict[row.verdict] += row.cnt;
      }
      if (row.confidence) {
        stats.by_confidence[row.confidence] = (stats.by_confidence[row.confidence] || 0) + row.cnt;
      }
    }

    return stats;
  }

  return { insertReview, getReviewsForTask, getReviewByReviewTaskId, getReviewStats };
}

module.exports = { createAdversarialReviews };
