'use strict';

const fs = require('fs');
const path = require('path');

const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');

const RESOURCES = [
  {
    uri: 'ui://torque/dashboard',
    name: 'TORQUE Dashboard',
    description: 'Interactive task status, provider health, workflow progress, and cost tracking',
    mimeType: 'text/html;profile=mcp-app',
  },
];

function listResources() {
  return { resources: RESOURCES };
}

function readResource(params) {
  const uri = params?.uri;

  if (uri === 'ui://torque/dashboard') {
    try {
      const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
      return {
        contents: [{
          uri,
          mimeType: 'text/html;profile=mcp-app',
          text: html,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error reading dashboard: ${err.message}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown resource: ${uri}` }],
    isError: true,
  };
}

module.exports = { listResources, readResource, RESOURCES };
