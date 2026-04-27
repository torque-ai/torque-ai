'use strict';

const routes = require('../../../api/routes-passthrough');

describe('codegraph REST passthrough routes', () => {
  function find(tool, method) {
    return routes.find((r) => r.tool === tool && r.method === method);
  }

  it('exposes GET /api/v2/codegraph/index-status for cg_index_status', () => {
    const r = find('cg_index_status', 'GET');
    expect(r).toBeTruthy();
    expect(r.path).toBe('/api/v2/codegraph/index-status');
    expect(r.mapQuery).toBe(true);
  });

  it('exposes POST /api/v2/codegraph/reindex for cg_reindex', () => {
    const r = find('cg_reindex', 'POST');
    expect(r).toBeTruthy();
    expect(r.path).toBe('/api/v2/codegraph/reindex');
    expect(r.mapBody).toBe(true);
  });

  it('exposes POST routes for find-references, call-graph, impact-set', () => {
    expect(find('cg_find_references', 'POST').path).toBe('/api/v2/codegraph/find-references');
    expect(find('cg_call_graph',      'POST').path).toBe('/api/v2/codegraph/call-graph');
    expect(find('cg_impact_set',      'POST').path).toBe('/api/v2/codegraph/impact-set');
  });

  it('exposes GET /api/v2/codegraph/dead-symbols for cg_dead_symbols', () => {
    const r = find('cg_dead_symbols', 'GET');
    expect(r).toBeTruthy();
    expect(r.path).toBe('/api/v2/codegraph/dead-symbols');
    expect(r.mapQuery).toBe(true);
  });
});
