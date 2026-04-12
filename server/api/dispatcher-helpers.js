'use strict';

/**
 * Coerce REST passthrough query/path-param values to the JSON-schema type declared by the tool.
 * Returns { ok: true, value } on success, { ok: false, error } on failure.
 */
function coerceRestPassthroughValue(toolSchema, key, value, source = 'param') {
  const propSchema = toolSchema?.properties?.[key];

  if (!propSchema || propSchema.type === 'string') {
    return { ok: true, value };
  }

  if (propSchema.type === 'integer') {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || String(n) !== String(value).trim()) {
      return { ok: false, error: `Invalid integer for ${source} '${key}': ${value}` };
    }
    return { ok: true, value: n };
  }

  if (propSchema.type === 'number') {
    const n = Number(value);
    if (Number.isNaN(n)) {
      return { ok: false, error: `Invalid number for ${source} '${key}': ${value}` };
    }
    return { ok: true, value: n };
  }

  if (propSchema.type === 'boolean') {
    if (value === 'true') {
      return { ok: true, value: true };
    }
    if (value === 'false') {
      return { ok: true, value: false };
    }
    return { ok: false, error: `Invalid boolean for ${source} '${key}': ${value}` };
  }

  return { ok: true, value };
}

/**
 * Run a single Express-style middleware function against (req, res).
 * Resolves to `true` if next() was called (continue dispatch), `false` otherwise.
 */
function executeRouteMiddleware(middlewareFn, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;

    function next(err) {
      if (settled) {
        return;
      }

      settled = true;
      if (err) {
        reject(err);
        return;
      }

      resolve(true);
    }

    try {
      Promise.resolve(middlewareFn(req, res, next))
        .then(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Sequentially run an array of middleware functions. Returns false if any halted the chain.
 */
async function runRouteMiddleware(middlewares, req, res) {
  for (const middlewareFn of middlewares || []) {
    const shouldContinue = await executeRouteMiddleware(middlewareFn, req, res);
    if (!shouldContinue) {
      return false;
    }
  }

  return true;
}

const EXCLUDED_ROUTE_PATH_PREFIXES = [
  /^\/api\/auth(?:\/|$)/,
  /^\/api\/keys(?:\/|$)/,
];

function isExcludedRoute(route) {
  const path = route && route.path;
  if (typeof path === 'string') {
    return EXCLUDED_ROUTE_PATH_PREFIXES.some((prefix) => prefix.test(path));
  }
  if (path instanceof RegExp) {
    return EXCLUDED_ROUTE_PATH_PREFIXES.some((prefix) => prefix.test(path.source));
  }
  return false;
}

module.exports = {
  coerceRestPassthroughValue,
  executeRouteMiddleware,
  runRouteMiddleware,
  EXCLUDED_ROUTE_PATH_PREFIXES,
  isExcludedRoute,
};
