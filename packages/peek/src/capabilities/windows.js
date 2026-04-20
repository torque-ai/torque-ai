'use strict';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getQueryValue(query, name) {
  const value = query ? query[name] : undefined;
  if (Array.isArray(value)) return value.length === 0 ? undefined : value[value.length - 1];
  return value;
}

function normalizeNeedle(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim().toLowerCase();
}

function normalizeComparable(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().toLowerCase();
}

function matchesText(windowInfo, fields, needle) {
  if (!needle) return true;
  return fields.some((field) => normalizeComparable(windowInfo[field]).includes(needle));
}

function matchesExact(windowInfo, fields, needle) {
  if (!needle) return true;
  return fields.some((field) => normalizeComparable(windowInfo[field]) === needle);
}

function filterWindows(windows, query = {}) {
  const process = normalizeNeedle(getQueryValue(query, 'process'));
  const title = normalizeNeedle(getQueryValue(query, 'title') ?? getQueryValue(query, 'name'));
  const pid = normalizeNeedle(getQueryValue(query, 'pid'));
  const hwnd = normalizeNeedle(getQueryValue(query, 'hwnd'));
  const windowId = normalizeNeedle(getQueryValue(query, 'window_id') ?? getQueryValue(query, 'windowId') ?? getQueryValue(query, 'id'));

  return windows.filter((windowInfo) => {
    if (!isPlainObject(windowInfo)) return false;

    return matchesText(windowInfo, ['process', 'process_name', 'class_name'], process)
      && matchesText(windowInfo, ['title', 'window_title', 'name'], title)
      && matchesExact(windowInfo, ['pid'], pid)
      && matchesExact(windowInfo, ['hwnd'], hwnd)
      && matchesExact(windowInfo, ['window_id', 'id', 'hwnd'], windowId);
  });
}

function normalizeWindowsResult(result, query = {}) {
  const response = Array.isArray(result)
    ? { windows: result }
    : isPlainObject(result)
      ? { ...result, windows: Array.isArray(result.windows) ? result.windows : [] }
      : { windows: [] };

  return {
    ...response,
    windows: filterWindows(response.windows, query),
  };
}

function resolveWindowsAdapter(adapter) {
  if (!adapter) return null;
  if (typeof adapter.listWindows === 'function') return adapter;
  if (typeof adapter.list === 'function') return adapter;
  if (typeof adapter.windows === 'function') return adapter;
  return adapter.adapter || null;
}

function createWindowListHandler(adapter) {
  const windowsAdapter = resolveWindowsAdapter(adapter);

  if (!windowsAdapter || typeof windowsAdapter.listWindows !== 'function') {
    throw new TypeError('createWindowListHandler requires an adapter with listWindows(options)');
  }

  return async function handleWindowList(ctx) {
    const query = ctx.query || {};
    const result = await windowsAdapter.listWindows(query);
    return normalizeWindowsResult(result, query);
  };
}

function createWindowHandlers(adapter) {
  const windowsAdapter = resolveWindowsAdapter(adapter);
  if (!windowsAdapter || typeof windowsAdapter.listWindows !== 'function') return {};

  const handler = createWindowListHandler(windowsAdapter);
  return {
    list: handler,
    windows: handler,
    listWindows: handler,
  };
}

module.exports = {
  createWindowHandlers,
  createWindowListHandler,
  filterWindows,
  normalizeWindowsResult,
};
