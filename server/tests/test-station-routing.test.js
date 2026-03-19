/**
 * Test Station Routing — Config File Writing Tests
 *
 * Tests for writeTestStationConfig which:
 * 1. Writes .torque-test.json (shared config)
 * 2. Writes .torque-test.local.json (personal SSH details)
 * 3. Adds .torque-test.local.json to .gitignore
 * 4. Installs Claude Code guard hook in .claude/settings.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeTestStationConfig } = require('../handlers/automation-handlers');

let tmpDir;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `torque-test-station-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('writeTestStationConfig', () => {
  it('writes .torque-test.json with correct fields when SSH fields are set', () => {
    const args = {
      test_station_host: '192.168.1.183',
      test_station_user: 'kenten',
      test_station_project_path: '/home/kenten/project',
      verify_command: 'npm test',
    };
    const configUpdate = { verify_command: 'npm test' };

    writeTestStationConfig(tmpDir, args, configUpdate);

    const filePath = path.join(tmpDir, '.torque-test.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(content.version).toBe(1);
    expect(content.transport).toBe('ssh');
    expect(content.verify_command).toBe('npm test');
    expect(content.timeout_seconds).toBe(300);
    expect(content.sync_before_run).toBe(true);
  });

  it('writes .torque-test.json with transport "local" when no SSH fields', () => {
    const args = { verify_command: 'npm test' };
    const configUpdate = { verify_command: 'npm test' };

    writeTestStationConfig(tmpDir, args, configUpdate);

    const filePath = path.join(tmpDir, '.torque-test.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(content.transport).toBe('local');
  });

  it('writes .torque-test.local.json with SSH details', () => {
    const args = {
      test_station_host: '192.168.1.183',
      test_station_user: 'kenten',
      test_station_project_path: '/home/kenten/project',
      test_station_key_path: '~/.ssh/id_rsa',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const filePath = path.join(tmpDir, '.torque-test.local.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(content.host).toBe('192.168.1.183');
    expect(content.user).toBe('kenten');
    expect(content.project_path).toBe('/home/kenten/project');
    expect(content.key_path).toBe('~/.ssh/id_rsa');
  });

  it('does not write .torque-test.local.json when no SSH fields', () => {
    const args = { verify_command: 'npm test' };
    const configUpdate = { verify_command: 'npm test' };

    writeTestStationConfig(tmpDir, args, configUpdate);

    const filePath = path.join(tmpDir, '.torque-test.local.json');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('adds .torque-test.local.json to .gitignore', () => {
    const args = {
      test_station_host: '192.168.1.183',
      test_station_user: 'kenten',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const gitignorePath = path.join(tmpDir, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const content = fs.readFileSync(gitignorePath, 'utf8');
    expect(content).toContain('.torque-test.local.json');
  });

  it('does not duplicate .gitignore entry on second call', () => {
    const args = {
      test_station_host: '192.168.1.183',
      test_station_user: 'kenten',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);
    writeTestStationConfig(tmpDir, args, configUpdate);

    const gitignorePath = path.join(tmpDir, '.gitignore');
    const content = fs.readFileSync(gitignorePath, 'utf8');
    const matches = content.split('\n').filter(line => line.trim() === '.torque-test.local.json');
    expect(matches.length).toBe(1);
  });

  it('appends to existing .gitignore without losing content', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n');

    const args = {
      test_station_host: '192.168.1.183',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const content = fs.readFileSync(gitignorePath, 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.env');
    expect(content).toContain('.torque-test.local.json');
  });

  it('installs hook config in .claude/settings.json for SSH transport', () => {
    const args = {
      test_station_host: '192.168.1.183',
      test_station_user: 'kenten',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeInstanceOf(Array);
    expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);

    const bashHook = settings.hooks.PreToolUse.find(h => h.matcher === 'Bash');
    expect(bashHook).toBeDefined();
    expect(bashHook.hooks).toBeInstanceOf(Array);
    expect(bashHook.hooks[0].type).toBe('command');
    expect(bashHook.hooks[0].command).toContain('torque-test-guard');
  });

  it('does NOT install hook when transport is local', () => {
    const args = { verify_command: 'npm test' };
    const configUpdate = { verify_command: 'npm test' };

    writeTestStationConfig(tmpDir, args, configUpdate);

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('merges with existing .torque-test.json without losing fields', () => {
    const existingConfig = {
      version: 1,
      transport: 'local',
      verify_command: 'old command',
      timeout_seconds: 600,
      sync_before_run: false,
      custom_field: 'should_survive',
    };
    fs.writeFileSync(
      path.join(tmpDir, '.torque-test.json'),
      JSON.stringify(existingConfig, null, 2)
    );

    const args = {
      test_station_host: '192.168.1.183',
      verify_command: 'new command',
    };
    const configUpdate = { verify_command: 'new command' };

    writeTestStationConfig(tmpDir, args, configUpdate);

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.torque-test.json'), 'utf8'));
    expect(content.transport).toBe('ssh');
    expect(content.verify_command).toBe('new command');
    expect(content.custom_field).toBe('should_survive');
    // timeout_seconds and sync_before_run should keep their existing values
    expect(content.timeout_seconds).toBe(600);
    expect(content.sync_before_run).toBe(false);
  });

  it('merges with existing .torque-test.local.json', () => {
    const existing = {
      host: 'old-host',
      user: 'old-user',
      project_path: '/old/path',
      key_path: '/old/key',
    };
    fs.writeFileSync(
      path.join(tmpDir, '.torque-test.local.json'),
      JSON.stringify(existing, null, 2)
    );

    const args = {
      test_station_host: 'new-host',
      // only update host, leave other fields
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.torque-test.local.json'), 'utf8'));
    expect(content.host).toBe('new-host');
    expect(content.user).toBe('old-user');
    expect(content.project_path).toBe('/old/path');
    expect(content.key_path).toBe('/old/key');
  });

  it('merges with existing .claude/settings.json without losing other settings', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const existingSettings = {
      permissions: { allow: ['Read', 'Write'] },
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo done' }] }],
      },
    };
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(existingSettings, null, 2)
    );

    const args = {
      test_station_host: '192.168.1.183',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    // Original settings preserved
    expect(settings.permissions).toEqual({ allow: ['Read', 'Write'] });
    expect(settings.hooks.PostToolUse).toEqual(existingSettings.hooks.PostToolUse);
    // New hook added
    expect(settings.hooks.PreToolUse).toBeDefined();
    const bashHook = settings.hooks.PreToolUse.find(h => h.matcher === 'Bash');
    expect(bashHook).toBeDefined();
  });

  it('does not duplicate hook if already installed', () => {
    const args = {
      test_station_host: '192.168.1.183',
    };
    const configUpdate = {};

    writeTestStationConfig(tmpDir, args, configUpdate);
    writeTestStationConfig(tmpDir, args, configUpdate);

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const bashHooks = settings.hooks.PreToolUse.filter(h => h.matcher === 'Bash');
    expect(bashHooks.length).toBe(1);
  });

  it('handles corrupt existing JSON files gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, '.torque-test.json'), 'NOT VALID JSON{{{');

    const args = {
      test_station_host: '192.168.1.183',
      verify_command: 'npm test',
    };
    const configUpdate = { verify_command: 'npm test' };

    // Should not throw
    writeTestStationConfig(tmpDir, args, configUpdate);

    // Should write fresh config
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, '.torque-test.json'), 'utf8'));
    expect(content.version).toBe(1);
    expect(content.transport).toBe('ssh');
  });
});
