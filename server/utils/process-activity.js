'use strict';

const childProcess = require('child_process');

const ACTIVITY_THRESHOLD_PERCENT = 5.0;
const CACHE_TTL_MS = 2000;
const EXEC_OPTIONS = Object.freeze({
  encoding: 'utf8',
  timeout: 5000,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const activityCache = new Map();
const optionalCpuModules = {
  loaded: false,
  pidtree: null,
  pidusage: null,
};

let windowsProcessCpuQuerySupported = null;
let windowsPerfCpuQuerySupported = null;

function createActivityResult(totalCpu, processCount, isActive) {
  const normalizedCpu = Number.isFinite(totalCpu) ? Number(totalCpu.toFixed(2)) : 0;
  return {
    totalCpu: normalizedCpu,
    totalCpuPercent: normalizedCpu,
    processCount: Number.isInteger(processCount) && processCount > 0 ? processCount : 0,
    isActive: Boolean(isActive),
  };
}

function createEmptyResult() {
  return createActivityResult(0, 0, false);
}

function normalizePid(pid) {
  const parsed = Number.parseInt(String(pid), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isProcessAlive(pid) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseCpuPercent(value) {
  if (value === null || value === undefined) return 0;
  const parsed = Number.parseFloat(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsvRows(output) {
  const lines = String(output || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(',').map((cell) => cell.trim());

  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((cell) => cell.trim());
    const row = {};

    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index]] = cells[index] || '';
    }

    return row;
  });
}

function parsePsRows(output) {
  const lines = String(output || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  return lines.slice(1)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;

      const pid = normalizePid(match[1]);
      if (!pid) return null;

      return {
        pid,
        cpu: parseCpuPercent(match[2]),
      };
    })
    .filter(Boolean);
}

function runCommand(command, args) {
  return childProcess.execFileSync(command, args, EXEC_OPTIONS);
}

function loadOptionalCpuModules() {
  if (optionalCpuModules.loaded) {
    return optionalCpuModules;
  }

  optionalCpuModules.loaded = true;

  try {
    optionalCpuModules.pidtree = require('pidtree');
  } catch {
    optionalCpuModules.pidtree = null;
  }

  try {
    optionalCpuModules.pidusage = require('pidusage');
  } catch {
    optionalCpuModules.pidusage = null;
  }

  return optionalCpuModules;
}

function tryOptionalDependencyProcessTree(rootPid) {
  const { pidtree, pidusage } = loadOptionalCpuModules();
  if (!pidtree || !pidusage || typeof pidtree.sync !== 'function' || typeof pidusage.sync !== 'function') {
    return null;
  }

  try {
    const processIds = [rootPid, ...pidtree.sync(rootPid, { root: false })]
      .map((pid) => normalizePid(pid))
      .filter(Boolean);

    if (!processIds.length) {
      return createEmptyResult();
    }

    let totalCpu = 0;
    for (const pid of processIds) {
      const usage = pidusage.sync(pid);
      totalCpu += parseCpuPercent(usage && usage.cpu);
    }

    return createActivityResult(totalCpu, processIds.length, totalCpu > ACTIVITY_THRESHOLD_PERCENT);
  } catch {
    return null;
  }
}

function tryWindowsCpuQuery(whereClause) {
  if (windowsProcessCpuQuerySupported === false) {
    return null;
  }

  try {
    const rows = parseCsvRows(runCommand('wmic', [
      'process',
      'where',
      whereClause,
      'get',
      'ProcessId,PercentProcessorTime',
      '/FORMAT:CSV',
    ]));

    windowsProcessCpuQuerySupported = true;

    return rows
      .map((row) => {
        const pid = normalizePid(row.ProcessId);
        if (!pid) return null;

        return {
          pid,
          cpu: parseCpuPercent(row.PercentProcessorTime),
        };
      })
      .filter(Boolean);
  } catch {
    windowsProcessCpuQuerySupported = false;
    return null;
  }
}

function queryWindowsProcessExists(pid) {
  const rows = parseCsvRows(runCommand('wmic', [
    'process',
    'where',
    `ProcessId=${pid}`,
    'get',
    'ProcessId',
    '/FORMAT:CSV',
  ]));

  return rows.some((row) => normalizePid(row.ProcessId) === pid);
}

function listWindowsChildIds(pid) {
  const rows = parseCsvRows(runCommand('wmic', [
    'process',
    'where',
    `ParentProcessId=${pid}`,
    'get',
    'ProcessId',
    '/FORMAT:CSV',
  ]));

  return rows
    .map((row) => normalizePid(row.ProcessId))
    .filter(Boolean);
}

function getWindowsProcessSnapshot() {
  const childrenByParent = new Map();
  const knownPids = new Set();
  const rows = parseCsvRows(runCommand('wmic', [
    'process',
    'get',
    'ProcessId,ParentProcessId',
    '/FORMAT:CSV',
  ]));

  for (const row of rows) {
    const pid = normalizePid(row.ProcessId);
    if (!pid) {
      continue;
    }

    const parentPid = normalizePid(row.ParentProcessId) || 0;
    knownPids.add(pid);

    if (!childrenByParent.has(parentPid)) {
      childrenByParent.set(parentPid, []);
    }

    childrenByParent.get(parentPid).push(pid);
  }

  return { childrenByParent, knownPids };
}

function getWindowsPerfCpuMap(pids) {
  const cpuMap = new Map();
  if (!pids.length || windowsPerfCpuQuerySupported === false) {
    return cpuMap;
  }

  try {
    const rows = parseCsvRows(runCommand('wmic', [
      'path',
      'Win32_PerfFormattedData_PerfProc_Process',
      'get',
      'IDProcess,PercentProcessorTime',
      '/FORMAT:CSV',
    ]));

    windowsPerfCpuQuerySupported = true;
    const wanted = new Set(pids);

    for (const row of rows) {
      const pid = normalizePid(row.IDProcess);
      if (!pid || !wanted.has(pid)) {
        continue;
      }

      cpuMap.set(pid, parseCpuPercent(row.PercentProcessorTime));
    }

    return cpuMap;
  } catch {
    windowsPerfCpuQuerySupported = false;
    return cpuMap;
  }
}

function collectWindowsProcessTree(rootPid) {
  const processIds = new Set();
  const cpuByPid = new Map();
  const rootRows = tryWindowsCpuQuery(`ProcessId=${rootPid}`);
  const windowsSnapshot = rootRows === null ? getWindowsProcessSnapshot() : null;

  if (Array.isArray(rootRows)) {
    const rootRecord = rootRows.find((record) => record.pid === rootPid);
    if (!rootRecord) {
      return { processIds, cpuByPid };
    }

    processIds.add(rootPid);
    cpuByPid.set(rootPid, rootRecord.cpu);
  } else if (windowsSnapshot.knownPids.has(rootPid) || queryWindowsProcessExists(rootPid)) {
    processIds.add(rootPid);
  } else {
    return { processIds, cpuByPid };
  }

  const queue = [rootPid];
  while (queue.length > 0) {
    const parentPid = queue.shift();
    let childRecords;

    if (windowsSnapshot) {
      childRecords = (windowsSnapshot.childrenByParent.get(parentPid) || [])
        .map((pid) => ({ pid, cpu: null }));
    } else {
      const childRows = tryWindowsCpuQuery(`ParentProcessId=${parentPid}`);
      childRecords = Array.isArray(childRows)
        ? childRows
        : listWindowsChildIds(parentPid).map((pid) => ({ pid, cpu: null }));
    }

    for (const child of childRecords) {
      if (!child || processIds.has(child.pid)) {
        continue;
      }

      processIds.add(child.pid);
      if (child.cpu !== null && child.cpu !== undefined) {
        cpuByPid.set(child.pid, child.cpu);
      }
      queue.push(child.pid);
    }
  }

  if (cpuByPid.size < processIds.size) {
    const perfCpuMap = getWindowsPerfCpuMap([...processIds]);
    for (const pid of processIds) {
      if (!cpuByPid.has(pid)) {
        cpuByPid.set(pid, perfCpuMap.get(pid) || 0);
      }
    }
  }

  return { processIds, cpuByPid };
}

function getPosixProcessRecord(pid) {
  const rows = parsePsRows(runCommand('ps', ['-o', 'pid,%cpu', '-p', String(pid)]));
  return rows.find((row) => row.pid === pid) || null;
}

function getPosixChildRecords(pid) {
  return parsePsRows(runCommand('ps', ['-o', 'pid,%cpu', '--ppid', String(pid)]));
}

function collectPosixProcessTree(rootPid) {
  const processIds = new Set();
  const cpuByPid = new Map();
  const rootRecord = getPosixProcessRecord(rootPid);

  if (!rootRecord) {
    return { processIds, cpuByPid };
  }

  processIds.add(rootPid);
  cpuByPid.set(rootPid, rootRecord.cpu);

  const queue = [rootPid];
  while (queue.length > 0) {
    const parentPid = queue.shift();
    const childRecords = getPosixChildRecords(parentPid);

    for (const child of childRecords) {
      if (!child || processIds.has(child.pid)) {
        continue;
      }

      processIds.add(child.pid);
      cpuByPid.set(child.pid, child.cpu);
      queue.push(child.pid);
    }
  }

  return { processIds, cpuByPid };
}

function buildActivityResult(processIds, cpuByPid) {
  if (!processIds.size) {
    return createEmptyResult();
  }

  let totalCpuPercent = 0;
  for (const pid of processIds) {
    totalCpuPercent += cpuByPid.get(pid) || 0;
  }

  totalCpuPercent = Number(totalCpuPercent.toFixed(2));

  return createActivityResult(
    totalCpuPercent,
    processIds.size,
    totalCpuPercent > ACTIVITY_THRESHOLD_PERCENT
  );
}

function buildAliveFallbackResult(pid) {
  if (!isProcessAlive(pid)) {
    return createEmptyResult();
  }

  return createActivityResult(0, 1, true);
}

function getProcessTreeCpu(pid) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) {
    return createEmptyResult();
  }

  const now = Date.now();
  const cached = activityCache.get(normalizedPid);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.result;
  }

  let result = tryOptionalDependencyProcessTree(normalizedPid);

  if (!result) {
    try {
      const { processIds, cpuByPid } = process.platform === 'win32'
        ? collectWindowsProcessTree(normalizedPid)
        : collectPosixProcessTree(normalizedPid);
      result = buildActivityResult(processIds, cpuByPid);
    } catch {
      result = null;
    }
  }

  if (!result || (!result.isActive && result.processCount === 0)) {
    result = buildAliveFallbackResult(normalizedPid);
  }

  activityCache.set(normalizedPid, {
    result,
    timestamp: Date.now(),
  });

  return result;
}

function clearActivityCache() {
  activityCache.clear();
  windowsProcessCpuQuerySupported = null;
  windowsPerfCpuQuerySupported = null;
  optionalCpuModules.loaded = false;
  optionalCpuModules.pidtree = null;
  optionalCpuModules.pidusage = null;
}

module.exports = {
  createEmptyResult,
  normalizePid,
  isProcessAlive,
  parseCpuPercent,
  parseCsvRows,
  parsePsRows,
  runCommand,
  tryWindowsCpuQuery,
  queryWindowsProcessExists,
  listWindowsChildIds,
  getWindowsProcessSnapshot,
  getWindowsPerfCpuMap,
  collectWindowsProcessTree,
  getPosixProcessRecord,
  getPosixChildRecords,
  collectPosixProcessTree,
  getProcessTreeCpu,
  clearActivityCache,
};
