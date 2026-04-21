import { describe, it, expect, vi } from 'vitest';

const { isMetaTitle, guardIntakeItem } = require('../factory/meta-intake-guard');

describe('isMetaTitle', () => {
  it('matches "Create intake for X"', () => {
    expect(isMetaTitle('Create intake for fabro-21 review')).toBe(true);
  });

  it('matches "Add backlog entry" case-insensitively', () => {
    expect(isMetaTitle('add BACKLOG entry for auth')).toBe(true);
  });

  it('matches "File ticket" and "Open issue"', () => {
    expect(isMetaTitle('File ticket for broken build')).toBe(true);
    expect(isMetaTitle('Open issue: login flow')).toBe(true);
  });

  it('matches "Create work item"', () => {
    expect(isMetaTitle('Create work item for dashboard')).toBe(true);
  });

  it('tolerates leading whitespace', () => {
    expect(isMetaTitle('   create intake: telemetry')).toBe(true);
  });

  it('does NOT match real code work titles', () => {
    expect(isMetaTitle('Fix auth middleware session handling')).toBe(false);
    expect(isMetaTitle('Add retry logic to queue scheduler')).toBe(false);
    expect(isMetaTitle('Refactor plan-executor dry-run path')).toBe(false);
  });

  it('does NOT match non-string input', () => {
    expect(isMetaTitle(null)).toBe(false);
    expect(isMetaTitle(undefined)).toBe(false);
    expect(isMetaTitle(123)).toBe(false);
  });

  it('does NOT match "intake" when it is not preceded by an action verb', () => {
    expect(isMetaTitle('Fix intake parser bug')).toBe(false);
    expect(isMetaTitle('Intake validation improvements')).toBe(false);
  });
});

describe('guardIntakeItem', () => {
  it('accepts a non-meta title without calling retryRegenerator', async () => {
    const retry = vi.fn();
    const result = await guardIntakeItem({
      title: 'Fix deadlock in queue scheduler',
      retryRegenerator: retry,
    });
    expect(result.ok).toBe(true);
    expect(result.item.title).toBe('Fix deadlock in queue scheduler');
    expect(result.regenerated).toBeUndefined();
    expect(retry).not.toHaveBeenCalled();
  });

  it('rejects a meta title when no retryRegenerator is provided', async () => {
    const result = await guardIntakeItem({ title: 'Create intake for telemetry' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('meta_task_no_code_output');
    expect(result.title).toBe('Create intake for telemetry');
  });

  it('retries a meta title and accepts a clean regeneration', async () => {
    const retry = vi.fn().mockResolvedValue('Implement telemetry events pipeline');
    const result = await guardIntakeItem({
      title: 'Create intake for telemetry',
      retryRegenerator: retry,
    });
    expect(result.ok).toBe(true);
    expect(result.item.title).toBe('Implement telemetry events pipeline');
    expect(result.regenerated).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('rejects when retryRegenerator returns another meta title', async () => {
    const retry = vi.fn().mockResolvedValue('Add backlog entry for telemetry');
    const result = await guardIntakeItem({
      title: 'Create intake for telemetry',
      retryRegenerator: retry,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('meta_task_no_code_output');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('rejects when retryRegenerator throws', async () => {
    const retry = vi.fn().mockRejectedValue(new Error('llm timeout'));
    const result = await guardIntakeItem({
      title: 'Create intake for telemetry',
      retryRegenerator: retry,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('meta_task_no_code_output');
  });

  it('rejects when retryRegenerator returns an empty string', async () => {
    const retry = vi.fn().mockResolvedValue('   ');
    const result = await guardIntakeItem({
      title: 'Create intake for telemetry',
      retryRegenerator: retry,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('meta_task_no_code_output');
  });
});
