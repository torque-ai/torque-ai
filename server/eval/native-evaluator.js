'use strict';

function exactMatch(actual, expected) {
  return String(actual ?? '').trim() === String(expected ?? '').trim();
}

function regexMatch(actual, pattern) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
  return regex.test(String(actual ?? ''));
}

function containsAll(actual, expected = []) {
  const text = String(actual ?? '').toLowerCase();
  return expected.every((item) => text.includes(String(item).toLowerCase()));
}

function lengthGte(actual, min) {
  return String(actual ?? '').length >= Number(min || 0);
}

function scoreOutput(output, scorers = []) {
  if (!Array.isArray(scorers) || scorers.length === 0) {
    return { passed: true, score: 1, checks: [] };
  }

  const checks = scorers.map((scorer) => {
    let passed = false;
    if (scorer.type === 'exact') passed = exactMatch(output, scorer.expected);
    else if (scorer.type === 'regex') passed = regexMatch(output, scorer.pattern);
    else if (scorer.type === 'contains_all') passed = containsAll(output, scorer.expected || scorer.items || []);
    else if (scorer.type === 'length_gte') passed = lengthGte(output, scorer.min);
    else passed = false;
    return { ...scorer, passed };
  });

  const passedCount = checks.filter((check) => check.passed).length;
  return {
    passed: passedCount === checks.length,
    score: checks.length ? passedCount / checks.length : 1,
    checks,
  };
}

function diffExperimentRuns(rowsA = [], rowsB = []) {
  const avg = (rows) => {
    const values = rows.map((row) => Number(row.score ?? row.score_value ?? 0)).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  };
  const a = avg(rowsA);
  const b = avg(rowsB);
  return {
    baseline_avg: a,
    candidate_avg: b,
    delta: b - a,
    winner: b > a ? 'candidate' : a > b ? 'baseline' : 'tie',
  };
}

module.exports = {
  exactMatch,
  regexMatch,
  containsAll,
  lengthGte,
  scoreOutput,
  diffExperimentRuns,
};
