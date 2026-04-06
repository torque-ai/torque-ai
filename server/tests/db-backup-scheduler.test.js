const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const backupCore = require('../db/backup-core');
const dataDir = require('../data-dir');

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');
const PERIODIC_BACKUP_PATTERN = /^torque-\d{4}-\d{2}-\d{2}T.*\.db$/;

describe('Database backup scheduler', () => {
  let db;
  let testDir;
  let templateBuffer;
  let backupDataDir;

  beforeAll(() => {
    const context = setupTestDbOnly('db-backup-scheduler');
    db = context.db;
    testDir = context.testDir;
    templateBuffer = fs.readFileSync(TEMPLATE_BUF);
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    db.stopBackupScheduler();
    db.resetForTest(templateBuffer);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    backupDataDir = path.join(testDir, `backup-scheduler-${randomUUID()}`);
    process.env.TORQUE_DATA_DIR = backupDataDir;
    fs.mkdirSync(backupDataDir, { recursive: true });
    // Reset data-dir cache so getDataDir() re-resolves from the new TORQUE_DATA_DIR
    dataDir.setDataDir(null);
  });

  afterEach(async () => {
    db.stopBackupScheduler();
    await vi.runOnlyPendingTimersAsync();
    vi.clearAllTimers();
    try {
      db.close();
    } catch {
      // Some tests stay on the in-memory reset DB and some reopen a file DB.
    }
    vi.useRealTimers();
    vi.restoreAllMocks();

    if (backupDataDir && fs.existsSync(backupDataDir)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      fs.rmSync(backupDataDir, { recursive: true, force: true });
    }
    process.env.TORQUE_DATA_DIR = testDir;
    dataDir.setDataDir(null);
    backupDataDir = null;
  });

  const advance = async (ms) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  const listBackups = () => {
    const backupDir = path.join(backupDataDir, 'backups');
    if (!fs.existsSync(backupDir)) {
      return [];
    }
    return fs.readdirSync(backupDir)
      .filter((name) => PERIODIC_BACKUP_PATTERN.test(name));
  };

  it('creates backup files on a schedule', async () => {
    db.startBackupScheduler(5);
    await advance(15);

    expect(listBackups().length).toBeGreaterThanOrEqual(1);
  });

  it('cleans up backups beyond the configured maximum', async () => {
    db.setConfig('backup_max_count', '2');

    db.startBackupScheduler(1);
    await advance(25);

    expect(listBackups().length).toBeGreaterThan(0);
    expect(listBackups().length).toBeLessThanOrEqual(2);
  });

  it('stops creating backups when stopped', async () => {
    db.startBackupScheduler(5);
    await advance(10);

    const countBeforeStop = listBackups().length;
    expect(countBeforeStop).toBeGreaterThan(0);
    db.stopBackupScheduler();

    await advance(20);
    expect(listBackups().length).toBe(countBeforeStop);
  });

  it('does not auto-start when backup_interval_minutes is 0', async () => {
    db.close();
    db.init();
    db.stopBackupScheduler();
    db.setConfig('backup_interval_minutes', '0');
    db.close();

    vi.clearAllTimers();
    const startBackupSchedulerSpy = vi.spyOn(backupCore, 'startBackupScheduler');
    db.init();
    expect(startBackupSchedulerSpy).not.toHaveBeenCalled();

    await advance(5000);

    expect(listBackups()).toHaveLength(0);
  });
});
