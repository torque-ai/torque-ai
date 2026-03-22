'use strict';

describe('mcp-apps', () => {
  describe('resource handler', () => {
    it('listResources returns dashboard resource', () => {
      const { listResources } = require('../mcp-apps/resource-handler');
      const result = listResources();
      expect(result.resources).toBeDefined();
      expect(result.resources.length).toBeGreaterThan(0);
      const dashboard = result.resources.find(r => r.uri === 'ui://torque/dashboard');
      expect(dashboard).toBeDefined();
      expect(dashboard.mimeType).toBe('text/html;profile=mcp-app');
      expect(dashboard.name).toBe('TORQUE Dashboard');
    });

    it('readResource returns HTML for dashboard URI', () => {
      const { readResource } = require('../mcp-apps/resource-handler');
      const result = readResource({ uri: 'ui://torque/dashboard' });
      expect(result.contents).toBeDefined();
      expect(result.contents.length).toBe(1);
      expect(result.contents[0].mimeType).toBe('text/html;profile=mcp-app');
      expect(result.contents[0].text).toContain('<!DOCTYPE html>');
      expect(result.contents[0].text).toContain('tab-tasks');
      expect(result.contents[0].text).toContain('tab-providers');
    });

    it('readResource returns error for unknown URI', () => {
      const { readResource } = require('../mcp-apps/resource-handler');
      const result = readResource({ uri: 'ui://torque/nonexistent' });
      expect(result.isError).toBe(true);
    });
  });

  describe('protocol integration', () => {
    it('show_dashboard tool has _meta.ui.resourceUri', () => {
      const { TOOLS } = require('../tools');
      const tool = TOOLS.find(t => t.name === 'show_dashboard');
      expect(tool).toBeDefined();
      expect(tool._meta?.ui?.resourceUri).toBe('ui://torque/dashboard');
    });

    it('show_dashboard has annotations (readOnly + idempotent)', () => {
      const { TOOLS } = require('../tools');
      const tool = TOOLS.find(t => t.name === 'show_dashboard');
      expect(tool).toBeDefined();
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
    });

    it('show_dashboard is in Tier 1', () => {
      const { CORE_TOOL_NAMES } = require('../core-tools');
      expect(CORE_TOOL_NAMES).toContain('show_dashboard');
    });
  });
});
