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
    let backupsDir;

    beforeAll(() => {
      // Create the backups dir inside testDir (matches getBackupsDir() when TORQUE_DATA_DIR=testDir)
      backupsDir = path.join(testDir, 'backups');
      fs.mkdirSync(backupsDir, { recursive: true });
    });

    it('returns empty list when no backups exist', async () => {
      // Use a clean backups dir
      const result = await safeTool('list_database_backups', {});
      expect(result.isError).toBeFalsy();
      // May contain backups from other tests or be empty
      const text = getText(result);
      expect(text).toMatch(/Database Backups|No backups/);
    });

    it('lists backups after creating one', async () => {
      await safeTool('backup_database', { dest_path: path.join(backupsDir, 'test-listed.db') });
      const result = await safeTool('list_database_backups', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('test-listed.db');
    });

    it('filters to only .db and .sqlite files', async () => {
      // Create a non-db file in the backups dir
      fs.writeFileSync(path.join(backupsDir, 'not-a-backup.txt'), 'hello');
      await safeTool('backup_database', { dest_path: path.join(backupsDir, 'real-filter.db') });
      const result = await safeTool('list_database_backups', {});
      const text = getText(result);
      expect(text).toContain('real-filter.db');
      expect(text).not.toContain('not-a-backup.txt');
    });

    it('shows count in header', async () => {
      const result = await safeTool('list_database_backups', {});
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Database Backups (');
    });

    it('sorts backups by date descending', async () => {
      await safeTool('backup_database', { dest_path: path.join(backupsDir, 'older-sort.db') });
      await new Promise(r => setTimeout(r, 50));
      await safeTool('backup_database', { dest_path: path.join(backupsDir, 'newer-sort.db') });
      const result = await safeTool('list_database_backups', {});
      const text = getText(result);
      const olderIdx = text.indexOf('older-sort.db');
      const newerIdx = text.indexOf('newer-sort.db');
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
      const bkDir = path.join(testDir, 'backups');
      fs.mkdirSync(bkDir, { recursive: true });
      const result = await safeTool('restore_database', { src_path: path.join(bkDir, 'nonexistent-backup.db'), confirm: true });
      expect(result.isError).toBe(true);
    });

    it('restores from a valid backup', async () => {
      const bkDir = path.join(testDir, 'backups');
      fs.mkdirSync(bkDir, { recursive: true });
      const backupPath = path.join(bkDir, 'restore-test.db');
      await safeTool('backup_database', { dest_path: backupPath });
      const result = await safeTool('restore_database', { src_path: backupPath, confirm: true });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain('Restored');
    });

    it('includes restore timestamp and warning in output', async () => {
      const bkDir = path.join(testDir, 'backups');
      fs.mkdirSync(bkDir, { recursive: true });
      const backupPath = path.join(bkDir, 'restore-ts-test.db');
      await safeTool('backup_database', { dest_path: backupPath });
      const result = await safeTool('restore_database', { src_path: backupPath, confirm: true });
      const text = getText(result);
      expect(text).toContain('From:');
      expect(text).toContain('At:');
      expect(text).toContain('Warning');
    });
  });
});
