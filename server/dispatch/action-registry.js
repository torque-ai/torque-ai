'use strict';

function createActionRegistry() {
  const surfaces = new Map();

  function register({ surface, schema, handlers, description = null }) {
    if (surfaces.has(surface)) throw new Error(`surface '${surface}' already registered`);
    surfaces.set(surface, { schema, handlers, description });
  }

  function getSurface(surface) {
    return surfaces.get(surface) || null;
  }

  function listSurfaces() {
    return Array.from(surfaces.keys()).sort();
  }

  function listActionNames(surface) {
    const registeredSurface = surfaces.get(surface);
    if (!registeredSurface) return [];
    const names = new Set();
    collectConsts(registeredSurface.schema, 'actionName', names);
    return Array.from(names);
  }

  function collectConsts(schema, field, names) {
    if (!schema || typeof schema !== 'object') return;
    if (schema.properties?.[field]?.const) names.add(schema.properties[field].const);
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(schema[key])) {
        for (const nestedSchema of schema[key]) {
          collectConsts(nestedSchema, field, names);
        }
      }
    }
  }

  return { register, getSurface, listSurfaces, listActionNames };
}

module.exports = { createActionRegistry };
