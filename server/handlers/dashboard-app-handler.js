'use strict';

function handleShowDashboard(args) {
  const tab = args.tab || 'tasks';

  return {
    content: [{
      type: 'text',
      text: `TORQUE Dashboard (tab: ${tab}). In Claude Desktop, the interactive dashboard renders inline above. In Claude Code CLI, use \`get_context\` for a compact text dashboard.`,
    }],
  };
}

module.exports = { handleShowDashboard };
