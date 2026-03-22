/**
 * Workflow template handlers (template CRUD, instantiation, and template helpers)
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../../database');
const { safeLimit, ErrorCodes, makeError } = require('../shared');

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create a workflow template
 */
function handleCreateWorkflowTemplate(args) {
  // Check if name already exists
  const existing = db.getWorkflowTemplateByName(args.name);
  if (existing) {
    return {
      ...makeError(ErrorCodes.CONFLICT, `Template with name '${args.name}' already exists`)
    };
  }

  const templateId = uuidv4();

  db.createWorkflowTemplate({
    id: templateId,
    name: args.name,
    description: args.description,
    task_definitions: args.task_definitions,
    dependency_graph: args.dependency_graph,
    variables: args.variables
  });

  let output = `## Workflow Template Created\n\n`;
  output += `**ID:** ${templateId}\n`;
  output += `**Name:** ${args.name}\n`;
  output += `**Tasks:** ${args.task_definitions.length}\n`;
  if (args.variables) {
    output += `**Variables:** ${Object.keys(args.variables).join(', ')}\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * List workflow templates
 */
function handleListWorkflowTemplates(args) {
  const templates = db.listWorkflowTemplates({
    filter: args.filter,
    limit: safeLimit(args.limit, 20)
  });

  if (templates.length === 0) {
    return {
      content: [{ type: 'text', text: `No workflow templates found.` }]
    };
  }

  let output = `## Workflow Templates\n\n`;
  output += `| Name | Tasks | Description |\n`;
  output += `|------|-------|-------------|\n`;

  for (const t of templates) {
    const desc = t.description ? t.description.substring(0, 40) : '-';
    output += `| ${t.name} | ${t.task_definitions.length} | ${desc} |\n`;
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Instantiate a workflow from template
 */
function handleInstantiateTemplate(args) {
  // Find template by ID or name
  let template = db.getWorkflowTemplate(args.template_id);
  if (!template) {
    template = db.getWorkflowTemplateByName(args.template_id);
  }
  if (!template) {
    return {
      ...makeError(ErrorCodes.TEMPLATE_NOT_FOUND, `Template not found: ${args.template_id}`)
    };
  }

  // Create workflow
  const workflowId = uuidv4();
  const workflowName = args.name || `${template.name}-${new Date().toISOString().slice(0, 10)}`;
  const taskDefinitions = Array.isArray(template.task_definitions) ? template.task_definitions : [];

  if (taskDefinitions.length === 0) {
    const duplicatePlaceholder = db.findEmptyWorkflowPlaceholder(workflowName, 'pending');
    if (duplicatePlaceholder) {
      return {
        ...makeError(
          ErrorCodes.CONFLICT,
          `Workflow '${workflowName}' already has an empty pending placeholder (${duplicatePlaceholder.id}). Add task_definitions to template '${template.name}' and reuse or delete the placeholder instead of creating another empty workflow.`
        )
      };
    }

    return {
      ...makeError(
        ErrorCodes.INVALID_PARAM,
        `Template '${template.name}' has no task_definitions, so it cannot create a workflow. Add at least one task definition before instantiating this template.`
      )
    };
  }

  db.createWorkflow({
    id: workflowId,
    name: workflowName,
    description: template.description,
    template_id: template.id
  });

  // Variable substitution helper
  const vars = args.variables || {};
  const substitute = (str) => {
    if (!str) return str;
    return str.replace(/\{\{([\w.-]+)\}\}/g, (match, varName) => {
      return vars[varName] !== undefined ? vars[varName] : match;
    });
  };

  // Create tasks from definitions
  const nodeToTaskMap = {};
  for (const taskDef of taskDefinitions) {
    const taskId = uuidv4();
    const deps = (template.dependency_graph || {})[taskDef.node_id] || [];
    const hasDeps = deps.length > 0;

    db.createTask({
      id: taskId,
      status: hasDeps ? 'blocked' : 'pending',
      task_description: substitute(taskDef.task_description),
      timeout_minutes: taskDef.timeout_minutes || 30,
      auto_approve: taskDef.auto_approve || false,
      tags: taskDef.tags ? taskDef.tags.map(substitute) : null,
      workflow_id: workflowId,
      workflow_node_id: taskDef.node_id
    });

    nodeToTaskMap[taskDef.node_id] = taskId;
  }

  // Add dependencies
  for (const [nodeId, deps] of Object.entries(template.dependency_graph)) {
    const taskId = nodeToTaskMap[nodeId];
    if (!taskId) continue;

    for (const dep of deps) {
      const depTaskId = nodeToTaskMap[dep.node];
      if (!depTaskId) continue;

      db.addTaskDependency({
        workflow_id: workflowId,
        task_id: taskId,
        depends_on_task_id: depTaskId,
        condition_expr: dep.condition,
        on_fail: dep.on_fail || 'skip'
      });
    }
  }

  // Update counts
  db.updateWorkflowCounts(workflowId);

  // Auto-run if requested
  if (args.auto_run) {
    const { handleRunWorkflow } = require('./index');
    if (typeof handleRunWorkflow === 'function') {
      const runResult = handleRunWorkflow({ workflow_id: workflowId });
      if (runResult?.isError) {
        return runResult;
      }
    }
  }

  let output = `## Workflow Created from Template\n\n`;
  output += `**Workflow ID:** ${workflowId}\n`;
  output += `**Name:** ${workflowName}\n`;
  output += `**Template:** ${template.name}\n`;
  output += `**Tasks Created:** ${taskDefinitions.length}\n`;
  if (args.auto_run) output += `**Status:** Running\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Delete a workflow template
 */
function handleDeleteWorkflowTemplate(args) {
  const deleted = db.deleteWorkflowTemplate(args.template_id);

  if (!deleted) {
    return {
      ...makeError(ErrorCodes.TEMPLATE_NOT_FOUND, `Template not found: ${args.template_id}`)
    };
  }

  return {
    content: [{ type: 'text', text: `Template deleted: ${args.template_id}` }]
  };
}


/**
 * Create a conditional template
 */
function handleCreateConditionalTemplate(args) {
  const { template_id, condition_type, condition_expr, then_block, else_block } = args;

  // Input validation
  if (!template_id || typeof template_id !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'template_id must be a non-empty string');
  }
  if (!condition_type || !['if', 'switch', 'when'].includes(condition_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'condition_type must be "if", "switch", or "when"');
  }
  if (!condition_expr || typeof condition_expr !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'condition_expr must be a non-empty string');
  }

  const condition = db.createTemplateCondition({
    id: uuidv4(),
    template_id,
    condition_type,
    condition_expr,
    then_block: then_block || null,
    else_block: else_block || null
  });

  let output = `## Conditional Template Created\n\n`;
  output += `**Condition ID:** \`${condition.id}\`\n`;
  output += `**Template:** ${template_id}\n`;
  output += `**Type:** ${condition_type}\n`;
  output += `**Expression:** \`${condition_expr}\`\n`;
  if (then_block) output += `**Then:** ${then_block.substring(0, 100)}...\n`;
  if (else_block) output += `**Else:** ${else_block.substring(0, 100)}...\n`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Iterate a template over an array
 */
function handleTemplateLoop(args) {
  const { template_id, items, variable_name = 'item', parallel = false } = args;

  // Input validation
  if (!template_id || typeof template_id !== 'string') {
    return makeError(ErrorCodes.INVALID_PARAM, 'template_id must be a non-empty string');
  }
  if (!Array.isArray(items) || items.length === 0) {
    return makeError(ErrorCodes.INVALID_PARAM, 'items must be a non-empty array');
  }
  if (items.length > 100) {
    return makeError(ErrorCodes.INVALID_PARAM, 'items must have 100 or fewer elements');
  }

  // Get template
  const template = db.getTemplate(template_id) || db.getWorkflowTemplateByName(template_id);
  if (!template) {
    return makeError(ErrorCodes.TEMPLATE_NOT_FOUND, `Template not found: ${template_id}`);
  }

  const taskIds = [];
  const taskTemplate = template.task_template || template.task_definitions;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // Substitute variable in template
    const escapedVariable = escapeRegex(variable_name);
    const task = taskTemplate.replace(new RegExp(`\\$\\{${escapedVariable}\\}`, 'g'), item)
                             .replace(new RegExp(`\\$\\{index\\}`, 'g'), i.toString());

    const taskId = uuidv4();
    db.createTask({
      id: taskId,
      task_description: task,
      template_name: template_id,
      status: 'queued'
    });
    taskIds.push(taskId);
  }

  let output = `## Template Loop Executed\n\n`;
  output += `**Template:** ${template_id}\n`;
  output += `**Items:** ${items.length}\n`;
  output += `**Variable:** \`${variable_name}\`\n`;
  output += `**Parallel:** ${parallel}\n\n`;
  output += `### Created Tasks\n\n`;
  for (let i = 0; i < Math.min(5, taskIds.length); i++) {
    output += `- \`${taskIds[i]}\` - ${items[i]}\n`;
  }
  if (taskIds.length > 5) {
    output += `- ... and ${taskIds.length - 5} more\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

function createWorkflowTemplatesHandlers(deps) {
  return {
    handleCreateWorkflowTemplate,
    handleListWorkflowTemplates,
    handleInstantiateTemplate,
    handleDeleteWorkflowTemplate,
    handleCreateConditionalTemplate,
    handleTemplateLoop,
  };
}

module.exports = {
  handleCreateWorkflowTemplate,
  handleListWorkflowTemplates,
  handleInstantiateTemplate,
  handleDeleteWorkflowTemplate,
  handleCreateConditionalTemplate,
  handleTemplateLoop,
  createWorkflowTemplatesHandlers,
};
