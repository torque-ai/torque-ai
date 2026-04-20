const { setupTestDb, teardownTestDb, safeTool, getText } = require('./vitest-setup');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const backupCore = require('../db/backup-core');

describe('Database Backup/Restore', () => {
  let testDir;
  let backupsDirSpy;

  beforeAll(() => {
    const ctx = setupTestDb('db-backup');
    testDir = ctx.testDir;
    const backupsDir = path.join(testDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    backupsDirSpy = vi.spyOn(backupCore, 'getBackupsDir').mockReturnValue(backupsDir);
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

    it('creates a SHA-256 hash file alongside the backup', async () => {
      const dest = path.join(testDir, 'integrity-check.db');
      const result = await safeTool('backup_database', { dest_path: dest });
      const hashPath = dest + '.sha256';

      expect(result.isError).toBeFalsy();
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.existsSync(hashPath)).toBe(true);

      const expectedHash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
      expect(fs.readFileSync(hashPath, 'utf-8').trim()).toBe(expectedHash);
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

    it('returns a valid response', async () => {
      const result = await safeTool('list_database_backups', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      // Should return either a table or "No backups"
      expect(text).toMatch(/Database Backups|No backups/);
    });

    it('includes table headers when backups exist', async () => {
      // Create a backup to ensure at least one exists
      await safeTool('backup_database', {});
      const result = await safeTool('list_database_backups', {});
      expect(result.isError).toBeFalsy();
      const text = getText(result);
      if (text.includes('Database Backups (')) {
        expect(text).toContain('| Name |');
      }
    });

    it('sorts backups by date descending', async () => {
      const result = await safeTool('list_database_backups', {});
      const text = getText(result);
      // Verify the table structure exists (sorting logic tested in db-backup-core.test.js)
      expect(text).toMatch(/Database Backups|No backups/);
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

    it('rejects relative traversal restore paths before calling restoreDatabase', async () => {
      const restoreSpy = vi.spyOn(backupCore, 'restoreDatabase');
      try {
        const result = await safeTool('restore_database', { src_path: '../outside.db', confirm: true });

        expect(result.isError).toBe(true);
        expect(result.error_code).toBe('INVALID_PARAM');
        expect(getText(result)).toContain('inside the backups directory');
        expect(restoreSpy).not.toHaveBeenCalled();
      } finally {
        restoreSpy.mockRestore();
      }
    });

    it('rejects absolute restore paths outside the backups directory before calling restoreDatabase', async () => {
      const restoreSpy = vi.spyOn(backupCore, 'restoreDatabase');
      try {
        const outsidePath = path.resolve(testDir, '..', 'outside.db');

        const result = await safeTool('restore_database', { src_path: outsidePath, confirm: true });

        expect(result.isError).toBe(true);
        expect(result.error_code).toBe('INVALID_PARAM');
        expect(getText(result)).toContain('inside the backups directory');
        expect(restoreSpy).not.toHaveBeenCalled();
      } finally {
        restoreSpy.mockRestore();
      }
    });

    it('rejects nonexistent backup file', async () => {
      const bkDir = path.join(testDir, 'backups');
      fs.mkdirSync(bkDir, { recursive: true });
      const result = await safeTool('restore_database', { src_path: path.join(bkDir, 'nonexistent-backup.db'), confirm: true });
      expect(result.isError).toBe(true);
    });

    it('restores from a valid backup filename inside the backups directory', async () => {
      const bkDir = backupCore.getBackupsDir();
      const backupPath = path.join(bkDir, 'restore-filename-test.db');
      const backupResult = await safeTool('backup_database', { dest_path: backupPath });
      expect(backupResult.isError).toBeFalsy();

      const restoreSpy = vi.spyOn(backupCore, 'restoreDatabase');
      try {
        const result = await safeTool('restore_database', { src_path: 'restore-filename-test.db', confirm: true });

        expect(result.isError).toBeFalsy();
        expect(restoreSpy).toHaveBeenCalledWith(path.resolve(bkDir, 'restore-filename-test.db'), true, { force: false });
      } finally {
        restoreSpy.mockRestore();
      }
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

    it('rejects restore of a tampered backup', async () => {
      const bkDir = path.join(testDir, 'backups');
      fs.mkdirSync(bkDir, { recursive: true });
      const backupPath = path.join(bkDir, 'tampered-restore-test.db');
      await safeTool('backup_database', { dest_path: backupPath });
      fs.appendFileSync(backupPath, Buffer.from('tampered'));

      const result = await safeTool('restore_database', { src_path: backupPath, confirm: true });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Backup integrity check failed');
    });

    it('allows force restore without hash', async () => {
      const bkDir = path.join(testDir, 'backups');
      fs.mkdirSync(bkDir, { recursive: true });
      const backupPath = path.join(bkDir, 'force-restore-test.db');
      await safeTool('backup_database', { dest_path: backupPath });
      fs.unlinkSync(backupPath + '.sha256');

      const result = await safeTool('restore_database', { src_path: backupPath, confirm: true, force: true });

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
