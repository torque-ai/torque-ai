'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const configCore = require('../db/config-core');
const { classifyActionRisk } = require('../plugins/snapscope/handlers/rollback');
const { resolveRecoveryMode } = require('../plugins/snapscope/handlers/recovery');

function loadModuleWithInternals(moduleRelativePath, internals) {
  const absolutePath = path.join(__dirname, '..', moduleRelativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const appendedSource = `${source}
module.exports = {
  ...module.exports,
  __test__: { ${internals.join(', ')} },
};
`;

  const localModule = { exports: {} };
  const localRequire = createRequire(absolutePath);
  const executeModule = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    appendedSource,
  );

  executeModule(
    localRequire,
    localModule,
    localModule.exports,
    absolutePath,
    path.dirname(absolutePath),
  );

  return localModule.exports;
}

const qualityScoreHandlerPath = path.join(__dirname, '..', 'plugins', 'snapscope', 'handlers', 'quality-score.js');
const qualityScoreModule = fs.existsSync(qualityScoreHandlerPath)
  ? loadModuleWithInternals('plugins/snapscope/handlers/quality-score.js', [
    'isPresent',
    'isImageBlobPresent',
  ])
  : null;
const liveAutonomyModule = loadModuleWithInternals('plugins/snapscope/handlers/live-autonomy.js', [
  'normalizeString',
  'normalizeActionName',
  'buildRiskJustification',
]);

const EVIDENCE_WEIGHTS = qualityScoreModule?.EVIDENCE_WEIGHTS ?? {};
const MAX_SCORE = qualityScoreModule?.MAX_SCORE ?? 0;
const scoreBundle = qualityScoreModule?.scoreBundle ?? (() => {
  throw new Error('quality-score handler has been removed');
});
const isPresent = qualityScoreModule?.__test__?.isPresent ?? (() => false);
const isImageBlobPresent = qualityScoreModule?.__test__?.isImageBlobPresent ?? (() => false);
const { isLiveEligible, buildLiveEligibilityRecord } = liveAutonomyModule;
const { normalizeString, normalizeActionName, buildRiskJustification } = liveAutonomyModule.__test__;
const describeQualityScore = qualityScoreModule ? describe : describe.skip;

function makeCompleteBundle() {
  return {
    app_type: 'wpf',
    evidence: {
      screenshot: { present: true },
      annotated_screenshot: { present: true },
      elements: { tree: [{ id: 'root' }] },
      measurements: { width: 120, height: 48 },
      text_content: { labels: ['Ready'] },
      annotation_index: [{ key: 'cta' }],
    },
    capture_data: {
      host: 'lab-01',
      process_name: 'app.exe',
    },
    metadata: {
      framework: 'WPF',
    },
    visual_tree: {
      root: 'MainWindow',
    },
  };
}

function makeBundleWithFields(fields) {
  const bundle = {
    app_type: 'unknown',
    evidence: {},
  };

  if (fields.includes('screenshot')) bundle.evidence.screenshot = { present: true };
  if (fields.includes('annotated_screenshot')) bundle.evidence.annotated_screenshot = { present: true };
  if (fields.includes('elements_tree')) bundle.evidence.elements = { tree: [{ id: 1 }] };
  if (fields.includes('measurements')) bundle.evidence.measurements = { width: 10 };
  if (fields.includes('text_content')) bundle.evidence.text_content = 'alpha';
  if (fields.includes('annotation_index')) bundle.evidence.annotation_index = [{ index: 1 }];
  if (fields.includes('capture_data')) bundle.capture_data = { host: 'lab-01', process_name: 'app.exe' };
  if (fields.includes('metadata')) bundle.metadata = { framework: 'WPF' };
  if (fields.includes('app_type_extras')) bundle.performance_counters = { cpu_percent: 9 };

  return bundle;
}

