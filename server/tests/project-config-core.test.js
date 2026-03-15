const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

describe('project-config core', () => {
  let db;
  let handleToolCall;
  let testDir;

  beforeEach(() => {
    ({ db, handleToolCall, testDir } = setupTestDb('project-config-core'));
  });

  afterEach(() => {
    teardownTestDb();
  });

  function rawDb() {
    return db.getDbInstance();
  }

  async function tool(name, args) {
    try {
      return await handleToolCall(name, args);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: err.message }],
      };
    }
  }

  function getText(result) {
    return result?.content?.find((item) => item.type === 'text')?.text || '';
  }

  function createProjectDir(name, withMarker = false) {
    const projectDir = path.join(testDir, name);
    fs.mkdirSync(projectDir, { recursive: true });
    if (withMarker) {
      fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name }), 'utf8');
    }
    return projectDir;
  }

  function createNestedProject(name) {
    const root = createProjectDir(name, true);
    const nested = path.join(root, 'src', 'features');
    fs.mkdirSync(nested, { recursive: true });
    return { root, nested };
  }

  function createCompletedTask({ description = 'cache me', workingDirectory = testDir } = {}) {
    const id = randomUUID();
    db.createTask({
      id,
      task_description: description,
      working_directory: workingDirectory,
      status: 'completed',
    });
    rawDb().prepare(
      'UPDATE tasks SET output = ?, exit_code = ?, completed_at = ? WHERE id = ?'
    ).run('cached output', 0, new Date().toISOString(), id);
    return db.getTask(id);
  }

  function getProjectConfigRowCount(project) {
    return rawDb().prepare('SELECT COUNT(*) as count FROM project_config WHERE project = ?').get(project).count;
  }

  function getProjectMetadataRowCount(project, key) {
    return rawDb().prepare(
      'SELECT COUNT(*) as count FROM project_metadata WHERE project = ? AND key = ?'
    ).get(project, key).count;
  }

  describe('database config CRUD', () => {
    it('returns undefined for a missing project config', () => {
      expect(db.getProjectConfig('missing-project')).toBeUndefined();
    });

    it('creates a project config with defaults and custom fields', () => {
      const config = db.setProjectConfig('alpha', {
        max_concurrent: 4,
        auto_approve: true,
        enabled: false,
        default_provider: 'codex',
        default_model: 'gpt-5.3-codex-spark',
        verify_command: 'npx vitest run',
        auto_fix_enabled: true,
      });

      expect(config.project).toBe('alpha');
      expect(config.max_concurrent).toBe(4);
      expect(config.default_timeout).toBe(30);
      expect(config.auto_approve).toBe(true);
      expect(config.enabled).toBe(false);
      expect(config.default_provider).toBe('codex');
      expect(config.default_model).toBe('gpt-5.3-codex-spark');
      expect(config.verify_command).toBe('npx vitest run');
      expect(config.auto_fix_enabled).toBe(1);
    });

    it('updates an existing config without clobbering unspecified fields', () => {
      db.setProjectConfig('alpha', {
        default_provider: 'codex',
        default_model: 'gpt-5.3-codex-spark',
        verify_command: 'npx tsc --noEmit',
        auto_fix_enabled: true,
      });

      const updated = db.setProjectConfig('alpha', {
        default_provider: 'ollama',
        max_concurrent: 9,
      });

      expect(updated.default_provider).toBe('ollama');
      expect(updated.max_concurrent).toBe(9);
      expect(updated.default_model).toBe('gpt-5.3-codex-spark');
      expect(updated.verify_command).toBe('npx tsc --noEmit');
      expect(updated.auto_fix_enabled).toBe(1);
      expect(getProjectConfigRowCount('alpha')).toBe(1);
    });

    it('updates updated_at without changing created_at', async () => {
      const created = db.setProjectConfig('alpha', {
        verify_command: 'echo first',
      });

      await new Promise((resolve) => setTimeout(resolve, 5));

      const updated = db.setProjectConfig('alpha', {
        verify_command: 'echo second',
      });

      expect(updated.created_at).toBe(created.created_at);
      expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(created.updated_at).getTime());
    });

    it('clears nullable fields when they are updated to null', () => {
      db.setProjectConfig('alpha', {
        default_provider: 'codex',
        default_model: 'gpt-5.3-codex-spark',
        verify_command: 'npx vitest run',
      });

      const cleared = db.setProjectConfig('alpha', {
        default_provider: null,
        default_model: null,
        verify_command: null,
      });

      expect(cleared.default_provider).toBeNull();
      expect(cleared.default_model).toBeNull();
      expect(cleared.verify_command).toBeNull();
    });

    it('persists auto_verify_on_completion on the first insert', () => {
      db.setProjectConfig('alpha', {
        auto_verify_on_completion: 1,
      });

      const config = db.getProjectConfig('alpha');
      expect(config.auto_verify_on_completion).toBe(1);
    });

    it('persists remote test settings on the first insert', () => {
      db.setProjectConfig('alpha', {
        remote_agent_id: 'agent-123',
        remote_project_path: 'D:/agents/Torque',
        prefer_remote_tests: 1,
      });

      const config = db.getProjectConfig('alpha');
      expect(config.remote_agent_id).toBe('agent-123');
      expect(config.remote_project_path).toBe('D:/agents/Torque');
      expect(config.prefer_remote_tests).toBe(1);
    });

    it('round-trips project metadata and returns all metadata keys', () => {
      db.setProjectMetadata('alpha', 'step_providers', JSON.stringify({ tests: 'codex' }));
      db.setProjectMetadata('alpha', 'notes', 'keep this');

      expect(db.getProjectMetadata('alpha', 'step_providers')).toBe('{"tests":"codex"}');
      expect(db.getProjectMetadata('alpha', 'missing')).toBeNull();
      expect(db.getAllProjectMetadata('alpha')).toEqual({
        step_providers: '{"tests":"codex"}',
        notes: 'keep this',
      });
    });

    it('lists project configs sorted by project name and normalizes booleans', () => {
      db.setProjectConfig('zeta', { enabled: false, auto_approve: true });
      db.setProjectConfig('alpha', { enabled: true, auto_approve: false });

      const configs = db.listProjectConfigs();

      expect(configs.map((config) => config.project)).toEqual(['alpha', 'zeta']);
      expect(configs[0].enabled).toBe(true);
      expect(configs[0].auto_approve).toBe(false);
      expect(configs[1].enabled).toBe(false);
      expect(configs[1].auto_approve).toBe(true);
    });

    it('deletes a project config and returns false when deleting again', () => {
      db.setProjectConfig('alpha', { verify_command: 'echo ok' });

      expect(db.deleteProjectConfig('alpha')).toBe(true);
      expect(db.getProjectConfig('alpha')).toBeUndefined();
      expect(db.deleteProjectConfig('alpha')).toBe(false);
    });

    it('falls back to global defaults for a missing project', () => {
      db.setConfig('default_project_max_concurrent', '7');
      db.setConfig('default_timeout', '45');
      db.setConfig('max_concurrent', '12');

      const effective = db.getEffectiveProjectConfig('missing');

      expect(effective.project).toBe('missing');
      expect(effective.max_concurrent).toBe(7);
      expect(effective.default_timeout).toBe(45);
      expect(effective.default_priority).toBe(0);
      expect(effective.enabled).toBe(true);
      expect(effective.global_max_concurrent).toBe(12);
      expect(effective.default_project_max_concurrent).toBe(7);
    });

    it('prefers stored project row defaults while applying project overrides', () => {
      db.setConfig('default_project_max_concurrent', '6');
      db.setConfig('default_timeout', '50');
      db.setConfig('max_concurrent', '15');
      db.setProjectConfig('alpha', {
        max_concurrent: 2,
        default_priority: 8,
        enabled: false,
      });

      const effective = db.getEffectiveProjectConfig('alpha');

      expect(effective.max_concurrent).toBe(2);
      expect(effective.default_timeout).toBe(30);
      expect(effective.default_priority).toBe(8);
      expect(effective.enabled).toBe(false);
      expect(effective.global_max_concurrent).toBe(15);
      expect(effective.default_project_max_concurrent).toBe(6);
    });
  });

  describe('set_project_defaults and get_project_defaults', () => {
    it('rejects set_project_defaults without a working_directory', async () => {
      const result = await tool('set_project_defaults', { provider: 'codex' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory is required');
    });

    it('rejects get_project_defaults without a working_directory', async () => {
      const result = await tool('get_project_defaults', {});
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('working_directory is required');
    });

    it('reports when a project has no saved defaults yet', async () => {
      const projectDir = createProjectDir('fresh-project');
      const result = await tool('get_project_defaults', { working_directory: projectDir });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No project configuration found');
    });

    it('resolves the project from a nested path using marker discovery', async () => {
      const { root, nested } = createNestedProject('repo-rooted');
      const result = await tool('set_project_defaults', {
        working_directory: nested,
        provider: 'codex',
      });

      const project = db.getProjectFromPath(nested);
      const config = db.getProjectConfig(project);

      expect(result.isError).toBeFalsy();
      expect(project).toBe(path.basename(root));
      expect(config.default_provider).toBe('codex');
      expect(getText(result)).toContain(`Project Defaults: ${path.basename(root)}`);
    });

    it('persists provider, model, verify command, auto_fix, and test_pattern', async () => {
      const projectDir = createProjectDir('defaults-write');

      const result = await tool('set_project_defaults', {
        working_directory: projectDir,
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        verify_command: 'npx tsc --noEmit && npx vitest run',
        auto_fix: true,
        test_pattern: '.spec.js',
      });

      const project = db.getProjectFromPath(projectDir);
      const config = db.getProjectConfig(project);

      expect(result.isError).toBeFalsy();
      expect(config.default_provider).toBe('codex');
      expect(config.default_model).toBe('gpt-5.3-codex-spark');
      expect(config.verify_command).toBe('npx tsc --noEmit && npx vitest run');
      expect(config.auto_fix_enabled).toBe(1);
      expect(config.test_pattern).toBe('.spec.js');
    });

    it('preserves verify_command on a partial set_project_defaults update', async () => {
      const projectDir = createProjectDir('partial-update');
      await tool('set_project_defaults', {
        working_directory: projectDir,
        provider: 'codex',
        verify_command: 'npm run verify',
      });

      await tool('set_project_defaults', {
        working_directory: projectDir,
        model: 'gpt-5.3-codex-spark',
      });

      const project = db.getProjectFromPath(projectDir);
      const config = db.getProjectConfig(project);

      expect(config.default_provider).toBe('codex');
      expect(config.default_model).toBe('gpt-5.3-codex-spark');
      expect(config.verify_command).toBe('npm run verify');
    });

    it('persists step_providers metadata and renders it in get_project_defaults', async () => {
      const projectDir = createProjectDir('step-providers');
      await tool('set_project_defaults', {
        working_directory: projectDir,
        provider: 'codex',
        step_providers: { types: 'ollama', tests: 'codex' },
      });

      const project = db.getProjectFromPath(projectDir);
      const metadata = JSON.parse(db.getProjectMetadata(project, 'step_providers'));
      const result = await tool('get_project_defaults', {
        working_directory: projectDir,
      });

      expect(metadata).toEqual({ types: 'ollama', tests: 'codex' });
      expect(getText(result)).toContain('types=ollama');
      expect(getText(result)).toContain('tests=codex');
    });

    it('ignores invalid step_providers JSON when reading project defaults', async () => {
      const projectDir = createProjectDir('bad-step-providers');
      const project = db.getProjectFromPath(projectDir);
      db.setProjectConfig(project, { verify_command: 'echo ok' });
      db.setProjectMetadata(project, 'step_providers', '{bad json');

      const result = await tool('get_project_defaults', {
        working_directory: projectDir,
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Current Settings');
      expect(getText(result)).not.toContain('Step providers');
    });

    it('persists remote settings and auto_verify_on_completion on the first tool write', async () => {
      const projectDir = createProjectDir('remote-defaults');

      const result = await tool('set_project_defaults', {
        working_directory: projectDir,
        verify_command: 'npm run verify',
        auto_verify_on_completion: true,
        remote_agent_id: 'agent-7',
        remote_project_path: 'D:/agents/Torque',
        prefer_remote_tests: true,
      });

      const project = db.getProjectFromPath(projectDir);
      const config = db.getProjectConfig(project);

      expect(result.isError).toBeFalsy();
      expect(config.verify_command).toBe('npm run verify');
      expect(config.auto_verify_on_completion).toBe(1);
      expect(config.remote_agent_id).toBe('agent-7');
      expect(config.remote_project_path).toBe('D:/agents/Torque');
      expect(config.prefer_remote_tests).toBe(1);
    });

    it('rejects an invalid provider without clobbering the existing config', async () => {
      const projectDir = createProjectDir('provider-validation');
      await tool('set_project_defaults', {
        working_directory: projectDir,
        provider: 'codex',
      });

      const result = await tool('set_project_defaults', {
        working_directory: projectDir,
        provider: 'not-a-real-provider',
      });

      const project = db.getProjectFromPath(projectDir);
      const config = db.getProjectConfig(project);

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Invalid provider');
      expect(config.default_provider).toBe('codex');
    });

    it('renders smart routing when no project default provider is configured', async () => {
      const projectDir = createProjectDir('smart-routing');
      const project = db.getProjectFromPath(projectDir);
      db.setProjectConfig(project, { verify_command: 'echo ok' });

      const result = await tool('get_project_defaults', {
        working_directory: projectDir,
      });

      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('| Provider | (smart routing) |');
    });
  });

  describe('cache and invalidation', () => {
    it('returns the seeded cache configuration', () => {
      const config = db.getCacheConfig();

      expect(config.ttl_hours).toBe('24');
      expect(config.max_size_mb).toBe('100');
      expect(config.similarity_threshold).toBe('0.85');
      expect(config.auto_cache).toBe('true');
    });

    it('updates cache config values immediately across repeated reads', () => {
      db.setCacheConfig('ttl_hours', '48');
      expect(db.getCacheConfig('ttl_hours')).toBe('48');

      db.setCacheConfig('ttl_hours', '72');
      expect(db.getCacheConfig('ttl_hours')).toBe('72');
    });

    it('returns exact cache hits and increments hit_count', () => {
      const task = createCompletedTask({ description: 'cache exact hit' });
      const cached = db.cacheTaskResult(task.id);

      const hit = db.lookupCache('cache exact hit', task.working_directory, null);
      const row = rawDb().prepare('SELECT hit_count FROM task_cache WHERE id = ?').get(cached.id);

      expect(hit).toBeTruthy();
      expect(hit.match_type).toBe('exact');
      expect(hit.id).toBe(cached.id);
      expect(row.hit_count).toBe(1);
    });

    it('invalidates cache entries by content hash', () => {
      const task = createCompletedTask({ description: 'remove by hash' });
      const cached = db.cacheTaskResult(task.id);

      const result = db.invalidateCache({ contentHash: cached.content_hash });

      expect(result.deleted).toBe(1);
      expect(db.lookupCache('remove by hash', task.working_directory, null)).toBeNull();
    });

    it('invalidates expired cache entries when called without options', () => {
      const task = createCompletedTask({ description: 'expire me' });
      const cached = db.cacheTaskResult(task.id);
      rawDb().prepare("UPDATE task_cache SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(cached.id);

      const result = db.invalidateCache({});

      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(rawDb().prepare('SELECT id FROM task_cache WHERE id = ?').get(cached.id)).toBeUndefined();
    });

    it('keeps a single config row after rapid setProjectConfig writes', async () => {
      const project = 'concurrent-db';

      await Promise.all([
        Promise.resolve().then(() => db.setProjectConfig(project, { default_provider: 'codex', verify_command: 'echo one' })),
        Promise.resolve().then(() => db.setProjectConfig(project, { default_provider: 'ollama', verify_command: 'echo two' })),
        Promise.resolve().then(() => db.setProjectConfig(project, { default_model: 'qwen3:8b' })),
      ]);

      const config = db.getProjectConfig(project);

      expect(getProjectConfigRowCount(project)).toBe(1);
      expect(['codex', 'ollama']).toContain(config.default_provider);
      expect(['echo one', 'echo two']).toContain(config.verify_command);
      expect([null, 'qwen3:8b']).toContain(config.default_model);
    });

    it('keeps one config row and one step_providers row after rapid tool updates', async () => {
      const projectDir = createProjectDir('concurrent-tool');

      await Promise.all([
        tool('set_project_defaults', {
          working_directory: projectDir,
          provider: 'codex',
          step_providers: { types: 'ollama' },
        }),
        tool('set_project_defaults', {
          working_directory: projectDir,
          provider: 'ollama',
          verify_command: 'echo ok',
          step_providers: { tests: 'codex' },
        }),
      ]);

      const project = db.getProjectFromPath(projectDir);
      const config = db.getProjectConfig(project);
      const metadata = JSON.parse(db.getProjectMetadata(project, 'step_providers'));

      expect(getProjectConfigRowCount(project)).toBe(1);
      expect(getProjectMetadataRowCount(project, 'step_providers')).toBe(1);
      expect(['codex', 'ollama']).toContain(config.default_provider);
      expect([null, 'echo ok']).toContain(config.verify_command);
      expect(
        JSON.stringify(metadata) === JSON.stringify({ types: 'ollama' }) ||
        JSON.stringify(metadata) === JSON.stringify({ tests: 'codex' })
      ).toBe(true);
    });
  });
});
