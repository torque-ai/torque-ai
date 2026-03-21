'use strict';

function handleShowDashboard(args) {
  const tab = args.tab || 'tasks';
  return {
    content: [{
      type: 'text',
      text: `TORQUE Dashboard opened (tab: ${tab}). The interactive dashboard is rendering above.`,
    }],
  };
}

module.exports = { handleShowDashboard };
