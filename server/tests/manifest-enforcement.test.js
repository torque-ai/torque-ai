import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDetect, mockLoad, mockFind, mockSuggest } = vi.hoisted(() => ({
  mockDetect: vi.fn(),
  mockLoad: vi.fn(),
  mockFind: vi.fn(),
  mockSuggest: vi.fn()
}));

vi.mock('../hooks/manifest-patterns', () => ({
  detectVisualSurfaces: mockDetect,
  loadManifest: mockLoad,
  findUnregistered: mockFind,
  suggestManifestEntry: mockSuggest
}));

const { createHook } = await import('../hooks/manifest-enforcement');

describe('manifest-enforcement hook', () => {
  beforeEach(() => {
    mockDetect.mockReset().mockReturnValue([]);
    mockLoad.mockReset().mockReturnValue(null);
    mockFind.mockReset().mockReturnValue([]);
    mockSuggest.mockReset().mockReturnValue({ id: 'test', label: 'Test' });
  });

  it('exports a createHook factory', () => {
    expect(typeof createHook).toBe('function');
  });

  it('hook returns null when task has no changed_files', async () => {
    const hook = createHook();
    const result = await hook({ taskId: '1', task: { working_directory: '/proj' } });
    expect(result).toBeNull();
  });

  it('hook returns null when no manifest exists', async () => {
    mockLoad.mockReturnValue(null);
    const hook = createHook();
    const result = await hook({
      taskId: '1',
      task: { working_directory: '/proj' },
      changed_files: ['src/Views/New.xaml']
    });
    expect(result).toBeNull();
  });

  it('hook detects unregistered surfaces and returns approval gate info', async () => {
    const manifest = { framework: 'wpf', sections: [] };
    mockLoad.mockReturnValue(manifest);
    mockDetect.mockReturnValue([
      { file: 'src/Views/New.xaml', type: 'Window', id: 'New' }
    ]);
    mockFind.mockReturnValue([
      { file: 'src/Views/New.xaml', type: 'Window', id: 'New' }
    ]);

    const hook = createHook();
    const result = await hook({
      taskId: 'task-1',
      task: { working_directory: '/proj' },
      changed_files: ['src/Views/New.xaml']
    });

    expect(result).toEqual({
      gate: 'manifest_update',
      task_id: 'task-1',
      unregistered: [{ file: 'src/Views/New.xaml', type: 'Window', id: 'New' }],
      suggested_entries: [{ id: 'test', label: 'Test' }],
      message: expect.stringContaining('New visual surface')
    });
  });

  it('hook returns null when all surfaces are registered', async () => {
    const manifest = { framework: 'wpf', sections: [{ id: 'new' }] };
    mockLoad.mockReturnValue(manifest);
    mockDetect.mockReturnValue([
      { file: 'src/Views/New.xaml', type: 'Window', id: 'New' }
    ]);
    mockFind.mockReturnValue([]);

    const hook = createHook();
    const result = await hook({
      taskId: 'task-1',
      task: { working_directory: '/proj' },
      changed_files: ['src/Views/New.xaml']
    });

    expect(result).toBeNull();
  });
});
