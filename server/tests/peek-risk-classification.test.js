const {
  RISK_CLASSIFICATION,
  classifyActionRisk,
} = require('../handlers/peek/rollback');

describe('peek rollback risk classification', () => {
  const LOW_EVIDENCE = ['screenshot_before'];
  const MEDIUM_EVIDENCE = ['screenshot_before', 'screenshot_after'];
  const HIGH_EVIDENCE = ['screenshot_before', 'screenshot_after', 'user_confirmation'];

  it('classifies the supported rollback actions with the expected risk evidence', () => {
    const expectations = [
      ['click', 'low', LOW_EVIDENCE],
      ['type', 'low', LOW_EVIDENCE],
      ['scroll', 'low', LOW_EVIDENCE],
      ['focus_window', 'medium', MEDIUM_EVIDENCE],
      ['close_window', 'high', HIGH_EVIDENCE],
      ['send_keys', 'medium', MEDIUM_EVIDENCE],
    ];

    for (const [action, level, requiredEvidence] of expectations) {
      expect(RISK_CLASSIFICATION[action]).toMatchObject({
        level,
        requiredEvidence,
      });
      expect(classifyActionRisk(action)).toEqual({
        level,
        requiredEvidence,
      });
    }
  });

  it('defaults unknown actions to high risk evidence requirements', () => {
    expect(classifyActionRisk('unknown_action')).toEqual({
      level: 'high',
      requiredEvidence: HIGH_EVIDENCE,
    });
  });
});
