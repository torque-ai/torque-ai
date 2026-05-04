'use strict';

const fs = require('fs');
const path = require('path');

const STUDY_PROFILE_OVERRIDE_FILE = path.join('docs', 'architecture', 'study-profile.override.json');

const BASE_SUBSYSTEM_PRIORITY = Object.freeze({
  'runtime-core': 87,
  'dashboard-ui': 85,
  'cli-entrypoints': 79,
  'docs-and-guides': 45,
  'validation-tests': 15,
});

const BASE_SUBSYSTEM_DEFINITIONS = [
  {
    id: 'validation-tests',
    label: 'Validation and tests',
    description: 'Focused test suites and harnesses that validate runtime behavior and guard important flows.',
    prefixes: ['test/', 'tests/', 'server/tests/', 'dashboard/e2e/'],
    patterns: [/\.test\.[^.]+$/, /\.spec\.[^.]+$/, /\.e2e\.[^.]+$/],
  },
  {
    id: 'cli-entrypoints',
    label: 'CLI and binaries',
    description: 'Shell-facing entrypoints and helpers for running the project outside embedded transports.',
    prefixes: ['bin/', 'cli/'],
  },
  {
    id: 'dashboard-ui',
    label: 'Dashboard UI',
    description: 'Interactive UI code, client bootstraps, and presentation-layer state.',
    prefixes: ['dashboard/src/', 'web/src/', 'ui/src/', 'client/src/', 'app/src/'],
  },
  {
    id: 'runtime-core',
    label: 'Runtime core',
    description: 'Root runtime modules that bootstrap configuration, logging, containers, and shared services.',
    patterns: [/^server\/[^/]+\.(?:js|ts|json)$/],
  },
  {
    id: 'docs-and-guides',
    label: 'Documentation and guides',
    description: 'Documentation, generated architecture artifacts, and reference material for humans and models.',
    prefixes: ['docs/'],
    exact: ['README.md', 'CLAUDE.md', 'CONTRIBUTING.md'],
  },
];

const BASE_SUBSYSTEM_GUIDANCE = Object.freeze({
  'runtime-core': {
    invariants: [
      'Root runtime modules should stay small and orchestration-focused rather than absorbing feature logic.',
      'Shared infrastructure like logging and container wiring should remain stable seams that other modules depend on, not rewrite often.',
    ],
    watchouts: [
      'Feature-specific behavior leaking into root bootstrap files.',
      'Cross-cutting changes that silently alter the assumptions of many downstream modules.',
    ],
  },
  'dashboard-ui': {
    invariants: [
      'UI state should reflect server or domain contracts instead of inventing competing orchestration rules.',
      'Entry screens and shared client surfaces should stay predictable starting points for human and model readers.',
    ],
    watchouts: [
      'Client-only state diverging from the server model.',
      'Presentation components taking on business logic that belongs in handlers or services.',
    ],
  },
  'cli-entrypoints': {
    invariants: [
      'CLI entrypoints should remain thin wrappers around reusable runtime or handler logic.',
    ],
    watchouts: [
      'Command-specific business rules duplicated between CLI and runtime surfaces.',
    ],
  },
  'docs-and-guides': {
    invariants: [
      'Generated architecture artifacts should stay consistent with the repo map and should be refreshable from source without manual edits.',
    ],
    watchouts: [
      'Docs drifting away from runtime behavior or generated artifacts.',
    ],
  },
  'validation-tests': {
    invariants: [
      'Representative tests should stay aligned with the real runtime seams they claim to validate.',
    ],
    watchouts: [
      'Broad helper-heavy suites that obscure which production surface is actually covered.',
    ],
  },
});

