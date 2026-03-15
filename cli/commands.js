const { apiGet, apiPost, apiDelete, ApiError } = require('./api-client');

function encodePath(value) {
  return encodeURIComponent(String(value || '').trim());
}

function buildQuery(params = {}) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    query.set(key, String(value));
  }

  const rendered = query.toString();
  return rendered ? `?${rendered}` : '';
}

function missingArgument(message) {
  const error = new Error(message);
  error.code = 'INVALID_USAGE';
  return error;
}

async function handleStatus(_args, context) {
  const [health, runningTasks] = await Promise.all([
    apiGet('/healthz'),
    apiGet('/api/tasks?status=running&limit=5'),
  ]);

  return {
    command: 'status',
    raw: { health, runningTasks },
  };
}

async function handleSubmit(args, context) {
  const description = String(args.description || '').trim();
  if (!description) {
    throw missingArgument('submit requires a task description');
  }

  if (args.dryRun) {
    const raw = await apiPost('/api/tools/test_routing', {
      task_description: description,
      working_directory: context.cwd,
    });
    return {
      command: 'dry_run',
      raw,
    };
  }

  if (description.length < 20 && !/\.[a-zA-Z]{1,5}\b/.test(description)) {
    process.stderr.write('Tip: Include file names and specific details for better results.\n');
  }

  const raw = await apiPost('/api/tasks', {
    task: description,
    provider: args.provider,
    model: args.model,
    working_directory: context.cwd,
  });

  return {
    command: 'submit',
    raw,
  };
}

async function handleList(args) {
  const raw = await apiGet(`/api/tasks${buildQuery({
    status: args.status,
    limit: 20,
  })}`);

  return {
    command: 'list',
    raw,
  };
}

async function handleResult(args) {
  const taskId = String(args.taskId || '').trim();
  if (!taskId) {
    throw missingArgument('result requires a task id');
  }

  const raw = await apiGet(`/api/tasks/${encodePath(taskId)}`);
  return {
    command: 'result',
    raw,
  };
}

async function handleCancel(args) {
  const taskId = String(args.taskId || '').trim();
  if (!taskId) {
    throw missingArgument('cancel requires a task id');
  }

  const raw = await apiDelete(`/api/tasks/${encodePath(taskId)}${buildQuery({ confirm: true })}`);
  return {
    command: 'cancel',
    raw,
  };
}

async function handleWorkflowCreate(args) {
  const name = String(args.name || '').trim();
  if (!name) {
    throw missingArgument('workflow create requires a workflow name');
  }

  // Collect tasks from --task flags or remaining positional args
  const tasks = [];
  if (Array.isArray(args.task)) {
    for (const t of args.task) {
      const trimmed = String(t).trim();
      if (trimmed) tasks.push(trimmed);
    }
  } else if (args.task) {
    const trimmed = String(args.task).trim();
    if (trimmed) tasks.push(trimmed);
  }
  if (Array.isArray(args._positional)) {
    for (const t of args._positional) {
      const trimmed = String(t).trim();
      if (trimmed) tasks.push(trimmed);
    }
  }

  if (tasks.length === 0) {
    throw missingArgument(
      'workflow create requires at least one task.\n' +
      'Usage: torque workflow create <name> --task "task description"\n' +
      '       torque workflow create <name> --task "task 1" --task "task 2"'
    );
  }

  const body = {
    name,
    tasks: tasks.map(t => ({ description: t })),
  };

  const raw = await apiPost('/api/workflows', body);
  return { command: 'workflow_create', raw };
}

async function handleWorkflowAddTask(args) {
  const workflowId = String(args.workflowId || '').trim();
  if (!workflowId) {
    throw missingArgument('workflow add-task requires a workflow id');
  }
  const description = String(args.description || '').trim();
  if (!description) {
    throw missingArgument('workflow add-task requires a task description');
  }

  const body = { description };
  if (args.depends_on) {
    body.depends_on = Array.isArray(args.depends_on) ? args.depends_on : [args.depends_on];
  }

  const raw = await apiPost(`/api/workflows/${encodePath(workflowId)}/tasks`, body);
  return { command: 'workflow_add_task', raw };
}

async function handleWorkflowRun(args) {
  const workflowId = String(args.workflowId || '').trim();
  if (!workflowId) {
    throw missingArgument('workflow run requires a workflow id');
  }

  const raw = await apiPost(`/api/workflows/${encodePath(workflowId)}/run`, {});
  return { command: 'workflow_run', raw };
}

