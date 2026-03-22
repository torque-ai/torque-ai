'use strict';

const serverConfig = require('../config');

function handleShowDashboard(args) {
  const tab = args.tab || 'tasks';
  const port = serverConfig.get('dashboard_port', 3456);
  const url = `http://localhost:${port}/mcp-app/dashboard.html?tab=${tab}`;

  return {
    content: [{
      type: 'text',
      text: `## TORQUE Dashboard\n\n**Open in browser:** ${url}\n\nInteractive tabbed dashboard with real-time Tasks, Providers, Workflow, and Cost views.\n\n*Note: MCP Apps inline rendering requires a graphical host (Claude Desktop, VS Code). In Claude Code CLI, open the URL above in your browser.*`,
    }],
    structuredData: {
      url,
      tab,
      port,
    },
  };
}

module.exports = { handleShowDashboard };