const GENERIC_FLOW_GUIDANCE = Object.freeze({
  'generic-entry-runtime': {
    invariants: [
      'Entrypoints and their first-hop runtime dependencies should describe the same feature surface instead of sending readers through unrelated modules.',
      'High-signal runtime files should stay readable orientation points rather than becoming catch-all utility layers.',
    ],
    success_signals: [
      'A new reader can start at the entrypoint and reach the core implementation in one or two hops.',
      'Runtime hotspots and exported surfaces point at the same implementation seam.',
    ],
    failure_modes: [
      {
        label: 'Entrypoint/runtime drift',
        symptoms: 'The file a maintainer starts with no longer reflects the real implementation path, so onboarding begins in the wrong seam.',
      },
    ],
  },
  'generic-config-contracts': {
    invariants: [
      'Configuration, manifests, locale packs, and schema files should stay tied to their consuming runtime modules.',
      'Contract-like data files should remain centralized so readers can find the source of truth without chasing duplicates.',
    ],
    success_signals: [
      'Config or content files can be traced back to the code that consumes them.',
      'Schema and manifest edits have an obvious validation surface.',
    ],
    failure_modes: [
      {
        label: 'Config/consumer drift',
        symptoms: 'Data contracts evolve, but the runtime code that reads them is no longer obvious or validated.',
      },
    ],
  },
  'generic-change-validation': {
    invariants: [
      'Tests, harnesses, or build surfaces should stay connected to the code they are meant to protect.',
      'Change guidance should identify both the risky edit surface and the fastest available validation path.',
    ],
    success_signals: [
      'A maintainer can answer “what should I run after editing this seam?” from the pack alone.',
      'Validation surfaces point at representative tests or build commands instead of generic repo-wide advice only.',
    ],
    failure_modes: [
      {
        label: 'Validation blind spot',
        symptoms: 'The repo exposes risky seams, but the pack cannot tell a maintainer which checks or neighboring files matter most after a change.',
      },
    ],
  },
});

