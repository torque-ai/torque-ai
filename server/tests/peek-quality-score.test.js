'use strict';

const {
  ELECTRON_FIXTURE,
  QT_FIXTURE,
  WIN32_FIXTURE,
  WINFORMS_FIXTURE,
  WPF_FIXTURE,
} = require('../contracts/peek-fixtures');
const { EVIDENCE_WEIGHTS, MAX_SCORE, scoreBundle } = require('../handlers/peek/quality-score');

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeBundleWithFields(fields) {
  const bundle = {
    app_type: 'unknown',
    evidence: {},
  };

  if (fields.includes('screenshot')) bundle.evidence.screenshot = { present: true };
  if (fields.includes('annotated_screenshot')) bundle.evidence.annotated_screenshot = { present: true };
  if (fields.includes('elements_tree')) bundle.evidence.elements = { tree: [{ id: 1 }] };
  if (fields.includes('measurements')) bundle.evidence.measurements = { box: true };
  if (fields.includes('text_content')) bundle.evidence.text_content = { labels: ['alpha'] };
  if (fields.includes('annotation_index')) bundle.evidence.annotation_index = [{ index: 1 }];
  if (fields.includes('capture_data')) bundle.capture_data = { host: 'lab-01', process_name: 'app.exe' };
  if (fields.includes('metadata')) bundle.metadata = { framework: 'WPF' };

  return bundle;
}

describe('peek quality scoring', () => {
  it('returns 100% for a complete WPF fixture', () => {
    expect(scoreBundle(WPF_FIXTURE)).toMatchObject({
      score: 100,
      max_score: 100,
      percentage: 100,
      grade: 'A',
      app_type: 'wpf',
      missing: [],
    });
  });

  it('returns 100% for a complete Win32 fixture', () => {
    expect(scoreBundle(WIN32_FIXTURE)).toMatchObject({
      score: 100,
      max_score: 100,
      percentage: 100,
      grade: 'A',
      app_type: 'win32',
      missing: [],
    });
  });

  it('returns 100% for a complete Electron fixture', () => {
    expect(scoreBundle(ELECTRON_FIXTURE)).toMatchObject({
      score: 100,
      max_score: 100,
      percentage: 100,
      grade: 'A',
      app_type: 'electron_webview',
      missing: [],
    });
  });

  it.each([
    ['wpf', WPF_FIXTURE],
    ['win32', WIN32_FIXTURE],
    ['electron_webview', ELECTRON_FIXTURE],
    ['winforms', WINFORMS_FIXTURE],
    ['qt', QT_FIXTURE],
  ])('scores all evidence categories for %s fixtures', (_appType, fixture) => {
    expect(scoreBundle(fixture)).toMatchObject({
      score: 100,
      max_score: 100,
      percentage: 100,
      grade: 'A',
      missing: [],
    });
  });

  it('returns 0 for null input', () => {
    expect(scoreBundle(null)).toEqual({
      score: 0,
      max_score: 100,
      breakdown: {},
      missing: Object.keys(EVIDENCE_WEIGHTS),
    });
  });

  it('returns 0 for empty input', () => {
    expect(scoreBundle({})).toMatchObject({
      score: 0,
      max_score: 100,
      percentage: 0,
      grade: 'F',
      app_type: 'unknown',
      missing: Object.keys(EVIDENCE_WEIGHTS),
    });
  });

  it('reports missing fields correctly', () => {
    const bundle = cloneValue(WPF_FIXTURE);
    delete bundle.evidence.screenshot;
    bundle.evidence.elements.tree = [];
    delete bundle.capture_data.host;
    delete bundle.visual_tree;
    delete bundle.performance_counters;

    expect(scoreBundle(bundle)).toMatchObject({
      score: 45,
      percentage: 45,
      grade: 'D',
      missing: ['screenshot', 'elements_tree', 'capture_data', 'app_type_extras'],
    });
  });

  it.each([
    [['screenshot', 'annotated_screenshot', 'elements_tree', 'measurements', 'text_content', 'annotation_index', 'capture_data', 'metadata'], 90, 'A'],
    [['screenshot', 'annotated_screenshot', 'elements_tree', 'measurements', 'text_content', 'annotation_index', 'capture_data'], 80, 'B'],
    [['screenshot', 'annotated_screenshot', 'elements_tree', 'annotation_index'], 50, 'C'],
    [['elements_tree', 'measurements'], 30, 'D'],
    [['screenshot'], 15, 'F'],
  ])('applies the grade threshold for score %i', (fields, expectedScore, grade) => {
    const result = scoreBundle(makeBundleWithFields(fields));
    expect(result.score).toBe(expectedScore);
    expect(result.grade).toBe(grade);
  });

  it('scores a partial bundle correctly', () => {
    const screenshotOnly = {
      evidence: {
        screenshot: {
          present: true,
        },
      },
    };

    expect(scoreBundle(screenshotOnly)).toMatchObject({
      score: 15,
      max_score: 100,
      percentage: 15,
      grade: 'F',
      app_type: 'unknown',
    });
  });

  it('exposes frozen evidence weights', () => {
    expect(Object.isFrozen(EVIDENCE_WEIGHTS)).toBe(true);
  });

  it('computes MAX_SCORE as the sum of all evidence weights', () => {
    const summedWeights = Object.values(EVIDENCE_WEIGHTS).reduce((total, weight) => total + weight, 0);
    expect(MAX_SCORE).toBe(100);
    expect(MAX_SCORE).toBe(summedWeights);
  });
});
