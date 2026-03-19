'use strict';

class BenchmarkHarness {
  constructor() {
    this.results = [];
  }

  record(result) {
    this.results.push({ ...result, timestamp: new Date().toISOString() });
  }

  summarize() {
    const llm = this.results.filter((r) => r.source === 'llm');
    const fallback = this.results.filter((r) => r.source === 'deterministic');
    const avg = (arr, key) => (arr.length === 0 ? 0 : arr.reduce((s, r) => s + (r[key] || 0), 0) / arr.length);
    const sum = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0);
    return {
      total_runs: this.results.length,
      llm_runs: llm.length,
      fallback_runs: fallback.length,
      fallback_rate: this.results.length > 0 ? fallback.length / this.results.length : 0,
      avg_duration_ms: avg(this.results, 'duration_ms'),
      total_tokens: sum(this.results, 'tokens'),
      total_cost: sum(this.results, 'cost'),
      avg_confidence: avg(this.results, 'confidence'),
    };
  }

  toCsv() {
    const fields = ['task_name', 'source', 'duration_ms', 'tokens', 'cost', 'confidence', 'quality_score', 'timestamp'];
    const header = fields.join(',');
    // Escape CSV fields: wrap in double-quotes and escape internal double-quotes.
    const escapeCsv = (v) => {
      const s = v !== undefined && v !== null ? String(v) : '';
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const rows = this.results.map((r) =>
      fields.map((f) => escapeCsv(r[f])).join(',')
    );
    return [header, ...rows].join('\n');
  }
}

module.exports = { BenchmarkHarness };