const TORQUE_PROFILE = Object.freeze({
  id: 'torque-control-plane',
  label: 'TORQUE control-plane monorepo',
  description: 'Node-based control plane with task execution, workflow orchestration, scheduled automation, and dashboard surfaces.',
  reusable_strategy: 'Use the same artifact schema for other repositories, but swap in repo-specific subsystem and flow definitions as needed.',
  matches({ trackedFiles }) {
    const files = new Set(trackedFiles || []);
    return files.has('server/task-manager.js')
      && files.has('server/tools.js')
      && files.has('server/api/v2-dispatch.js')
      && files.has('server/execution/workflow-runtime.js');
  },
  subsystem_definitions: [
    {
      id: 'standalone-agent',
      label: 'Standalone agent',
      description: 'Detached or remote agent runtime and its supporting tests/configuration.',
      prefixes: ['agent/'],
    },
    {
      id: 'control-plane-api',
      label: 'Control-plane API',
      description: 'HTTP and transport surfaces that expose TORQUE task, provider, workflow, and governance operations.',
      prefixes: ['server/api/'],
      exact: ['server/index.js', 'server/api-server.js'],
    },
    {
      id: 'workflow-orchestration',
      label: 'Workflow orchestration',
      description: 'DAG workflow creation, await logic, diffusion planning, and workflow runtime coordination.',
      prefixes: ['server/handlers/workflow/', 'server/diffusion/'],
      exact: ['server/execution/workflow-runtime.js'],
    },
    {
      id: 'task-execution',
      label: 'Task execution pipeline',
      description: 'Task startup, provider routing, process lifecycle, retries, verification, and completion handling.',
      prefixes: ['server/execution/'],
      exact: ['server/task-manager.js'],
    },
    {
      id: 'tooling-mcp-surface',
      label: 'Tool and MCP surface',
      description: 'Tool catalog, schemas, dispatch, protocol transport, and MCP-facing integration points.',
      prefixes: ['server/tool-defs/', 'server/mcp/'],
      exact: ['server/tools.js', 'server/core-tools.js'],
    },
    {
      id: 'persistence-scheduling',
      label: 'Persistence and scheduling',
      description: 'SQLite-backed state, queues, schedules, provider stats, and workflow/task metadata.',
      prefixes: ['server/db/'],
    },
    {
      id: 'provider-adapters',
      label: 'Provider adapters',
      description: 'Provider registry, CLI/API adapters, prompts, and provider-specific execution logic.',
      prefixes: ['server/providers/'],
    },
    {
      id: 'handler-layer',
      label: 'Handler layer',
      description: 'Adapters that translate tool or API calls into task, provider, policy, and study operations.',
      prefixes: ['server/handlers/'],
    },
    {
      id: 'governance-maintenance',
      label: 'Governance and maintenance',
      description: 'Policies, audits, hooks, background schedulers, and maintenance operations that shape runtime behavior.',
      prefixes: ['server/governance/', 'server/hooks/', 'server/maintenance/', 'server/audit/'],
    },
  ],
  subsystem_priority: {
    'control-plane-api': 100,
    'task-execution': 97,
    'workflow-orchestration': 95,
    'persistence-scheduling': 93,
    'provider-adapters': 91,
    'tooling-mcp-surface': 89,
    'handler-layer': 83,
    'governance-maintenance': 81,
    'standalone-agent': 65,
  },
  subsystem_guidance: {
    'control-plane-api': {
      invariants: [
        'Routes and control-plane transports should validate and normalize requests, then delegate into handlers or execution services.',
        'Business rules should stay in handler or execution layers so API surfaces remain thin and consistent across transports.',
      ],
      watchouts: [
        'Schema drift between routes, handler args, and tool surfaces.',
        'Control-plane code bypassing shared execution or governance checks.',
      ],
    },
    'task-execution': {
      invariants: [
        'Task state transitions should stay centralized so retries, verification, and completion agree on lifecycle ownership.',
        'Execution modules should report through tracked task state instead of side-channeling progress.',
      ],
      watchouts: [
        'Retries or completion logic that fork the lifecycle in more than one place.',
        'Provider-specific execution leaking out of the routing and adapter layers.',
      ],
    },
    'workflow-orchestration': {
      invariants: [
        'Workflow definitions, runtime state, and await surfaces should describe the same DAG semantics.',
        'Context injection and dependency unblocking should come from persisted workflow state.',
      ],
      watchouts: [
        'New workflow nodes that do not participate in await/progress surfaces.',
        'Dependency edges that are implied in code but not encoded in the DAG.',
      ],
    },
    'persistence-scheduling': {
      invariants: [
        'Persistent task, workflow, and schedule mutations should flow through DB helpers rather than ad hoc writes.',
        'Scheduling metadata should be rich enough to explain why a run occurred and how it was dispatched.',
      ],
      watchouts: [
        'Bypassing helper APIs when creating schedule or task rows.',
        'Losing correspondence between scheduled actions and tracked runtime state.',
      ],
    },
    'provider-adapters': {
      invariants: [
        'Adapters should expose a predictable execution contract so routing and retries stay provider-agnostic.',
        'Provider-specific auth and prompt details should remain encapsulated in adapters or provider helpers.',
      ],
      watchouts: [
        'One-off provider logic baked into routing or handler layers.',
        'Health or capability signals that no longer reflect adapter behavior.',
      ],
    },
    'tooling-mcp-surface': {
      invariants: [
        'Tool definitions, schemas, and handler dispatch should stay aligned across MCP and HTTP surfaces.',
        'Tool results should normalize through a stable envelope so hooks and transports can reason about them consistently.',
      ],
      watchouts: [
        'New tools added to schemas but not wired into handlers.',
        'Post-tool hooks depending on inconsistent response shapes.',
      ],
    },
    'dashboard-ui': {
      invariants: [
        'The dashboard should reflect control-plane state rather than reimplement orchestration logic in the client.',
        'UI affordances for governance and scheduling should reuse shared API contracts and state transitions.',
      ],
      watchouts: [
        'UI-only state diverging from the server model.',
        'Controls that fire bespoke endpoints instead of the shared API surface.',
      ],
    },
  },
  flow_definitions: [
    {
      id: 'task-lifecycle',
      label: 'Task lifecycle',
      summary: 'Task requests enter through API or handlers, start in the task manager, route through execution modules, and finish in the completion pipeline.',
      questions: ['How does a task move from submission to completion?'],
      steps: [
        {
          label: 'Ingress',
          description: 'Accept or shape task requests before execution.',
          files: ['server/api/v2-dispatch.js', 'server/handlers/task/index.js'],
        },
        {
          label: 'Execution start',
          description: 'Instantiate task state, start processes, and coordinate runtime state.',
          files: ['server/task-manager.js', 'server/execution/task-startup.js'],
        },
        {
          label: 'Routing and process control',
          description: 'Choose providers, manage retries, and track process lifecycle.',
          files: ['server/execution/provider-router.js', 'server/execution/fallback-retry.js', 'server/execution/process-lifecycle.js'],
        },
        {
          label: 'Finalize and publish',
          description: 'Finalize task output, verification, and downstream side effects.',
          files: ['server/execution/task-finalizer.js', 'server/execution/completion-pipeline.js'],
        },
      ],
    },
    {
      id: 'workflow-lifecycle',
      label: 'Workflow lifecycle',
      summary: 'Workflow handlers define DAG structure, the runtime unblocks nodes, and await logic surfaces progress and completion.',
      questions: ['How are workflows created, advanced, and awaited?'],
      steps: [
        {
          label: 'Workflow definition',
          description: 'Create and validate workflow DAGs.',
          files: ['server/handlers/workflow/index.js', 'server/handlers/workflow/dag.js'],
        },
        {
          label: 'Runtime orchestration',
          description: 'Advance workflow state and unblock dependent tasks.',
          files: ['server/execution/workflow-runtime.js'],
        },
        {
          label: 'Progress and await',
          description: 'Surface progress and wait for node completion.',
          files: ['server/handlers/workflow/await.js', 'server/handlers/workflow/advanced.js'],
        },
      ],
    },
    {
      id: 'scheduled-automation',
      label: 'Scheduled automation',
      summary: 'Schedules are stored in DB helpers, fired by the maintenance scheduler, and translated into tasks or tool executions by the schedule runner.',
      questions: ['How do schedules and Run Now executions work?'],
      steps: [
        {
          label: 'Schedule definition',
          description: 'Create and persist schedule metadata.',
          files: ['server/db/cron-scheduling.js', 'server/api/v2-governance-handlers.js'],
        },
        {
          label: 'Scheduler tick',
          description: 'Detect due schedules in the background loop.',
          files: ['server/maintenance/scheduler.js'],
        },
        {
          label: 'Dispatch',
          description: 'Turn a due schedule into a tracked task, workflow run, or tool invocation.',
          files: ['server/execution/schedule-runner.js', 'server/tools.js'],
        },
      ],
    },
    {
      id: 'tool-dispatch',
      label: 'Tool dispatch',
      summary: 'Tool definitions and schemas are registered centrally, then routed to handlers and post-tool hooks through the MCP surface.',
      questions: ['Where do tool definitions, dispatch, and MCP transport live?'],
      steps: [
        {
          label: 'Catalog',
          description: 'Register tool schemas and metadata.',
          files: ['server/tools.js', 'server/core-tools.js'],
        },
        {
          label: 'Handler dispatch',
          description: 'Route tool calls to handlers and normalize outputs.',
          files: ['server/tools.js', 'server/hooks/post-tool-hooks.js'],
        },
        {
          label: 'Transport',
          description: 'Expose tools over MCP and server transports.',
          files: ['server/mcp/index.js', 'server/mcp/protocol.js', 'server/mcp/sse.js'],
        },
      ],
    },
    {
      id: 'provider-routing',
      label: 'Provider routing and retry',
      summary: 'Provider scoring, routing, and fallback logic combine health, capabilities, and retries to decide where work runs.',
      questions: ['How does TORQUE choose providers and retry failed work?'],
      steps: [
        {
          label: 'Capability and health data',
          description: 'Track provider health, scores, and capabilities.',
          files: ['server/db/provider/scoring.js', 'server/db/provider/health-history.js', 'server/db/provider/capabilities.js'],
        },
        {
          label: 'Routing',
          description: 'Choose the best provider for a task.',
          files: ['server/execution/provider-router.js'],
        },
        {
          label: 'Retry and fallback',
          description: 'Retry or downgrade tasks after failure or stall detection.',
          files: ['server/execution/fallback-retry.js', 'server/execution/retry-framework.js'],
        },
      ],
    },
  ],
  flow_guidance: {
    'task-lifecycle': {
      invariants: [
        'Submission surfaces should delegate into handlers and the task manager instead of invoking providers directly.',
        'Task completion should converge through the finalizer and completion pipeline so verification and follow-up hooks stay centralized.',
      ],
      success_signals: [
        'Tasks move through a tracked lifecycle instead of jumping straight from request to side effects.',
        'Verification, completion hooks, and persisted task output are attached at the end of the run.',
      ],
      failure_modes: [
        {
          label: 'Bypassed finalization',
          symptoms: 'Tasks appear done but verification, ledger updates, or downstream hooks are missing.',
          investigate_first: ['server/execution/task-finalizer.js', 'server/execution/completion-pipeline.js'],
        },
        {
          label: 'Split execution ownership',
          symptoms: 'API or handler code starts doing provider work directly, creating duplicated retry and state transitions.',
          investigate_first: ['server/api/v2-dispatch.js', 'server/handlers/task/index.js', 'server/task-manager.js'],
        },
      ],
    },
    'workflow-lifecycle': {
      invariants: [
        'Workflow structure, runtime unblocking, and await reporting should stay aligned on the same DAG semantics.',
        'Dependent nodes should unblock only from persisted workflow state, not from ad hoc in-memory assumptions.',
      ],
      success_signals: [
        'Workflow nodes unblock in dependency order and await surfaces reflect the same runtime state.',
        'Node outputs and completion status are visible through the await and workflow handlers.',
      ],
      failure_modes: [
        {
          label: 'DAG/runtime drift',
          symptoms: 'Nodes exist in definitions but never unblock, or await surfaces show states that do not match runtime behavior.',
          investigate_first: ['server/handlers/workflow/dag.js', 'server/execution/workflow-runtime.js', 'server/handlers/workflow/await.js'],
        },
      ],
    },
    'scheduled-automation': {
      invariants: [
        'Schedules should create tracked task or tool executions; background automation should not fire invisibly.',
        'Manual Run Now should reuse the same execution path as scheduled runs, with only the trigger context changed.',
      ],
      success_signals: [
        'Due schedules create visible runs with persisted metadata and completion status.',
        'Manual runs and cron ticks produce equivalent results for the same schedule payload.',
      ],
      failure_modes: [
        {
          label: 'Silent schedule dispatch',
          symptoms: 'The scheduler fires but no task row, tool result, or completion record is created.',
          investigate_first: ['server/maintenance/scheduler.js', 'server/execution/schedule-runner.js', 'server/db/cron-scheduling.js'],
        },
        {
          label: 'Run Now path divergence',
          symptoms: 'Manual schedule execution behaves differently from cron, skips work, or bypasses persistence helpers.',
          investigate_first: ['server/api/v2-governance-handlers.js', 'server/execution/schedule-runner.js', 'server/db/cron-scheduling.js'],
        },
      ],
    },
    'tool-dispatch': {
      invariants: [
        'Tool schemas, dispatch registration, and transport exposure should stay in sync.',
        'Tool handlers should normalize output through the same MCP-facing contract regardless of caller.',
      ],
      success_signals: [
        'A tool defined in the catalog is discoverable and routed through the same handler path in MCP and HTTP surfaces.',
        'Post-tool hooks see a consistent result envelope from handler output.',
      ],
      failure_modes: [
        {
          label: 'Schema/handler drift',
          symptoms: 'A tool appears in one surface but fails validation, lacks a handler, or returns an unexpected shape.',
          investigate_first: ['server/tools.js', 'server/core-tools.js', 'server/mcp/index.js'],
        },
      ],
    },
    'provider-routing': {
      invariants: [
        'Routing decisions should be derived from provider health, capabilities, and policy-aware scoring rather than one-off special cases.',
        'Retry and fallback should preserve task ownership and emit observable state transitions.',
      ],
      success_signals: [
        'Provider selection can be explained by score, health, and capability data.',
        'Retries and fallbacks reuse the same task state instead of creating hidden parallel paths.',
      ],
      failure_modes: [
        {
          label: 'Opaque provider choice',
          symptoms: 'Tasks land on surprising providers with no clear health or capability rationale.',
          investigate_first: ['server/db/provider/scoring.js', 'server/db/provider/capabilities.js', 'server/execution/provider-router.js'],
        },
        {
          label: 'Fallback duplication',
          symptoms: 'Fallback creates duplicate work or loses the causal chain between the original task and retries.',
          investigate_first: ['server/execution/fallback-retry.js', 'server/execution/retry-framework.js', 'server/task-manager.js'],
        },
      ],
    },
  },
});