async function handleWorkflowStatus(args) {
  const workflowId = String(args.workflowId || '').trim();
  if (!workflowId) {
    throw missingArgument('workflow status requires a workflow id');
  }

  const raw = await apiGet(`/api/workflows/${encodePath(workflowId)}`);
  return { command: 'workflow_status', raw };
}

async function handleDecompose(args, context) {
  const featureName = String(args.feature || '').trim();
  const workingDirectory = String(args.directory || context.cwd || '').trim();

  if (!featureName) {
    throw missingArgument('decompose requires a feature description');
  }

  const raw = await apiPost('/api/tools/strategic_decompose', {
    feature: featureName,
    working_directory: workingDirectory,
    provider: args.provider,
    model: args.model,
  });

  return { command: 'decompose', raw };
}

async function handleDiagnose(args) {
  const taskId = String(args.taskId || '').trim();
  if (!taskId) {
    throw missingArgument('diagnose requires a task id');
  }

  const raw = await apiPost('/api/tools/strategic_diagnose', {
    task_id: taskId,
    strategic_provider: args.provider,
  });

  return { command: 'diagnose', raw };
}

async function handleReview(args) {
  const taskId = String(args.taskId || '').trim();
  if (!taskId) {
    throw missingArgument('review requires a task id');
  }

  const raw = await apiPost('/api/tools/strategic_review', {
    task_id: taskId,
    strategic_provider: args.provider,
  });

  return { command: 'review', raw };
}

async function handleBenchmark(args) {
  const raw = await apiPost('/api/tools/strategic_benchmark', {
    suite: args.suite || 'all',
    provider: args.provider,
    model: args.model,
  });

  return { command: 'benchmark', raw };
}

async function handleAwait(args) {
  const taskId = String(args.taskId || '').trim();
  if (!taskId) {
    throw missingArgument('await requires a task id');
  }

  const pollMs = Math.max(2000, parseInt(args.poll || '3000', 10));
  const timeoutMs = parseInt(args.timeout || '600000', 10);
  const start = Date.now();
  const log = args._log || (() => {});

  log(`Waiting for task ${taskId}...`);

  while (Date.now() - start < timeoutMs) {
    const raw = await apiGet(`/api/tasks/${encodePath(taskId)}`);
    const text = typeof raw === 'string' ? raw : (raw?.result || raw?.content?.[0]?.text || '');
    const statusMatch = text.match(/\*\*Status:\*\*\s*(\w+)/i) || text.match(/Status\s*\|\s*(\w+)/i);
    const status = statusMatch ? statusMatch[1].toLowerCase() : null;

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      return { command: 'result', raw };
    }

    log(`  ...${status || 'checking'} (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  throw new Error(`Timed out waiting for task ${taskId} after ${Math.round(timeoutMs / 1000)}s`);
}

async function handleHealth() {
  const raw = await apiGet('/healthz');
  return {
    command: 'health',
    raw,
  };
}

async function executeCommand(parsed, context = {}) {
  switch (parsed.command) {
    case 'status':
      return handleStatus(parsed, context);
    case 'submit':
      return handleSubmit(parsed, context);
    case 'list':
      return handleList(parsed, context);
    case 'result':
      return handleResult(parsed, context);
    case 'cancel':
      return handleCancel(parsed, context);
    case 'workflow_create':
      return handleWorkflowCreate(parsed, context);
    case 'workflow_add_task':
      return handleWorkflowAddTask(parsed, context);
    case 'workflow_run':
      return handleWorkflowRun(parsed, context);
    case 'workflow_status':
      return handleWorkflowStatus(parsed, context);
    case 'decompose':
      return handleDecompose(parsed, context);
    case 'diagnose':
      return handleDiagnose(parsed, context);
    case 'review':
      return handleReview(parsed, context);
    case 'benchmark':
      return handleBenchmark(parsed, context);
    case 'await':
      return handleAwait(parsed, context);
    case 'health':
      return handleHealth(parsed, context);
    default:
      throw missingArgument(`Unknown command: ${parsed.command}`);
  }
}

module.exports = {
  encodePath,
  buildQuery,
  handleStatus,
  handleSubmit,
  handleList,
  handleResult,
  handleCancel,
  handleWorkflowCreate,
  handleWorkflowAddTask,
  handleWorkflowRun,
  handleWorkflowStatus,
  handleDecompose,
  handleDiagnose,
  handleReview,
  handleAwait,
  handleBenchmark,
  executeCommand,
  missingArgument,
};
