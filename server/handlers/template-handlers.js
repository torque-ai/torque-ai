'use strict';

function getDefaultContainer() {
  try {
    const containerModule = require('../container');
    return containerModule && containerModule.defaultContainer ? containerModule.defaultContainer : null;
  } catch (_e) {
    return null;
  }
}

function resolveProjectCandidates(projectConfigCore, workingDirectory) {
  const candidates = [];

  if (!workingDirectory || typeof workingDirectory !== 'string') {
    return candidates;
  }

  if (projectConfigCore && typeof projectConfigCore.getCurrentProject === 'function') {
    const currentProject = projectConfigCore.getCurrentProject(workingDirectory);
    if (currentProject) {
      candidates.push(currentProject);
    }
  }

  candidates.push(workingDirectory);
  return [...new Set(candidates)];
}

function persistDetectedTemplate(db, projectConfigCore, workingDirectory, templateId) {
  if (!db || typeof db.prepare !== 'function') {
    return false;
  }
  if (!templateId || typeof templateId !== 'string') {
    return false;
  }

  const now = new Date().toISOString();
  const candidates = resolveProjectCandidates(projectConfigCore, workingDirectory);
  if (candidates.length === 0) {
    return false;
  }

  const statement = db.prepare(`
    INSERT INTO project_config (project, detected_template, detected_template_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project) DO UPDATE SET
      detected_template = excluded.detected_template,
      detected_template_at = excluded.detected_template_at,
      updated_at = excluded.updated_at
  `);

  for (const project of candidates) {
    statement.run(project, templateId, now, now, now);
  }

  return true;
}

async function handleGetProjectTemplate(args) {
  try {
    const container = getDefaultContainer();
    if (!container) {
      return { content: [{ type: 'text', text: 'Template services unavailable' }], isError: true };
    }

    const projectConfigCore = container.get('projectConfigCore');
    const templateRegistry = container.get('templateRegistry');

    if (!projectConfigCore || !templateRegistry) {
      return { content: [{ type: 'text', text: 'Template services unavailable' }], isError: true };
    }

    const workingDirectory = args.working_directory;
    const candidates = resolveProjectCandidates(projectConfigCore, workingDirectory);
    let project = null;
    let detectedTemplateId = null;

    for (const candidate of candidates) {
      const config = projectConfigCore.getProjectConfig(candidate);
      if (config && config.detected_template) {
        project = candidate;
        detectedTemplateId = config.detected_template;
        break;
      }
    }

    if (!project) {
      return { content: [{ type: 'text', text: `No project template detected yet for ${workingDirectory}. Run detect_project_type first.` }] };
    }

    const template = templateRegistry.getTemplate(detectedTemplateId);
    if (!template) {
      return {
        content: [{ type: 'text', text: `Detected template "${detectedTemplateId}" is no longer available in the registry.` }],
        isError: true,
      };
    }

    const text = `## Project Template for ${project}\n\n` +
      `**Template ID:** ${template.id}\n` +
      `**Template Name:** ${template.name}\n` +
      `**Category:** ${template.category}\n` +
      `**Priority:** ${template.priority}\n\n` +
      `## Agent Context\n\n\`\`\`\n${template.agent_context || '(not provided)'}\n\`\`\`\n\n` +
      `**Suggested verify command:** ${template.verify_command_suggestion || '(not provided)'}`;

    return {
      content: [{ type: 'text', text }],
      structuredData: template,
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Template error: ${err.message}` }] };
  }
}

function handleListTemplates(_args) {
  const container = getDefaultContainer();
  if (!container) {
    return { content: [{ type: 'text', text: 'Template services unavailable' }], isError: true };
  }

  const templateRegistry = container.get('templateRegistry');
  if (!templateRegistry || typeof templateRegistry.getAllTemplates !== 'function') {
    return { content: [{ type: 'text', text: 'Template registry unavailable' }], isError: true };
  }

  const templates = templateRegistry.getAllTemplates();
  if (!Array.isArray(templates) || templates.length === 0) {
    return { content: [{ type: 'text', text: 'No templates found.' }] };
  }

  let text = '## Project Templates\n\n';
  text += '| ID | Name | Category | Priority | Markers | Dependencies |\n';
  text += '|---|---|---|---|---|---|\n';
  for (const template of templates) {
    const markers = (template.markers || template.detection?.files || []).join(', ');
    const dependencies = (template.dependencies || template.detection?.dependencies || []).map((entry) => `${entry.file}#${entry.key}`).join(', ');
    text += `| ${template.id} | ${template.name} | ${template.category || ''} | ${template.priority} | ${markers} | ${dependencies} |\n`;
  }

  return {
    content: [{ type: 'text', text }],
    structuredData: templates,
  };
}

async function handleDetectProjectType(args) {
  try {
    const container = getDefaultContainer();
    if (!container) {
      return { content: [{ type: 'text', text: 'Template services unavailable' }], isError: true };
    }

    const projectDetector = container.get('projectDetector');
    const projectConfigCore = container.get('projectConfigCore');
    const templateRegistry = container.get('templateRegistry');
    const db = container.get('db');

    if (!projectDetector || typeof projectDetector.detectProjectType !== 'function') {
      return { content: [{ type: 'text', text: 'Project detector unavailable' }], isError: true };
    }
    if (!templateRegistry || typeof templateRegistry.getTemplate !== 'function') {
      return { content: [{ type: 'text', text: 'Template registry unavailable' }], isError: true };
    }

    const workingDirectory = args.working_directory;
    const detection = projectDetector.detectProjectType(workingDirectory);
    if (!detection || !detection.template) {
      return { content: [{ type: 'text', text: `No project template detected in ${workingDirectory}.` }] };
    }

    const template = detection.template;
    const templateId = template.id;
    persistDetectedTemplate(db, projectConfigCore, workingDirectory, templateId);

    const text = `## Project Type Detected: ${template.name || template.id}\n\n` +
      `**Template ID:** ${template.id}\n` +
      `**Priority:** ${template.priority}\n` +
      `**Score:** ${detection.score}\n` +
      `**Confidence:** ${detection.confidence ?? 'N/A'}\n\n` +
      `### Agent Context\n\n\`\`\`\n${template.agent_context || '(not provided)'}\n\`\`\`\n`;

    return {
      content: [{ type: 'text', text }],
      structuredData: detection,
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Project detection error: ${err.message}` }] };
  }
}

module.exports = {
  handleGetProjectTemplate,
  handleListTemplates,
  handleDetectProjectType,
};