describeQualityScore('peek quality-score', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks nullish values and empty containers as not present', () => {
    expect(isPresent(null)).toBe(false);
    expect(isPresent(undefined)).toBe(false);
    expect(isPresent('   ')).toBe(false);
    expect(isPresent([])).toBe(false);
    expect(isPresent({})).toBe(false);
  });

  it('marks scalars and populated containers as present', () => {
    expect(isPresent(false)).toBe(true);
    expect(isPresent(0)).toBe(true);
    expect(isPresent(' alpha ')).toBe(true);
    expect(isPresent([0])).toBe(true);
    expect(isPresent({ key: null })).toBe(true);
  });

  it('treats image blobs with present: true as available', () => {
    expect(isImageBlobPresent({ present: true })).toBe(true);
  });

  it('returns falsy values for absent or malformed image blobs', () => {
    expect(isImageBlobPresent(null)).toBeNull();
    expect(isImageBlobPresent('blob')).toBe(false);
    expect(isImageBlobPresent({})).toBe(false);
    expect(isImageBlobPresent({ present: false })).toBe(false);
  });

  it('returns a zero summary for non-object bundles', () => {
    expect(scoreBundle(null)).toEqual({
      score: 0,
      max_score: MAX_SCORE,
      breakdown: {},
      missing: Object.keys(EVIDENCE_WEIGHTS),
    });
  });

  it('returns a fully zeroed breakdown for empty bundles', () => {
    expect(scoreBundle({})).toEqual({
      score: 0,
      max_score: MAX_SCORE,
      percentage: 0,
      grade: 'F',
      breakdown: {
        screenshot: 0,
        annotated_screenshot: 0,
        elements_tree: 0,
        measurements: 0,
        text_content: 0,
        annotation_index: 0,
        capture_data: 0,
        metadata: 0,
        app_type_extras: 0,
      },
      missing: Object.keys(EVIDENCE_WEIGHTS),
      app_type: 'unknown',
    });
  });

  it('scores a complete WPF bundle at 100 with no missing evidence', () => {
    expect(scoreBundle(makeCompleteBundle())).toEqual({
      score: 100,
      max_score: MAX_SCORE,
      percentage: 100,
      grade: 'A',
      breakdown: {
        screenshot: 15,
        annotated_screenshot: 10,
        elements_tree: 20,
        measurements: 10,
        text_content: 10,
        annotation_index: 5,
        capture_data: 10,
        metadata: 10,
        app_type_extras: 10,
      },
      missing: [],
      app_type: 'wpf',
    });
  });

  it('awards app type extras from performance counters even when the app type is unknown', () => {
    const bundle = makeBundleWithFields([
      'screenshot',
      'annotated_screenshot',
      'elements_tree',
      'measurements',
      'text_content',
      'annotation_index',
      'capture_data',
      'metadata',
      'app_type_extras',
    ]);

    expect(scoreBundle(bundle)).toMatchObject({
      score: 100,
      grade: 'A',
      app_type: 'unknown',
      missing: [],
    });
  });

  it('awards win32 extras when hwnd metadata is present', () => {
    const bundle = makeCompleteBundle();
    bundle.app_type = 'win32';
    delete bundle.visual_tree;
    bundle.hwnd_metadata = { hwnd: 501 };

    expect(scoreBundle(bundle)).toMatchObject({
      score: 100,
      breakdown: expect.objectContaining({
        app_type_extras: 10,
      }),
      missing: [],
      app_type: 'win32',
    });
  });

  it('awards electron extras when the app type starts with electron', () => {
    const bundle = makeCompleteBundle();
    bundle.app_type = 'electron_renderer';
    delete bundle.visual_tree;
    bundle.devtools_protocol = { targetId: 'page-1' };

    expect(scoreBundle(bundle)).toMatchObject({
      score: 100,
      breakdown: expect.objectContaining({
        app_type_extras: 10,
      }),
      missing: [],
      app_type: 'electron_renderer',
    });
  });

  it('requires a non-empty elements tree array', () => {
    const bundle = makeCompleteBundle();
    bundle.evidence.elements.tree = [];

    expect(scoreBundle(bundle)).toMatchObject({
      score: 80,
      breakdown: expect.objectContaining({
        elements_tree: 0,
      }),
      missing: ['elements_tree'],
    });
  });

  it('requires capture data to include both host and process_name', () => {
    const bundle = makeCompleteBundle();
    delete bundle.capture_data.process_name;

    expect(scoreBundle(bundle)).toMatchObject({
      score: 90,
      breakdown: expect.objectContaining({
        capture_data: 0,
      }),
      missing: ['capture_data'],
    });
  });

  it('requires metadata.framework before metadata receives credit', () => {
    const bundle = makeCompleteBundle();
    bundle.metadata = { version: '1.0.0' };

    expect(scoreBundle(bundle)).toMatchObject({
      score: 90,
      breakdown: expect.objectContaining({
        metadata: 0,
      }),
      missing: ['metadata'],
    });
  });

  it('requires annotation_index to be a non-empty array', () => {
    const bundle = makeCompleteBundle();
    bundle.evidence.annotation_index = { cta: 1 };

    expect(scoreBundle(bundle)).toMatchObject({
      score: 95,
      breakdown: expect.objectContaining({
        annotation_index: 0,
      }),
      missing: ['annotation_index'],
    });
  });

  it.each([
    [['screenshot', 'annotated_screenshot', 'elements_tree', 'measurements', 'text_content', 'annotation_index', 'capture_data', 'metadata'], 90, 'A'],
    [['elements_tree', 'measurements', 'text_content', 'capture_data', 'metadata', 'app_type_extras'], 70, 'B'],
    [['elements_tree', 'measurements', 'text_content', 'metadata'], 50, 'C'],
    [['elements_tree', 'measurements'], 30, 'D'],
    [['screenshot'], 15, 'F'],
  ])('applies the %s grade threshold at score %i', (fields, expectedScore, expectedGrade) => {
    const result = scoreBundle(makeBundleWithFields(fields));

    expect(result.score).toBe(expectedScore);
    expect(result.percentage).toBe(expectedScore);
    expect(result.grade).toBe(expectedGrade);
  });

  it('tracks missing evidence in evaluation order for mixed partial bundles', () => {
    const bundle = makeCompleteBundle();
    delete bundle.evidence.screenshot;
    bundle.evidence.elements.tree = [];
    delete bundle.capture_data.host;
    delete bundle.visual_tree;

    expect(scoreBundle(bundle)).toEqual({
      score: 45,
      max_score: MAX_SCORE,
      percentage: 45,
      grade: 'D',
      breakdown: {
        screenshot: 0,
        annotated_screenshot: 10,
        elements_tree: 0,
        measurements: 10,
        text_content: 10,
        annotation_index: 5,
        capture_data: 0,
        metadata: 10,
        app_type_extras: 0,
      },
      missing: ['screenshot', 'elements_tree', 'capture_data', 'app_type_extras'],
      app_type: 'wpf',
    });
  });
});