const GENERIC_PROFILE = Object.freeze({
  id: 'generic-javascript-repo',
  label: 'Generic JavaScript repository',
  description: 'A JavaScript or TypeScript codebase studied through local structure, dependency facts, and flow hints.',
  reusable_strategy: 'The artifact schema is generic; add repo-specific subsystem and flow profiles to deepen the expertise pack without changing consumers.',
  matches() {
    return true;
  },
  subsystem_definitions: [],
  subsystem_priority: {},
  subsystem_guidance: {},
  flow_definitions: [],
  flow_guidance: GENERIC_FLOW_GUIDANCE,
});

const STUDY_PROFILES = [TORQUE_PROFILE, GENERIC_PROFILE];

function toRepoPath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function buildPackageSignalSet(repoMetadata) {
  const packageJson = repoMetadata?.package_json;
  const dependencyNames = [
    ...Object.keys(packageJson?.dependencies || {}),
    ...Object.keys(packageJson?.devDependencies || {}),
    ...Object.keys(packageJson?.peerDependencies || {}),
  ].map((value) => String(value || '').trim().toLowerCase());
  return new Set(dependencyNames.filter(Boolean));
}

function hasPrefix(trackedFiles, prefix) {
  return (trackedFiles || []).some((filePath) => toRepoPath(filePath).startsWith(prefix));
}

