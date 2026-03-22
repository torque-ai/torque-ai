/** MCP + REST handlers for Strategic Brain configuration */

'use strict';

const logger = require('../logger').child({ component: 'strategic-config' });

function getConfigLoader() {
  return require('../orchestrator/config-loader');
}

function makeTextResult(message, isError = false) {
  const payload = [{ type: 'text', text: typeof message === 'string' ? message : JSON.stringify(message, null, 2) }];
  return isError ? { isError: true, content: payload } : { content: payload };
}

function resolveWorkingDirectory(args) {
  if (args.working_directory) return args.working_directory;
  // Try to resolve from project defaults
  try {
    const db = require('../database');
    if (typeof db.getProjectDefaults === 'function') {
      const defaults = db.getProjectDefaults();
      if (defaults && defaults.working_directory) return defaults.working_directory;
    }
  } catch (_e) { /* best effort — db may not be initialized */ }
  return null;
}

function addSources(merged, project, user, defaults) {
  // Annotate each top-level section with _sources showing origin
  const sources = {};

  for (const section of ['decompose', 'diagnose', 'review']) {
    if (!merged[section] || typeof merged[section] !== 'object') continue;
    const sectionSources = {};
    for (const key of Object.keys(merged[section])) {
      if (key.startsWith('_')) continue;
      if (project?.[section]?.[key] !== undefined) {
        sectionSources[key] = 'project';
      } else if (user?.[section]?.[key] !== undefined) {
        sectionSources[key] = 'user';
      } else {
        sectionSources[key] = 'default';
      }
    }
    sources[section] = sectionSources;
  }

  // Top-level fields
  for (const key of ['provider', 'model', 'confidence_threshold', 'temperature', 'template']) {
    if (project?.[key] !== undefined) {
      sources[key] = 'project';
    } else if (user?.[key] !== undefined) {
      sources[key] = 'user';
    } else {
      sources[key] = 'default';
    }
  }

  return sources;
}

function handleConfigGet(args) {
  try {
    const configLoader = getConfigLoader();
    const workingDir = resolveWorkingDirectory(args);
    const merged = configLoader.resolveConfig(workingDir);
    const project = configLoader.loadProjectConfig(workingDir);
    const user = configLoader.loadUserConfig();
    const defaults = configLoader.loadDefaultConfig();
    const _sources = addSources(merged, project, user, defaults);

    return makeTextResult({ ...merged, _sources });
  } catch (err) {
    return makeTextResult(`Failed to load config: ${err.message}`, true);
  }
}

function handleConfigSet(args) {
  const workingDir = resolveWorkingDirectory(args);
  if (!workingDir) {
    return makeTextResult('working_directory is required', true);
  }

  const config = args.config;
  if (!config || typeof config !== 'object') {
    return makeTextResult('config must be an object', true);
  }

  try {
    const configLoader = getConfigLoader();
    const validation = configLoader.validateConfig(config);
    if (!validation.valid) {
      return makeTextResult(`Validation failed: ${validation.errors.join(', ')}`, true);
    }

    configLoader.saveProjectConfig(workingDir, config);
    logger.info(`Strategic config saved for ${workingDir}`);
    return makeTextResult({ status: 'saved', working_directory: workingDir });
  } catch (err) {
    return makeTextResult(`Failed to save config: ${err.message}`, true);
  }
}

function handleConfigReset(args) {
  const workingDir = resolveWorkingDirectory(args);
  if (!workingDir) {
    return makeTextResult('working_directory is required', true);
  }

  try {
    const configLoader = getConfigLoader();
    const deleted = configLoader.deleteProjectConfig(workingDir);
    logger.info(`Strategic config ${deleted ? 'reset' : 'already clear'} for ${workingDir}`);
    return makeTextResult({ status: deleted ? 'reset' : 'already_clear', working_directory: workingDir });
  } catch (err) {
    return makeTextResult(`Failed to reset config: ${err.message}`, true);
  }
}

function handleConfigTemplates(args) {
  try {
    const configLoader = getConfigLoader();
    const workingDir = resolveWorkingDirectory(args);
    const templates = configLoader.listTemplates(workingDir);
    return makeTextResult(templates);
  } catch (err) {
    return makeTextResult(`Failed to list templates: ${err.message}`, true);
  }
}

function handleConfigApplyTemplate(args) {
  const workingDir = resolveWorkingDirectory(args);
  if (!workingDir) {
    return makeTextResult('working_directory is required', true);
  }

  const templateName = args.template_name;
  if (!templateName) {
    return makeTextResult('template_name is required', true);
  }

  try {
    const configLoader = getConfigLoader();
    const template = configLoader.loadTemplate(templateName);
    if (!template) {
      return makeTextResult(`Template not found: ${templateName}`, true);
    }

    // Extract config-relevant fields from template (exclude test_samples, name, description, source)
    const config = { template: templateName };
    if (template.decompose) config.decompose = template.decompose;
    if (template.diagnose) config.diagnose = template.diagnose;
    if (template.review) config.review = template.review;

    configLoader.saveProjectConfig(workingDir, config);
    logger.info(`Applied template '${templateName}' to ${workingDir}`);
    return makeTextResult({ status: 'applied', template: templateName, working_directory: workingDir });
  } catch (err) {
    return makeTextResult(`Failed to apply template: ${err.message}`, true);
  }
}

// MCP tool handler dispatch map
const toolHandlers = {
  strategic_config_get: (args) => handleConfigGet(args),
  strategic_config_set: (args) => handleConfigSet(args),
  strategic_config_templates: (args) => handleConfigTemplates(args),
  strategic_config_apply_template: (args) => handleConfigApplyTemplate(args),
};

function createStrategicConfigHandlers() {
  return {
    toolDefs: require('../tool-defs/strategic-config-defs'),
    toolHandlers,
    handleConfigGet,
    handleConfigSet,
    handleConfigReset,
    handleConfigTemplates,
    handleConfigApplyTemplate,
  };
}

module.exports = {
  toolDefs: require('../tool-defs/strategic-config-defs'),
  toolHandlers,
  handleConfigGet,
  handleConfigSet,
  handleConfigReset,
  handleConfigTemplates,
  handleConfigApplyTemplate,
  createStrategicConfigHandlers,
};
