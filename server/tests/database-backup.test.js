const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const path = require('path');
const fs = require('fs');
const os = require('os');
const backupCore = require('../db/backup-core');

describe('Database Backup/Restore', () => {
  let testDir;
  let backupsDirSpy;

  beforeAll(() => {
    const ctx = setupTestDb('db-backup');
    testDir = ctx.testDir;
    // Mock getBackupsDir so listBackups accepts test temp directories
    backupsDirSpy = vi.spyOn(backupCore, 'getBackupsDir').mockReturnValue(testDir);
  });
  afterAll(() => {
    backupsDirSpy?.mockRestore();
    teardownTestDb();
  });

  describe('backup_database', () => {
    it('creates a backup with default path', async () => {
      const result = await safeTool('backup_database', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Backup Created');
    });

    it('creates a backup at specified path', async () => {
      const dest = path.join(os.tmpdir(), `torque-test-backup-${Date.now()}.db`);
      const result = await safeTool('backup_database', { dest_path: dest });
      expect(result.isError).toBeFalsy();
      expect(fs.existsSync(dest)).toBe(true);
      fs.unlinkSync(dest);
    });

    it('includes size and timestamp in output', async () => {
      const dest = path.join(testDir, 'sized-backup.db');
      const result = await safeTool('backup_database', { dest_path: dest });
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toContain('Size:');
      expect(text).toContain('KB');
      expect(text).toContain('Created:');
    });

    it('creates destination directory if it does not exist', async () => {
      const nestedDir = path.join(testDir, 'nested', 'backup', 'dir');
      const dest = path.join(nestedDir, 'deep-backup.db');
      const result = await safeTool('backup_database', { dest_path: dest });
      expect(result.isError).toBeFalsy();
      expect(fs.existsSync(dest)).toBe(true);
    });

    it('backup file is a valid SQLite database', async () => {
      const dest = path.join(testDir, 'valid-check.db');
      await safeTool('backup_database', { dest_path: dest });
      // SQLite databases start with "SQLite format 3\0"
      const header = Buffer.alloc(16);
      const fd = fs.openSync(dest, 'r');
      fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      expect(header.toString('utf8', 0, 15)).toBe('SQLite format 3');
    });
  });

  describe('list_database_backups', () => {
    it('returns empty list for nonexistent directory', async () => {
      const result = await safeTool('list_database_backups', { directory: path.join(testDir, 'nonexistent-dir-xyz') });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('No backups');
    });

    it('lists backups in a directory', async () => {
      const backupDir = path.join(testDir, 'list-backups');
      fs.mkdirSync(backupDir, { recursive: true });
      // Create a test backup first
      await safeTool('backup_database', { dest_path: path.join(backupDir, 'test.db') });
      const result = await safeTool('list_database_backups', { directory: backupDir });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('test.db');
    });

    it('filters to only .db and .sqlite files', async () => {
      const backupDir = path.join(testDir, 'filter-backups');
      fs.mkdirSync(backupDir, { recursive: true });
      // Create a .db file and a .txt file
      await safeTool('backup_database', { dest_path: path.join(backupDir, 'real.db') });
      fs.writeFileSync(path.join(backupDir, 'not-a-backup.txt'), 'hello');
      const result = await safeTool('list_database_backups', { directory: backupDir });
      const text = getText(result);
      expect(text).toContain('real.db');
      expect(text).not.toContain('not-a-backup.txt');
    });

    it('shows count in header', async () => {
      const backupDir = path.join(testDir, 'count-backups');
      fs.mkdirSync(backupDir, { recursive: true });
      await safeTool('backup_database', { dest_path: path.join(backupDir, 'one.db') });
      await safeTool('backup_database', { dest_path: path.join(backupDir, 'two.db') });
      const result = await safeTool('list_database_backups', { directory: backupDir });
      expect(getText(result)).toContain('Database Backups (2)');
    });

    it('sorts backups by date descending', async () => {
      const backupDir = path.join(testDir, 'sorted-backups');
      fs.mkdirSync(backupDir, { recursive: true });
      await safeTool('backup_database', { dest_path: path.join(backupDir, 'older.db') });
      // Small delay to ensure different mtime
      await new Promise(r => setTimeout(r, 50));
      await safeTool('backup_database', { dest_path: path.join(backupDir, 'newer.db') });
      const result = await safeTool('list_database_backups', { directory: backupDir });
      const text = getText(result);
      const olderIdx = text.indexOf('older.db');
      const newerIdx = text.indexOf('newer.db');
      // newer should appear before older in descending sort
      expect(newerIdx).toBeLessThan(olderIdx);
    });
  });

  describe('restore_database', () => {
    it('rejects missing src_path', async () => {
      const result = await safeTool('restore_database', { confirm: true });
      expect(result.isError).toBe(true);
    });

    it('rejects without confirm flag', async () => {
      const result = await safeTool('restore_database', { src_path: '/some/path.db' });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('confirm');
    });

    it('rejects with confirm set to false', async () => {
      const result = await safeTool('restore_database', { src_path: '/some/path.db', confirm: false });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('confirm');
    });

    it('rejects nonexistent backup file', async () => {
      const result = await safeTool('restore_database', { src_path: path.join(testDir, 'nonexistent-backup.db'), confirm: true });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('not found');
    });

    it('restores from a valid backup', async () => {
      const backupPath = path.join(testDir, 'restore-test.db');
      await safeTool('backup_database', { dest_path: backupPath });
      const result = await safeTool('restore_database', { src_path: backupPath, confirm: true });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Restored');
    });

    it('includes restore timestamp and warning in output', async () => {
      const backupPath = path.join(testDir, 'restore-ts-test.db');
      await safeTool('backup_database', { dest_path: backupPath });
      const result = await safeTool('restore_database', { src_path: backupPath, confirm: true });
      const text = getText(result);
      expect(text).toContain('From:');
      expect(text).toContain('At:');
      expect(text).toContain('Warning');
    });
  });
});
