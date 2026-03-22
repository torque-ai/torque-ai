/**
 * Tests for the incomplete task nudge heuristic in the agentic loop.
 *
 * When an LLM calls only read-only tools (list_directory, read_file) and then
 * responds with text describing what it would create — but doesn't actually
 * call write_file — the loop should nudge it to complete the work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Inline mock of the agentic loop's nudge logic
// (testing the condition, not the full loop — the loop has too many deps)

describe('Incomplete task nudge heuristic', () => {
  function shouldNudge({ toolLog, taskPrompt, hasWriteTools, emptySummaryRetried }) {
    const taskMentionsCreation = /\b(create|add|write|implement|generate)\b/i.test(taskPrompt);
    return (
      !hasWriteTools &&
      taskMentionsCreation &&
      toolLog.length > 0 &&
      toolLog.length <= 3 &&
      !emptySummaryRetried
    );
  }

  it('nudges when task says create but only list_directory was called', () => {
    expect(shouldNudge({
      toolLog: [{ name: 'list_directory' }],
      taskPrompt: 'Create a RecurringExpenseTests.cs file with xUnit tests',
      hasWriteTools: false,
      emptySummaryRetried: false,
    })).toBe(true);
  });

  it('does not nudge when write_file was called', () => {
    expect(shouldNudge({
      toolLog: [{ name: 'list_directory' }, { name: 'write_file' }],
      taskPrompt: 'Create a RecurringExpenseTests.cs file',
      hasWriteTools: true,
      emptySummaryRetried: false,
    })).toBe(false);
  });

  it('does not nudge when task does not mention creation', () => {
    expect(shouldNudge({
      toolLog: [{ name: 'list_directory' }],
      taskPrompt: 'Review the existing test files for correctness',
      hasWriteTools: false,
      emptySummaryRetried: false,
    })).toBe(false);
  });

  it('does not nudge when no tools were called', () => {
    expect(shouldNudge({
      toolLog: [],
      taskPrompt: 'Create a new test file',
      hasWriteTools: false,
      emptySummaryRetried: false,
    })).toBe(false);
  });

  it('does not nudge when already retried (prevents infinite loop)', () => {
    expect(shouldNudge({
      toolLog: [{ name: 'list_directory' }],
      taskPrompt: 'Add a new RecurringExpense entity',
      hasWriteTools: false,
      emptySummaryRetried: true,
    })).toBe(false);
  });

  it('does not nudge when many tools were called (model explored thoroughly)', () => {
    expect(shouldNudge({
      toolLog: [
        { name: 'list_directory' },
        { name: 'read_file' },
        { name: 'read_file' },
        { name: 'search_files' },
      ],
      taskPrompt: 'Create a new service class',
      hasWriteTools: false,
      emptySummaryRetried: false,
    })).toBe(false);
  });

  it('nudges for "add" keyword', () => {
    expect(shouldNudge({
      toolLog: [{ name: 'read_file' }],
      taskPrompt: 'Add a RecurrenceFrequency enum to Domain/Budgeting/',
      hasWriteTools: false,
      emptySummaryRetried: false,
    })).toBe(true);
  });

  it('nudges for "implement" keyword', () => {
    expect(shouldNudge({
      toolLog: [{ name: 'list_directory' }, { name: 'read_file' }],
      taskPrompt: 'Implement the RecurringExpenseService class',
      hasWriteTools: false,
      emptySummaryRetried: false,
    })).toBe(true);
  });
});
