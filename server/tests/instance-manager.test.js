/**
 * Unit Tests: coordination/instance-manager.js
 *
 * Tests multi-session instance registration, heartbeat, lifecycle.
 */

describe('Instance Manager', () => {
  let instanceManager;
  let mockDb;

  beforeEach(() => {
    delete require.cache[require.resolve('../coordination/instance-manager')];
    instanceManager = require('../coordination/instance-manager');

    mockDb = {
      acquireLock: vi.fn().mockReturnValue({ acquired: true }),
      releaseLock: vi.fn(),
      checkLock: vi.fn().mockReturnValue({ held: false }),
      updateLockHeartbeat: vi.fn(),
      isLockHeartbeatStale: vi.fn().mockReturnValue({ isStale: false, lastHeartbeat: Date.now() }),
    };

    instanceManager.init({
      db: mockDb,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      instanceId: 'test-instance-abc',
    });
  });

  afterEach(() => {
    instanceManager.stopInstanceHeartbeat();
    vi.restoreAllMocks();
  });

  // ── getMcpInstanceId ──────────────────────────────────────

  describe('getMcpInstanceId', () => {
    it('returns the instance ID passed to init', () => {
      expect(instanceManager.getMcpInstanceId()).toBe('test-instance-abc');
    });
  });

  // ── registerInstance ──────────────────────────────────────

  describe('registerInstance', () => {
    it('acquires lock with instance lock name and holder ID', () => {
      const result = instanceManager.registerInstance();
      expect(result.acquired).toBe(true);
      expect(mockDb.acquireLock).toHaveBeenCalledWith(
        'mcp_instance:test-instance-abc',
        'test-instance-abc',
        60,
        expect.stringContaining('"pid"')
      );
    });

    it('returns { acquired: false } when lock acquisition fails', () => {
      mockDb.acquireLock.mockImplementation(() => { throw new Error('DB locked'); });
      const result = instanceManager.registerInstance();
      expect(result.acquired).toBe(false);
    });

    it('includes PID and startedAt in holder info', () => {
      instanceManager.registerInstance();
      const holderInfo = JSON.parse(mockDb.acquireLock.mock.calls[0][3]);
      expect(holderInfo.pid).toBe(process.pid);
      expect(holderInfo.startedAt).toBeDefined();
    });
  });

  // ── heartbeatInstance ─────────────────────────────────────

  describe('heartbeatInstance', () => {
    it('re-acquires lock and updates heartbeat', () => {
      instanceManager.heartbeatInstance();
      expect(mockDb.acquireLock).toHaveBeenCalledWith(
        'mcp_instance:test-instance-abc',
        'test-instance-abc',
        60
      );
      expect(mockDb.updateLockHeartbeat).toHaveBeenCalledWith(
        'mcp_instance:test-instance-abc',
        'test-instance-abc'
      );
    });

    it('swallows errors silently (shutdown safety)', () => {
      mockDb.acquireLock.mockImplementation(() => { throw new Error('DB closed'); });
      expect(() => instanceManager.heartbeatInstance()).not.toThrow();
    });
  });

  // ── startInstanceHeartbeat / stopInstanceHeartbeat ────────

  describe('startInstanceHeartbeat / stopInstanceHeartbeat', () => {
    it('calls unref() on the heartbeat interval handle', () => {
      const heartbeatInterval = { unref: vi.fn() };
      const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(heartbeatInterval);
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      instanceManager.startInstanceHeartbeat();
      instanceManager.stopInstanceHeartbeat();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(heartbeatInterval.unref).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).toHaveBeenCalledWith(heartbeatInterval);
    });

    it('starts a single interval on first start', () => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      instanceManager.startInstanceHeartbeat();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).not.toHaveBeenCalled();

      instanceManager.stopInstanceHeartbeat();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('does not create duplicate active intervals when start is called twice', () => {
      const intervalCallbacks = [];
      const firstInterval = { unref: vi.fn() };
      const secondInterval = { unref: vi.fn() };
      const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation((callback) => {
        intervalCallbacks.push(callback);
        return intervalCallbacks.length === 1 ? firstInterval : secondInterval;
      });
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      instanceManager.startInstanceHeartbeat();
      instanceManager.startInstanceHeartbeat();

      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).toHaveBeenCalledWith(firstInterval);
      expect(firstInterval.unref).toHaveBeenCalledTimes(1);
      expect(secondInterval.unref).toHaveBeenCalledTimes(1);

      expect(intervalCallbacks).toHaveLength(2);
      intervalCallbacks[1]();
      expect(mockDb.acquireLock).toHaveBeenCalled();
      expect(mockDb.updateLockHeartbeat).toHaveBeenCalled();

      instanceManager.stopInstanceHeartbeat();
    });

    it('calls heartbeat on interval ticks while running', () => {
      vi.useFakeTimers();
      instanceManager.startInstanceHeartbeat();

      vi.advanceTimersByTime(10000);
      expect(mockDb.acquireLock).toHaveBeenCalledTimes(1);
      expect(mockDb.updateLockHeartbeat).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10000);
      expect(mockDb.acquireLock).toHaveBeenCalledTimes(2);

      instanceManager.stopInstanceHeartbeat();
      vi.useRealTimers();
    });

    it('stops and clears the interval', () => {
      vi.useFakeTimers();
      const heartbeatInterval = { unref: vi.fn() };
      vi.spyOn(global, 'setInterval').mockReturnValue(heartbeatInterval);
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      instanceManager.startInstanceHeartbeat();
      instanceManager.stopInstanceHeartbeat();

      expect(clearIntervalSpy).toHaveBeenCalledWith(heartbeatInterval);
      mockDb.acquireLock.mockClear();
      vi.advanceTimersByTime(30000);
      expect(mockDb.acquireLock).not.toHaveBeenCalled();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('is idempotent when stopped multiple times', () => {
      vi.useFakeTimers();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      instanceManager.startInstanceHeartbeat();
      expect(() => {
        instanceManager.stopInstanceHeartbeat();
        instanceManager.stopInstanceHeartbeat();
      }).not.toThrow();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('does not start heartbeat if dependencies are not initialized', () => {
      const uninitializedManager = require('../coordination/instance-manager');
      const uninitDb = {
        acquireLock: vi.fn().mockReturnValue({ acquired: true }),
        releaseLock: vi.fn(),
        checkLock: vi.fn().mockReturnValue({ held: false }),
        updateLockHeartbeat: vi.fn(),
        isLockHeartbeatStale: vi.fn().mockReturnValue({ isStale: false, lastHeartbeat: Date.now() }),
      };
      const uninitLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      vi.useFakeTimers();

      expect(() => uninitializedManager.startInstanceHeartbeat()).not.toThrow();
      expect(setIntervalSpy).not.toHaveBeenCalled();

      uninitializedManager.init({
        db: uninitDb,
        logger: uninitLogger,
        instanceId: 'late-init-instance',
      });

      vi.advanceTimersByTime(10000);
      expect(uninitDb.acquireLock).not.toHaveBeenCalled();
      expect(uninitDb.updateLockHeartbeat).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('single init starts one interval and does not create extras on re-init', () => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      const secondDb = {
        acquireLock: vi.fn().mockReturnValue({ acquired: true }),
        releaseLock: vi.fn(),
        checkLock: vi.fn().mockReturnValue({ held: false }),
        updateLockHeartbeat: vi.fn(),
        isLockHeartbeatStale: vi.fn().mockReturnValue({ isStale: false, lastHeartbeat: Date.now() }),
      };
      const secondLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      instanceManager.startInstanceHeartbeat();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      instanceManager.init({
        db: secondDb,
        logger: secondLogger,
        instanceId: 'reinit-instance',
      });

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(20000);
      expect(mockDb.acquireLock).not.toHaveBeenCalled();
      expect(secondDb.acquireLock).not.toHaveBeenCalled();
      expect(mockDb.updateLockHeartbeat).not.toHaveBeenCalled();
      expect(secondDb.updateLockHeartbeat).not.toHaveBeenCalled();

      instanceManager.stopInstanceHeartbeat();
      vi.useRealTimers();
    });

    it('start can be called again after stop to create a new interval', () => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      instanceManager.startInstanceHeartbeat();
      instanceManager.stopInstanceHeartbeat();
      setIntervalSpy.mockClear();
      instanceManager.startInstanceHeartbeat();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10000);
      expect(mockDb.acquireLock).toHaveBeenCalledTimes(1);
      instanceManager.stopInstanceHeartbeat();
      vi.useRealTimers();
    });

    it('calling init twice does not leave a stale heartbeat interval', () => {
      const reinitManager = require('../coordination/instance-manager');
      const reinitDb1 = {
        acquireLock: vi.fn().mockReturnValue({ acquired: true }),
        releaseLock: vi.fn(),
        checkLock: vi.fn().mockReturnValue({ held: false }),
        updateLockHeartbeat: vi.fn(),
        isLockHeartbeatStale: vi.fn().mockReturnValue({ isStale: false, lastHeartbeat: Date.now() }),
      };
      const reinitLogger1 = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const reinitDb2 = {
        acquireLock: vi.fn().mockReturnValue({ acquired: true }),
        releaseLock: vi.fn(),
        checkLock: vi.fn().mockReturnValue({ held: false }),
        updateLockHeartbeat: vi.fn(),
        isLockHeartbeatStale: vi.fn().mockReturnValue({ isStale: false, lastHeartbeat: Date.now() }),
      };
      const reinitLogger2 = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      vi.useFakeTimers();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      reinitManager.init({
        db: reinitDb1,
        logger: reinitLogger1,
        instanceId: 'test-instance-abc',
      });
      reinitManager.startInstanceHeartbeat();

      reinitManager.init({
        db: reinitDb2,
        logger: reinitLogger2,
        instanceId: 'test-instance-def',
      });

      vi.advanceTimersByTime(10000);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(reinitDb1.acquireLock).toHaveBeenCalledTimes(0);
      expect(reinitDb2.acquireLock).toHaveBeenCalledTimes(0);

      reinitManager.stopInstanceHeartbeat();
      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  // ── unregisterInstance ────────────────────────────────────

  describe('unregisterInstance', () => {
    it('registers and unregisters an instance as a complete lifecycle', () => {
      const heartbeatInterval = { unref: vi.fn() };
      vi.spyOn(global, 'setInterval').mockReturnValue(heartbeatInterval);
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const result = instanceManager.registerInstance();
      instanceManager.startInstanceHeartbeat();
      instanceManager.unregisterInstance();

      expect(result.acquired).toBe(true);
      expect(mockDb.releaseLock).toHaveBeenCalledWith(
        'mcp_instance:test-instance-abc',
        'test-instance-abc'
      );
      expect(clearIntervalSpy).toHaveBeenCalledWith(heartbeatInterval);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it('releases the lock and stops heartbeat', () => {
      vi.useFakeTimers();
      instanceManager.startInstanceHeartbeat();
      instanceManager.unregisterInstance();

      expect(mockDb.releaseLock).toHaveBeenCalledWith(
        'mcp_instance:test-instance-abc',
        'test-instance-abc'
      );

      // Heartbeat should be stopped — no more calls
      mockDb.acquireLock.mockClear();
      vi.advanceTimersByTime(20000);
      expect(mockDb.acquireLock).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('swallows errors if DB is already closed', () => {
      mockDb.releaseLock.mockImplementation(() => { throw new Error('DB closed'); });
      expect(() => instanceManager.unregisterInstance()).not.toThrow();
    });
  });

  // ── updateInstanceInfo ────────────────────────────────────

  describe('updateInstanceInfo', () => {
    it('merges new fields into existing holder info', () => {
      mockDb.checkLock.mockReturnValue({
        held: true,
        holderInfo: JSON.stringify({ pid: 1234, startedAt: '2025-01-01' }),
      });

      instanceManager.updateInstanceInfo({ port: 3457 });

      const lastCall = mockDb.acquireLock.mock.calls[mockDb.acquireLock.mock.calls.length - 1];
      const holderInfo = JSON.parse(lastCall[3]);
      expect(holderInfo.pid).toBe(1234);
      expect(holderInfo.port).toBe(3457);
      expect(holderInfo.startedAt).toBe('2025-01-01');
    });

    it('handles missing holderInfo gracefully', () => {
      mockDb.checkLock.mockReturnValue({ held: false });
      instanceManager.updateInstanceInfo({ port: 3457 });

      const lastCall = mockDb.acquireLock.mock.calls[mockDb.acquireLock.mock.calls.length - 1];
      const holderInfo = JSON.parse(lastCall[3]);
      expect(holderInfo.port).toBe(3457);
    });

    it('handles corrupted holderInfo JSON', () => {
      mockDb.checkLock.mockReturnValue({ held: true, holderInfo: 'not-json' });
      expect(() => instanceManager.updateInstanceInfo({ port: 3457 })).not.toThrow();
    });
  });

  // ── isInstanceAlive ───────────────────────────────────────

  describe('isInstanceAlive', () => {
    it('returns true when heartbeat is fresh', () => {
      mockDb.isLockHeartbeatStale.mockReturnValue({
        isStale: false,
        lastHeartbeat: Date.now(),
      });
      expect(instanceManager.isInstanceAlive('some-instance')).toBe(true);
    });

    it('returns false when heartbeat is stale', () => {
      mockDb.isLockHeartbeatStale.mockReturnValue({
        isStale: true,
        lastHeartbeat: Date.now() - 60000,
      });
      expect(instanceManager.isInstanceAlive('some-instance')).toBe(false);
    });

    it('returns false when no lock found (lastHeartbeat undefined)', () => {
      mockDb.isLockHeartbeatStale.mockReturnValue({
        isStale: false,
        lastHeartbeat: undefined,
      });
      expect(instanceManager.isInstanceAlive('unknown')).toBe(false);
    });

    it('returns false when DB throws', () => {
      mockDb.isLockHeartbeatStale.mockImplementation(() => { throw new Error('DB error'); });
      expect(instanceManager.isInstanceAlive('crash')).toBe(false);
    });

    it('uses correct lock name format: mcp_instance:{id}', () => {
      instanceManager.isInstanceAlive('test-id-xyz');
      expect(mockDb.isLockHeartbeatStale).toHaveBeenCalledWith(
        'mcp_instance:test-id-xyz',
        30000
      );
    });
  });
});
