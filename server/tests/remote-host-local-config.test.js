'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const remoteHostLocalConfig = require('../utils/remote-host-local-config');

function createTempRoot({ ignored = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-remote-local-config-'));
  fs.mkdirSync(path.join(root, 'infrastructure', 'hosts'), { recursive: true });
  if (ignored) {
    fs.writeFileSync(
      path.join(root, '.gitignore'),
      'infrastructure/hosts/*.local.json\ninfrastructure/hosts/**/*.local.json\n'
    );
    fs.writeFileSync(path.join(root, 'infrastructure', 'hosts', '.gitignore'), '*.local.json\n');
  }
  return root;
}

describe('remote-host-local-config', () => {
  const tempRoots = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes the local infra host file and redacts key_path from responses', () => {
    const root = createTempRoot();
    tempRoots.push(root);

    const result = remoteHostLocalConfig.saveRemoteHostLocalConfig({
      host: '192.0.2.10',
      user: 'remote-user',
      key_path: 'C:\\keys\\id_ed25519',
      remote_project_path: 'C:\\trt\\torque-public',
      remote_test_worktree_root: 'C:\\trt',
      lane_count: '2',
    }, root);

    const filePath = remoteHostLocalConfig.getConfigPath(root);
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(saved).toEqual({
      host: '192.0.2.10',
      user: 'remote-user',
      key_path: 'C:\\keys\\id_ed25519',
      remote_project_path: 'C:\\trt\\torque-public',
      remote_test_worktree_root: 'C:\\trt',
      lane_count: 2,
    });
    expect(result.exists).toBe(true);
    expect(result.git_ignored).toBe(true);
    expect(result.has_key_path).toBe(true);
    expect(result.key_path_hint).toBe('id_ed25519');
    expect(result.values.key_path).toBeUndefined();
  });

  it('preserves an existing key path when the update omits key_path', () => {
    const root = createTempRoot();
    tempRoots.push(root);

    remoteHostLocalConfig.saveRemoteHostLocalConfig({
      host: '192.0.2.10',
      user: 'first-user',
      key_path: 'C:\\keys\\id_ed25519',
      lane_count: 1,
    }, root);

    remoteHostLocalConfig.saveRemoteHostLocalConfig({
      host: '192.0.2.20',
      user: 'next-user',
      lane_count: 3,
    }, root);

    const saved = JSON.parse(fs.readFileSync(remoteHostLocalConfig.getConfigPath(root), 'utf8'));
    expect(saved).toEqual({
      host: '192.0.2.20',
      user: 'next-user',
      key_path: 'C:\\keys\\id_ed25519',
      lane_count: 3,
    });
  });

  it('refuses to write if the fixed local credential path is not ignored', () => {
    const root = createTempRoot({ ignored: false });
    tempRoots.push(root);

    expect(() => remoteHostLocalConfig.saveRemoteHostLocalConfig({
      host: '192.0.2.10',
      user: 'remote-user',
      key_path: 'C:\\keys\\id_ed25519',
    }, root)).toThrow(/not ignored by git/);

    expect(fs.existsSync(remoteHostLocalConfig.getConfigPath(root))).toBe(false);
  });
});
