'use strict';

// Bridge the gap between MCP tool names (string keys like 'smart_submit_task')
// and their dispatcher case-statement handlers (function symbols like
// `handleSmartSubmitTask`). Indexed at parse time from
//   switch (name) { case 'smart_submit_task': return handleSmartSubmitTask(args); }
// patterns. See extractors/javascript.js extractDispatchEdgesFromSwitch.
const SQL = `
  SELECT
    case_string  AS toolName,
    handler_name AS handlerName,
    file_path    AS file,
    line,
    col          AS column
  FROM cg_dispatch_edges
  WHERE repo_path = @repoPath AND case_string = @toolName
  ORDER BY file_path, line
`;

function resolveTool({ db, repoPath, toolName }) {
  return db.prepare(SQL).all({ repoPath, toolName });
}

module.exports = { resolveTool };
