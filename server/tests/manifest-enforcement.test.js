import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
const { createHook } = require('../hooks/manifest-enforcement');

describe('manifest-enforcement hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports a createHook factory', () => {
    expect(typeof createHook).toBe('function');
  });

  it('hook returns null when task has no changed_files', async () => {
    const hook = createHook();
    const result = await hook({ taskId: '1', task: { working_directory: tmpDir } });
    expect(result).toBeNull();
  });

  it('hook returns null when no manifest exists', async () => {
    const hook = createHook();
    const result = await hook({
      taskId: '1',
      task: { working_directory: tmpDir },
      changed_files: ['src/Views/New.xaml']
    });
    expect(result).toBeNull();
  });

  it('hook detects unregistered surfaces and returns approval gate info', async () => {
    // Create a peek-manifest.json with no sections
    fs.writeFileSync(path.join(tmpDir, 'peek-manifest.json'), JSON.stringify({
      app: 'TestApp',
      process: 'TestApp.Desktop',
      framework: 'wpf',
      sections: []
    }));

    // Create a XAML file that counts as a visual surface
    const viewDir = path.join(tmpDir, 'src', 'Views');
    fs.mkdirSync(viewDir, { recursive: true });
    fs.writeFileSync(path.join(viewDir, 'NewPage.xaml'), '<Window x:Class="App.Views.NewPage">');

    const hook = createHook();
    const result = await hook({
      taskId: 'task-1',
      task: { working_directory: tmpDir },
      changed_files: ['src/Views/NewPage.xaml']
    });

    expect(result).not.toBeNull();
    expect(result.gate).toBe('manifest_update');
    expect(result.task_id).toBe('task-1');
    expect(result.unregistered).toHaveLength(1);
    expect(result.unregistered[0].id).toBe('NewPage');
    expect(result.suggested_entries).toHaveLength(1);
    expect(result.message).toContain('New visual surface');
  });

  it('hook returns null when all surfaces are registered', async () => {
    // Create manifest with the surface already registered
    fs.writeFileSync(path.join(tmpDir, 'peek-manifest.json'), JSON.stringify({
      app: 'TestApp',
      process: 'TestApp.Desktop',
      framework: 'wpf',
      sections: [{ id: 'newpage', label: 'New Page' }]
    }));

    const viewDir = path.join(tmpDir, 'src', 'Views');
    fs.mkdirSync(viewDir, { recursive: true });
    fs.writeFileSync(path.join(viewDir, 'NewPage.xaml'), '<Window x:Class="App.Views.NewPage">');

    const hook = createHook();
    const result = await hook({
      taskId: 'task-1',
      task: { working_directory: tmpDir },
      changed_files: ['src/Views/NewPage.xaml']
    });

    expect(result).toBeNull();
  });
});
