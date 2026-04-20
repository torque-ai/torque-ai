'use strict';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveLaunchAdapter(adapter) {
  if (!adapter) return null;
  if (
    typeof adapter.launchProcess === 'function'
    || typeof adapter.process === 'function'
    || typeof adapter.discoverProjects === 'function'
    || typeof adapter.projects === 'function'
    || typeof adapter.openUrl === 'function'
    || typeof adapter['open-url'] === 'function'
  ) {
    return adapter;
  }
  return adapter.adapter || null;
}

function normalizeObjectBody(body, message) {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) {
    throw createHttpError(400, message);
  }
  return { ...body };
}

function normalizeLaunchResult(result) {
  if (result === undefined || result === null) {
    return { success: true };
  }

  if (!isPlainObject(result)) {
    return {
      success: true,
      result,
    };
  }

  return {
    success: result.success !== false,
    ...result,
  };
}

function normalizeProjectsResult(result) {
  if (Array.isArray(result)) {
    return {
      success: true,
      projects: result,
    };
  }

  if (!isPlainObject(result)) {
    return {
      success: true,
      projects: [],
    };
  }

  return {
    success: result.success !== false,
    ...result,
    projects: Array.isArray(result.projects) ? result.projects : [],
  };
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createHttpError(400, 'url is required');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw createHttpError(400, `url must be an absolute URL: ${value}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createHttpError(400, 'url must use http:// or https://');
  }

  return parsed.toString();
}

function getLaunchProcessMethod(launchAdapter) {
  if (!launchAdapter) return null;
  if (typeof launchAdapter.launchProcess === 'function') return 'launchProcess';
  if (typeof launchAdapter.process === 'function') return 'process';
  return null;
}

function getDiscoverProjectsMethod(launchAdapter) {
  if (!launchAdapter) return null;
  if (typeof launchAdapter.discoverProjects === 'function') return 'discoverProjects';
  if (typeof launchAdapter.projects === 'function') return 'projects';
  return null;
}

function getOpenUrlMethod(launchAdapter) {
  if (!launchAdapter) return null;
  if (typeof launchAdapter.openUrl === 'function') return 'openUrl';
  if (typeof launchAdapter['open-url'] === 'function') return 'open-url';
  return null;
}

function createProcessHandler(adapter) {
  const launchAdapter = resolveLaunchAdapter(adapter);
  const method = getLaunchProcessMethod(launchAdapter);

  if (!launchAdapter || !method) {
    throw new TypeError('createProcessHandler requires an adapter with launchProcess(options)');
  }

  return async function handleProcess(ctx) {
    const body = normalizeObjectBody(ctx.body, 'Launch request body must be a JSON object');
    const result = await launchAdapter[method](body);
    return normalizeLaunchResult(result);
  };
}

function createProjectsHandler(adapter) {
  const launchAdapter = resolveLaunchAdapter(adapter);
  const method = getDiscoverProjectsMethod(launchAdapter);

  if (!launchAdapter || !method) {
    throw new TypeError('createProjectsHandler requires an adapter with discoverProjects(options)');
  }

  return async function handleProjects(ctx) {
    const result = await launchAdapter[method](ctx.query || {});
    return normalizeProjectsResult(result);
  };
}

function createOpenUrlHandler(adapter) {
  const launchAdapter = resolveLaunchAdapter(adapter);
  const method = getOpenUrlMethod(launchAdapter);

  if (!launchAdapter || !method) {
    throw new TypeError('createOpenUrlHandler requires an adapter with openUrl(options)');
  }

  return async function handleOpenUrl(ctx) {
    const body = normalizeObjectBody(ctx.body, 'Open URL request body must be a JSON object');
    const payload = {
      ...body,
      url: normalizeHttpUrl(body.url),
    };
    const result = await launchAdapter[method](payload);
    return normalizeLaunchResult(result);
  };
}

function createLaunchHandlers(adapter) {
  const launchAdapter = resolveLaunchAdapter(adapter);
  if (!launchAdapter) return {};

  const handlers = {};

  if (getLaunchProcessMethod(launchAdapter)) {
    const processHandler = createProcessHandler(launchAdapter);
    handlers.process = processHandler;
    handlers.launchProcess = processHandler;
  }

  if (getDiscoverProjectsMethod(launchAdapter)) {
    const projectsHandler = createProjectsHandler(launchAdapter);
    handlers.projects = projectsHandler;
    handlers.discoverProjects = projectsHandler;
  }

  if (getOpenUrlMethod(launchAdapter)) {
    const openUrlHandler = createOpenUrlHandler(launchAdapter);
    handlers.openUrl = openUrlHandler;
    handlers['open-url'] = openUrlHandler;
  }

  return handlers;
}

module.exports = {
  createLaunchHandlers,
  createOpenUrlHandler,
  createProcessHandler,
  createProjectsHandler,
  normalizeHttpUrl,
  normalizeLaunchResult,
  normalizeProjectsResult,
};
