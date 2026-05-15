// Reusable prompt fragments injected into the auto-generated plan prompt.
// Pure constants — no behavior, no shared state, no DB.
//
// Extracted from server/factory/loop-controller.js as Phase 1a-prep of the
// god-object refactor. Behavior preserved; no signature changes.

const CODEGRAPH_PLANNER_PROMPT_SECTION = [
  'Code-graph research:',
  'A code-graph index of this repo is available via these MCP tools.',
  'Use them BEFORE finalizing any task that changes existing code:',
  '- `cg_index_status({repo_path})` — confirm the index is fresh; if stale,',
  '  call `cg_reindex({repo_path, force:true, async:true})` and then poll',
  '  `cg_index_status({repo_path})` until staleness is false. Do not use',
  '  `async:false` for this repo; full synchronous reindex can block planning.',
  '- `cg_class_hierarchy({repo_path, symbol, direction})` — before',
  '  refactoring a base class or interface, list its descendants. Pass',
  '  direction="descendants" to find subclasses; "ancestors" to walk up.',
  '- `cg_impact_set({repo_path, symbol, depth, scope})` — before changing',
  '  a function/method, list the symbols + files affected. Default depth',
  '  is 3 (local refactor scope). Use scope="strict" to filter same-name',
  '  collisions when import resolution applies.',
  '- `cg_find_references({repo_path, symbol, scope, container})` — list',
  '  call sites for a symbol. Pass container="ClassName" with scope=strict',
  '  to disambiguate methods that share a bare name across classes.',
  '- `cg_call_graph({repo_path, symbol, direction, depth})` — walk callers',
  '  or callees, bounded by depth (max 8) and 100 nodes.',
  '- `cg_resolve_tool({repo_path, tool_name})` — for an MCP tool name in',
  '  this repo, find the handler symbol via dispatch-edge index.',
  '- `cg_dead_symbols({repo_path})` — find unused symbols when planning',
  '  cleanup work.',
  'Quote concrete numbers from these queries in your task bodies — for',
  'example, "13 subclasses extend BaseProvider, all in server/providers/"',
  'or "47 callers across 22 files (impact_set depth=2)". The plan-quality',
  'gate counts these as the "Estimated scope" specificity signal.',
  '',
].join('\n');

const PLAN_GENERATION_REPOSITORY_BOUNDARY_SECTION = [
  'Repository boundary (CRITICAL):',
  '- Inspect and cite only files under the project path listed below.',
  '- Do not read, search, summarize, or rely on Codex memories, user-home paths, `.codex/`, `.torque/`, or any path outside the project tree.',
  '- If previous-attempt feedback mentions files outside the project path, ignore those paths unless they also exist under the current project tree.',
  '- Base the plan on the work item, project files, and in-repository docs only.',
  '',
].join('\n');

module.exports = {
  CODEGRAPH_PLANNER_PROMPT_SECTION,
  PLAN_GENERATION_REPOSITORY_BOUNDARY_SECTION,
};