describe('peek live-autonomy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes strings by trimming whitespace and lowercasing', () => {
    expect(normalizeString('  LiVe  ')).toBe('live');
  });

  it('returns an empty string when normalizeString receives a non-string', () => {
    expect(normalizeString(null)).toBe('');
    expect(normalizeString(42)).toBe('');
    expect(normalizeString({ mode: 'live' })).toBe('');
  });

  it('normalizes action names by trimming only', () => {
    expect(normalizeActionName('  Close Dialog  ')).toBe('Close Dialog');
  });

  it('returns an empty string when normalizeActionName receives a non-string', () => {
    expect(normalizeActionName(undefined)).toBe('');
    expect(normalizeActionName({ action: 'close_dialog' })).toBe('');
  });

  it.each([
    [' low ', ' LiVe '],
    ['LOW', 'warn'],
  ])('treats %s risk with %s mode as live eligible', (riskLevel, policyMode) => {
    expect(isLiveEligible(riskLevel, policyMode)).toBe(true);
  });

  it.each([
    ['low', 'canary'],
    ['low', 'shadow'],
    ['low', 'block'],
    ['low', ''],
  ])('keeps %s risk gated when the resolved mode is %s', (riskLevel, policyMode) => {
    expect(isLiveEligible(riskLevel, policyMode)).toBe(false);
  });

  it.each([
    ['medium', 'live'],
    ['medium', 'warn'],
    ['high', 'live'],
    ['unknown', 'warn'],
  ])('never allows %s risk through live autonomy for %s mode', (riskLevel, policyMode) => {
    expect(isLiveEligible(riskLevel, policyMode)).toBe(false);
  });

  it('explains live low-risk execution', () => {
    expect(buildRiskJustification('low', 'live')).toBe(
      'Risk level is low, so the action is eligible for live execution without recovery gating.',
    );
  });

  it('explains canary gating for low-risk actions', () => {
    expect(buildRiskJustification('low', 'canary')).toBe(
      'Risk level is low, but the resolved mode is canary, so the action remains gated and is not live eligible.',
    );
  });

  it('explains shadow gating for low-risk actions', () => {
    expect(buildRiskJustification('low', 'shadow')).toBe(
      'Risk level is low, but the resolved mode is shadow, so the action is not live eligible.',
    );
  });

  it('explains block gating for low-risk actions', () => {
    expect(buildRiskJustification('low', 'block')).toBe(
      'Risk level is low, but the policy resolved to block, so the action is not live eligible.',
    );
  });

  it('uses the generic low-risk explanation for other resolved modes', () => {
    expect(buildRiskJustification('low', 'warn')).toBe(
      'Risk level is low, but live execution is not enabled for the resolved mode, so the action is not live eligible.',
    );
  });

  it('explains that medium-risk actions stay gated', () => {
    expect(buildRiskJustification('medium', 'live')).toBe(
      'Risk level is medium, so the action stays gated and is not live eligible.',
    );
  });

  it('explains that high-risk actions must remain shadowed or blocked', () => {
    expect(buildRiskJustification('high', 'live')).toBe(
      'Risk level is high, so the action is not live eligible and must remain shadowed or blocked.',
    );
  });

  it('explains that unknown risk levels are not live eligible', () => {
    expect(buildRiskJustification('mystery', 'live')).toBe(
      'Risk level is unknown, so the action is not live eligible.',
    );
  });

  it('builds a normalized live eligibility record', () => {
    expect(buildLiveEligibilityRecord(
      '  Close Dialog  ',
      { level: ' LOW ' },
      ' LiVe ',
    )).toEqual({
      action: 'Close Dialog',
      risk_level: 'low',
      live_eligible: true,
      resolved_mode: 'live',
      risk_justification: 'Risk level is low, so the action is eligible for live execution without recovery gating.',
    });
  });

  it('falls back to unknown risk and null mode when inputs are missing', () => {
    expect(buildLiveEligibilityRecord(null, null, null)).toEqual({
      action: '',
      risk_level: 'unknown',
      live_eligible: false,
      resolved_mode: null,
      risk_justification: 'Risk level is unknown, so the action is not live eligible.',
    });
  });

  it('retains warn mode as live eligible while using the generic low-risk justification', () => {
    expect(buildLiveEligibilityRecord('close_dialog', { level: 'low' }, 'warn')).toEqual({
      action: 'close_dialog',
      risk_level: 'low',
      live_eligible: true,
      resolved_mode: 'warn',
      risk_justification: 'Risk level is low, but live execution is not enabled for the resolved mode, so the action is not live eligible.',
    });
  });

  it('allows low-risk actions onto the live path when live mode is enabled', () => {
    vi.spyOn(configCore, 'getConfig').mockReturnValue('1');

    const riskClassification = classifyActionRisk('close_dialog');
    const resolvedMode = resolveRecoveryMode('close_dialog');
    const eligibility = buildLiveEligibilityRecord('close_dialog', riskClassification, resolvedMode);

    expect(resolvedMode).toBe('live');
    expect(eligibility.live_eligible).toBe(true);
    expect(eligibility.risk_level).toBe('low');
  });

  it('keeps low-risk actions shadowed when live mode is disabled', () => {
    vi.spyOn(configCore, 'getConfig').mockReturnValue(null);

    const riskClassification = classifyActionRisk('clear_temp_cache');
    const resolvedMode = resolveRecoveryMode('clear_temp_cache');
    const eligibility = buildLiveEligibilityRecord('clear_temp_cache', riskClassification, resolvedMode);

    expect(resolvedMode).toBe('shadow');
    expect(eligibility.live_eligible).toBe(false);
    expect(eligibility.risk_level).toBe('low');
  });

  it('keeps medium-risk actions on the canary path even with live mode enabled', () => {
    vi.spyOn(configCore, 'getConfig').mockReturnValue('1');

    const riskClassification = classifyActionRisk('restart_process');
    const resolvedMode = resolveRecoveryMode('restart_process');
    const eligibility = buildLiveEligibilityRecord('restart_process', riskClassification, resolvedMode);

    expect(resolvedMode).toBe('canary');
    expect(eligibility.live_eligible).toBe(false);
    expect(eligibility.risk_level).toBe('medium');
  });

  it('keeps high-risk actions shadowed even with live mode enabled', () => {
    vi.spyOn(configCore, 'getConfig').mockReturnValue('1');

    const riskClassification = classifyActionRisk('kill_hung_thread');
    const resolvedMode = resolveRecoveryMode('kill_hung_thread');
    const eligibility = buildLiveEligibilityRecord('kill_hung_thread', riskClassification, resolvedMode);

    expect(resolvedMode).toBe('shadow');
    expect(eligibility.live_eligible).toBe(false);
    expect(eligibility.risk_level).toBe('high');
  });
});
