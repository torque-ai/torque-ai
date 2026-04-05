import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { deduplicateFindings, buildFindingSignature } = require('../plugins/snapscope/sweep-dedup');

describe('buildFindingSignature', () => {
  it('builds signature from check + type + automation_id + name joined by ":"', () => {
    expect(buildFindingSignature({
      check: 'contrast',
      element_type: 'Button',
      automation_id: 'save-button',
      element_name: 'Save',
    })).toBe('contrast:Button:save-button:Save');
  });

  it('handles missing fields by using empty strings', () => {
    expect(buildFindingSignature({
      check: 'focus',
      element_name: 'Submit',
    })).toBe('focus:::Submit');
    expect(buildFindingSignature(null)).toBe(':::');
  });
});

describe('deduplicateFindings', () => {
  it('identifies global findings appearing in 3+ sections', () => {
    const sharedFinding = {
      check: 'contrast',
      element_type: 'Button',
      automation_id: 'save-button',
      element_name: 'Save',
    };

    const result = deduplicateFindings({
      dashboard: {
        findings: [sharedFinding],
        flagged_elements: [sharedFinding],
        stats: { total: 1 },
      },
      sales: {
        findings: [{ ...sharedFinding }],
        flagged_elements: [{ ...sharedFinding }],
        stats: { total: 1 },
      },
      purchasing: {
        findings: [{ ...sharedFinding }],
        flagged_elements: [{ ...sharedFinding }],
        stats: { total: 1 },
      },
    });

    expect(result.global_findings).toHaveLength(1);
    expect(result.global_findings[0]).toMatchObject({
      signature: 'contrast:Button:save-button:Save',
      sections_affected: 3,
      finding: sharedFinding,
    });

    expect(result.per_section.dashboard).toMatchObject({
      unique_findings: 0,
      unique_finding_list: [],
      flagged_elements: [],
      needs_llm: false,
      stats: { total: 1 },
    });
    expect(result.per_section.sales.needs_llm).toBe(false);
    expect(result.per_section.purchasing.needs_llm).toBe(false);
  });

  it('keeps unique findings per section when signatures differ', () => {
    const result = deduplicateFindings({
      dashboard: {
        findings: [{
          check: 'contrast',
          element_type: 'Button',
          automation_id: 'save-button',
          element_name: 'Save',
        }],
        flagged_elements: [],
        stats: { total: 1 },
      },
      sales: {
        findings: [{
          check: 'label',
          element_type: 'Input',
          automation_id: 'email',
          element_name: 'Email',
        }],
        flagged_elements: [],
        stats: { total: 1 },
      },
    });

    expect(result.global_findings).toEqual([]);
    expect(result.per_section.dashboard.unique_findings).toBe(1);
    expect(result.per_section.dashboard.unique_finding_list).toHaveLength(1);
    expect(result.per_section.dashboard.needs_llm).toBe(true);
    expect(result.per_section.sales.unique_findings).toBe(1);
    expect(result.per_section.sales.unique_finding_list).toHaveLength(1);
    expect(result.per_section.sales.needs_llm).toBe(true);
  });

  it('sets needs_llm based on remaining unique findings or flagged elements', () => {
    const sharedFinding = {
      check: 'contrast',
      element_type: 'Button',
      automation_id: 'save-button',
      element_name: 'Save',
    };
    const uniqueFlagged = {
      check: 'touch-target',
      element_type: 'Link',
      automation_id: 'help-link',
      element_name: 'Help',
    };

    const result = deduplicateFindings({
      clean: {
        findings: [sharedFinding],
        flagged_elements: [sharedFinding],
        stats: { total: 1 },
      },
      one: {
        findings: [{ ...sharedFinding }],
        flagged_elements: [{ ...sharedFinding }],
        stats: { total: 1 },
      },
      two: {
        findings: [{ ...sharedFinding }],
        flagged_elements: [uniqueFlagged],
        stats: { total: 1 },
      },
      dirty: {
        findings: [{
          check: 'label',
          element_type: 'Input',
          automation_id: 'email',
          element_name: 'Email',
        }],
        flagged_elements: [],
        stats: { total: 1 },
      },
    });

    expect(result.per_section.clean.needs_llm).toBe(false);
    expect(result.per_section.clean.flagged_elements).toEqual([]);
    expect(result.per_section.one.needs_llm).toBe(false);
    expect(result.per_section.two.needs_llm).toBe(true);
    expect(result.per_section.two.flagged_elements).toEqual([uniqueFlagged]);
    expect(result.per_section.dirty.needs_llm).toBe(true);
  });

  it('returns empty global_findings when no duplicates reach the threshold', () => {
    const result = deduplicateFindings({
      dashboard: {
        findings: [{
          check: 'contrast',
          element_type: 'Button',
          automation_id: 'save-button',
          element_name: 'Save',
        }],
        flagged_elements: [],
        stats: { total: 1 },
      },
      sales: {
        findings: [{
          check: 'label',
          element_type: 'Input',
          automation_id: 'email',
          element_name: 'Email',
        }],
        flagged_elements: [],
        stats: { total: 1 },
      },
    });

    expect(result.global_findings).toEqual([]);
  });
});
