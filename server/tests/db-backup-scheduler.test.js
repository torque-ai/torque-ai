const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { setupTestDb, teardownTestDb } = require('./vitest-setup');

const TEMPLATE_BUF = path.join(os.tmpdir(), 'torque-vitest-template', 'template.db.buf');

describe('Database backup scheduler', () => {
  let db;
  let testDir;
  let templateBuffer;
  let backupDataDir;

  beforeAll(() => {
    const context = setupTestDb('db-backup-scheduler');
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
  });

  afterEach(async () => {
    db.stopBackupScheduler();
    await vi.runOnlyPendingTimersAsync();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();

    if (backupDataDir && fs.existsSync(backupDataDir)) {
      fs.rmSync(backupDataDir, { recursive: true, force: true });
    }
    process.env.TORQUE_DATA_DIR = testDir;
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
      .filter((name) => name.startsWith('torque-') && name.endsWith('.db'));
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
    db.init();
    db.stopBackupScheduler();
    db.setConfig('backup_interval_minutes', '0');
    db.close();

    vi.clearAllTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    db.init();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await advance(5000);

    expect(listBackups()).toHaveLength(0);
  });
});