function detectStudyProfileSignals({ repoMetadata, trackedFiles, profile } = {}) {
  const files = (Array.isArray(trackedFiles) ? trackedFiles : []).map(toRepoPath);
  const packageSignals = buildPackageSignalSet(repoMetadata);
  const evidence = [];
  const frameworks = [];
  const traits = [];

  const hasServer = hasPrefix(files, 'server/');
  const hasDashboard = hasPrefix(files, 'dashboard/src/') || hasPrefix(files, 'src/components/') || hasPrefix(files, 'app/') || hasPrefix(files, 'client/');
  const hasCli = hasPrefix(files, 'bin/') || hasPrefix(files, 'cli/') || Array.isArray(repoMetadata?.bin_files) && repoMetadata.bin_files.length > 0;
  const pythonFileCount = files.filter((filePath) => filePath.toLowerCase().endsWith('.py')).length;
  const dotnetFileCount = files.filter((filePath) => filePath.toLowerCase().endsWith('.cs')).length;
  const hasPython = pythonFileCount > 0 || repoMetadata?.python_project === true;
  const hasDotnet = dotnetFileCount > 0 || repoMetadata?.dotnet_project === true;
  const hasDesktop = files.some((filePath) => /app\.xaml\.cs$/i.test(filePath));
  const hasTests = files.some((filePath) => /(?:^|\/)(?:tests?|__tests__)\/|(?:\.test|\.spec|\.e2e|\.integration)\.[^.]+$/i.test(filePath));
  const contentFileCount = files.filter((filePath) => /(^|\/)(lang|locales?|i18n|manifests?|schemas?|fixtures)\//.test(filePath) || /\.(json|ya?ml|toml|ini)$/.test(filePath)).length;
  const jsLikeCount = files.filter((filePath) => /\.(?:[cm]?js|ts|tsx|jsx)$/.test(filePath)).length;

  if (profile?.id === 'torque-control-plane') {
    evidence.push('Matched TORQUE control-plane profile signature.');
  }
  if (hasServer) {
    traits.push('server');
    evidence.push('Detected server-side runtime files.');
  }
  if (hasDashboard) {
    traits.push('ui');
    evidence.push('Detected interactive UI source directories.');
  }
  if (hasCli) {
    traits.push('cli');
    evidence.push('Detected CLI/bin entrypoints.');
  }
  if (hasPython) {
    traits.push('python');
    evidence.push(`Detected ${pythonFileCount || 1} Python source files or project markers.`);
  }
  if (hasDotnet) {
    traits.push('dotnet');
    evidence.push(`Detected ${dotnetFileCount || 1} .NET source files or solution markers.`);
  }
  if (hasDesktop) {
    traits.push('desktop');
    evidence.push('Detected desktop startup surfaces.');
  }
  if (hasTests) {
    traits.push('tests');
    evidence.push('Detected representative test files.');
  }
  if (contentFileCount > 0) {
    traits.push('content');
    evidence.push(`Detected ${contentFileCount} structured content/config files.`);
  }

  const frameworkHints = [
    ['react', 'React'],
    ['next', 'Next.js'],
    ['vue', 'Vue'],
    ['nuxt', 'Nuxt'],
    ['svelte', 'Svelte'],
    ['vite', 'Vite'],
    ['electron', 'Electron'],
    ['express', 'Express'],
    ['fastify', 'Fastify'],
    ['koa', 'Koa'],
    ['rollup', 'Rollup'],
    ['vitest', 'Vitest'],
    ['jest', 'Jest'],
  ];
  for (const [dependencyName, label] of frameworkHints) {
    if (packageSignals.has(dependencyName)) {
      frameworks.push(label);
    }
  }
  if (hasPython) {
    frameworks.push('Python');
  }
  if (hasDotnet) {
    frameworks.push('.NET');
  }
  if (hasDesktop) {
    frameworks.push('WPF');
  }

  let archetype = 'generic-javascript-repo';
  if (hasServer && hasDashboard) {
    archetype = 'fullstack-control-plane';
    evidence.push('Server and UI surfaces are both present.');
  } else if ((hasPython || hasDotnet) && (jsLikeCount > 0 || hasDashboard || hasCli)) {
    archetype = 'polyglot-application';
    evidence.push('Multiple runtime ecosystems contribute to the repo surface.');
  } else if (hasDotnet && hasDesktop) {
    archetype = 'desktop-application';
    evidence.push('Desktop-specific .NET startup surfaces are present.');
  } else if (hasPython && hasCli) {
    archetype = 'automation-tooling-repo';
    evidence.push('Python automation/runtime entrypoints dominate the repo surface.');
  } else if (hasDashboard || packageSignals.has('react') || packageSignals.has('vue') || packageSignals.has('svelte') || packageSignals.has('next')) {
    archetype = 'frontend-application';
    evidence.push('UI/framework signals dominate the repo surface.');
  } else if (hasServer || packageSignals.has('express') || packageSignals.has('fastify') || packageSignals.has('koa')) {
    archetype = 'node-service';
    evidence.push('Server/runtime signals dominate the repo surface.');
  } else if (hasCli) {
    archetype = 'cli-tool';
    evidence.push('CLI/bin signals dominate the repo surface.');
  } else if (contentFileCount > jsLikeCount && contentFileCount >= 8) {
    archetype = 'content-heavy-javascript-repo';
    evidence.push('Structured content files outweigh executable source files.');
  } else if (jsLikeCount > 0) {
    archetype = 'javascript-application';
    evidence.push('Executable JavaScript/TypeScript source dominates the repo surface.');
  }

  let confidence = 'medium';
  if (profile?.id === 'torque-control-plane' || evidence.length >= 4 || frameworks.length >= 2) {
    confidence = 'high';
  } else if (evidence.length <= 1) {
    confidence = 'low';
  }

  return {
    archetype,
    confidence,
    frameworks: Object.freeze(uniqueStrings(frameworks)),
    traits: Object.freeze(uniqueStrings(traits)),
    evidence: Object.freeze(uniqueStrings(evidence)),
  };
}

function readJsonFileIfPresent(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getStudyProfileOverridePath(workingDirectory) {
  const root = typeof workingDirectory === 'string' ? workingDirectory.trim() : '';
  if (!root) {
    return null;
  }
  return path.join(path.resolve(root), STUDY_PROFILE_OVERRIDE_FILE);
}

function sanitizeStudyProfileOverride(rawOverride) {
  if (!rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) {
    return null;
  }

  const override = {
    version: Number.isInteger(rawOverride.version) ? rawOverride.version : 1,
    base_profile_id: typeof rawOverride.base_profile_id === 'string' ? rawOverride.base_profile_id.trim() : null,
    label: typeof rawOverride.label === 'string' ? rawOverride.label.trim() : null,
    description: typeof rawOverride.description === 'string' ? rawOverride.description.trim() : null,
    reusable_strategy: typeof rawOverride.reusable_strategy === 'string' ? rawOverride.reusable_strategy.trim() : null,
    notes: Array.isArray(rawOverride.notes)
      ? rawOverride.notes.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
      : [],
    subsystem_definitions: Array.isArray(rawOverride.subsystem_definitions) ? rawOverride.subsystem_definitions : [],
    subsystem_priority: rawOverride.subsystem_priority && typeof rawOverride.subsystem_priority === 'object' && !Array.isArray(rawOverride.subsystem_priority)
      ? rawOverride.subsystem_priority
      : {},
    subsystem_guidance: rawOverride.subsystem_guidance && typeof rawOverride.subsystem_guidance === 'object' && !Array.isArray(rawOverride.subsystem_guidance)
      ? rawOverride.subsystem_guidance
      : {},
    flow_definitions: Array.isArray(rawOverride.flow_definitions) ? rawOverride.flow_definitions : [],
    flow_guidance: rawOverride.flow_guidance && typeof rawOverride.flow_guidance === 'object' && !Array.isArray(rawOverride.flow_guidance)
      ? rawOverride.flow_guidance
      : {},
    validation_commands: rawOverride.validation_commands && typeof rawOverride.validation_commands === 'object' && !Array.isArray(rawOverride.validation_commands)
      ? rawOverride.validation_commands
      : {},
  };

  const hasMeaningfulContent = (
    override.subsystem_definitions.length > 0
    || override.flow_definitions.length > 0
    || Object.keys(override.subsystem_priority).length > 0
    || Object.keys(override.subsystem_guidance).length > 0
    || Object.keys(override.flow_guidance).length > 0
    || Object.keys(override.validation_commands).length > 0
  );

  return hasMeaningfulContent ? override : null;
}

function readStudyProfileOverride(workingDirectory) {
  const overridePath = getStudyProfileOverridePath(workingDirectory);
  if (!overridePath) {
    return null;
  }
  const override = sanitizeStudyProfileOverride(readJsonFileIfPresent(overridePath));
  if (!override) {
    return null;
  }
  return {
    ...override,
    file_path: overridePath,
    repo_path: STUDY_PROFILE_OVERRIDE_FILE.replace(/\\/g, '/'),
  };
}

function createStudyProfileOverrideTemplate({ repoMetadata, profile } = {}) {
  const repoName = typeof repoMetadata?.name === 'string' && repoMetadata.name.trim()
    ? repoMetadata.name.trim()
    : 'repo';
  return {
    version: 1,
    base_profile_id: profile?.id || GENERIC_PROFILE.id,
    label: `${repoName} study profile overrides`,
    description: 'Optional repo-local study overrides that extend the shared profile without changing the study engine.',
    reusable_strategy: profile?.reusable_strategy || GENERIC_PROFILE.reusable_strategy,
    notes: [
      'Add repo-specific subsystem or flow definitions only when the generic pack is missing important seams.',
      'Leave arrays and objects empty if no repo-local override is needed yet.',
    ],
    subsystem_definitions: [],
    subsystem_priority: {},
    subsystem_guidance: {},
    flow_definitions: [],
    flow_guidance: {},
    validation_commands: {},
  };
}

function mergeStudyProfiles(baseProfile, override) {
  if (!override) {
    return baseProfile;
  }

  return {
    ...baseProfile,
    label: override.label || baseProfile.label,
    description: override.description || baseProfile.description,
    reusable_strategy: override.reusable_strategy || baseProfile.reusable_strategy,
    base_profile_id: baseProfile.id,
    override_applied: true,
    override_repo_path: override.repo_path || STUDY_PROFILE_OVERRIDE_FILE.replace(/\\/g, '/'),
    override_notes: override.notes || [],
    subsystem_definitions: [...(override.subsystem_definitions || []), ...(baseProfile.subsystem_definitions || [])],
    subsystem_priority: {
      ...(baseProfile.subsystem_priority || {}),
      ...(override.subsystem_priority || {}),
    },
    subsystem_guidance: {
      ...(baseProfile.subsystem_guidance || {}),
      ...(override.subsystem_guidance || {}),
    },
    flow_definitions: [...(baseProfile.flow_definitions || []), ...(override.flow_definitions || [])],
    flow_guidance: {
      ...(baseProfile.flow_guidance || {}),
      ...(override.flow_guidance || {}),
    },
    validation_commands: {
      ...(baseProfile.validation_commands || {}),
      ...(override.validation_commands || {}),
    },
  };
}

function mergeProfile(profile) {
  return Object.freeze({
    id: profile.id,
    label: profile.label,
    description: profile.description,
    reusable_strategy: profile.reusable_strategy,
    subsystem_definitions: Object.freeze([...(profile.subsystem_definitions || []), ...BASE_SUBSYSTEM_DEFINITIONS]),
    subsystem_priority: Object.freeze({
      ...BASE_SUBSYSTEM_PRIORITY,
      ...(profile.subsystem_priority || {}),
    }),
    subsystem_guidance: Object.freeze({
      ...BASE_SUBSYSTEM_GUIDANCE,
      ...(profile.subsystem_guidance || {}),
    }),
    flow_definitions: Object.freeze([...(profile.flow_definitions || [])]),
    flow_guidance: Object.freeze({ ...(profile.flow_guidance || {}) }),
    validation_commands: Object.freeze({ ...(profile.validation_commands || {}) }),
    base_profile_id: profile.base_profile_id || null,
    override_applied: profile.override_applied === true,
    override_repo_path: profile.override_repo_path || null,
    override_notes: Object.freeze([...(profile.override_notes || [])]),
  });
}

function resolveStudyProfile({ repoMetadata, trackedFiles, workingDirectory }) {
  let selected = null;
  for (const profile of STUDY_PROFILES) {
    if (typeof profile.matches === 'function' && profile.matches({ repoMetadata, trackedFiles })) {
      selected = profile;
      break;
    }
  }
  const baseProfile = mergeProfile(selected || GENERIC_PROFILE);
  const override = readStudyProfileOverride(workingDirectory);
  return mergeProfile(mergeStudyProfiles(baseProfile, override));
}

module.exports = {
  STUDY_PROFILE_OVERRIDE_FILE,
  STUDY_PROFILES,
  resolveStudyProfile,
  getStudyProfileOverridePath,
  readStudyProfileOverride,
  createStudyProfileOverrideTemplate,
  sanitizeStudyProfileOverride,
  detectStudyProfileSignals,
};
