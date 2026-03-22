/**
 * LLM tuning and model configuration handlers
 * Extracted from provider-handlers.js
 */

const database = require('../database');
const hostManagement = require('../db/host-management');
const serverConfig = require('../config');
serverConfig.init({ db: database });
const { ErrorCodes, makeError } = require('./error-codes');

/**
 * Get current LLM tuning parameters
 * @param {Object} _args - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetLlmTuning(_args) {
  const tuning = {
    // Ollama parameters
    ollama_temperature: serverConfig.get('ollama_temperature') || '0.3',
    ollama_num_ctx: serverConfig.get('ollama_num_ctx') || '8192',
    ollama_top_p: serverConfig.get('ollama_top_p') || '0.9',
    ollama_top_k: serverConfig.get('ollama_top_k') || '40',
    ollama_repeat_penalty: serverConfig.get('ollama_repeat_penalty') || '1.1',
    ollama_num_predict: serverConfig.get('ollama_num_predict') || '-1',
    ollama_mirostat: serverConfig.get('ollama_mirostat') || '0',
    ollama_mirostat_tau: serverConfig.get('ollama_mirostat_tau') || '5.0',
    ollama_mirostat_eta: serverConfig.get('ollama_mirostat_eta') || '0.1',
    ollama_seed: serverConfig.get('ollama_seed') || '-1',
    ollama_preset: serverConfig.get('ollama_preset') || 'code',
  };

  let output = `## LLM Tuning Parameters\n\n`;
  output += `**Active Preset:** \`${tuning.ollama_preset}\`\n\n`;

  output += `### Ollama (Direct API)\n`;
  output += `| Parameter | Value | Description |\n`;
  output += `|-----------|-------|-------------|\n`;
  output += `| temperature | ${tuning.ollama_temperature} | Generation randomness (0.1-1.0) |\n`;
  output += `| num_ctx | ${tuning.ollama_num_ctx} | Context window size |\n`;
  output += `| top_p | ${tuning.ollama_top_p} | Nucleus sampling threshold |\n`;
  output += `| top_k | ${tuning.ollama_top_k} | Top-k vocabulary limit |\n`;
  output += `| repeat_penalty | ${tuning.ollama_repeat_penalty} | Repetition penalty |\n`;
  output += `| num_predict | ${tuning.ollama_num_predict} | Max tokens (-1=unlimited) |\n`;
  output += `| mirostat | ${tuning.ollama_mirostat} | Adaptive sampling (0=off, 2=best) |\n`;
  output += `| mirostat_tau | ${tuning.ollama_mirostat_tau} | Target entropy |\n`;
  output += `| mirostat_eta | ${tuning.ollama_mirostat_eta} | Learning rate |\n`;
  output += `| seed | ${tuning.ollama_seed} | Random seed (-1=random) |\n\n`;

  output += `### Available Presets\n`;
  output += `| Preset | Temp | Top-K | Mirostat | Context | Use Case |\n`;
  output += `|--------|------|-------|----------|---------|----------|\n`;
  output += `| code | 0.3 | 40 | off | 8192 | Code generation/editing |\n`;
  output += `| precise | 0.1 | 20 | off | 8192 | Deterministic output |\n`;
  output += `| creative | 0.8 | 60 | off | 4096 | Creative/varied text |\n`;
  output += `| balanced | 0.5 | 40 | v2 | 8192 | Consistent quality |\n`;
  output += `| fast | 0.3 | 40 | off | 4096 | Speed over quality |\n\n`;

  output += `Use \`set_llm_tuning\` or \`apply_llm_preset\` to modify.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Set LLM tuning parameters
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetLlmTuning(args) {
  const updates = [];

  // Handle preset first (if provided, apply preset then override with explicit params)
  if (args.preset !== undefined) {
    const presetsJson = serverConfig.get('ollama_presets');
    if (!presetsJson) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'No presets configured');
    }
    let presets;
    try {
      presets = JSON.parse(presetsJson);
    } catch (err) {
      return makeError(ErrorCodes.INVALID_PARAM, `Invalid provider tuning presets JSON: ${err.message}`);
    }

    if (!presets || typeof presets !== 'object' || Array.isArray(presets)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'Invalid provider tuning presets format: expected an object');
    }

    const preset = presets[args.preset];
    if (!preset) {
      return makeError(ErrorCodes.INVALID_PARAM, `Unknown preset: ${args.preset}. Available: ${Object.keys(presets).join(', ')}`);
    }
    // Apply preset values
    if (preset.temperature !== undefined) database.setConfig('ollama_temperature', preset.temperature.toString());
    if (preset.top_p !== undefined) database.setConfig('ollama_top_p', preset.top_p.toString());
    if (preset.top_k !== undefined) database.setConfig('ollama_top_k', preset.top_k.toString());
    if (preset.repeat_penalty !== undefined) database.setConfig('ollama_repeat_penalty', preset.repeat_penalty.toString());
    if (preset.num_ctx !== undefined) database.setConfig('ollama_num_ctx', preset.num_ctx.toString());
    if (preset.mirostat !== undefined) database.setConfig('ollama_mirostat', preset.mirostat.toString());
    database.setConfig('ollama_preset', args.preset);
    updates.push(`preset → ${args.preset}`);
  }

  if (args.temperature !== undefined) {
    if (args.temperature < 0.1 || args.temperature > 1.0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'temperature must be between 0.1 and 1.0');
    }
    database.setConfig('ollama_temperature', args.temperature.toString());
    updates.push(`temperature → ${args.temperature}`);
  }

  if (args.num_ctx !== undefined) {
    if (args.num_ctx < 1024 || args.num_ctx > 32768) {
      return makeError(ErrorCodes.INVALID_PARAM, 'num_ctx must be between 1024 and 32768');
    }
    database.setConfig('ollama_num_ctx', args.num_ctx.toString());
    updates.push(`num_ctx → ${args.num_ctx}`);
  }

  if (args.top_p !== undefined) {
    if (args.top_p < 0.1 || args.top_p > 1.0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'top_p must be between 0.1 and 1.0');
    }
    database.setConfig('ollama_top_p', args.top_p.toString());
    updates.push(`top_p → ${args.top_p}`);
  }

  if (args.top_k !== undefined) {
    if (args.top_k < 1 || args.top_k > 100) {
      return makeError(ErrorCodes.INVALID_PARAM, 'top_k must be between 1 and 100');
    }
    database.setConfig('ollama_top_k', args.top_k.toString());
    updates.push(`top_k → ${args.top_k}`);
  }

  if (args.repeat_penalty !== undefined) {
    if (args.repeat_penalty < 1.0 || args.repeat_penalty > 2.0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'repeat_penalty must be between 1.0 and 2.0');
    }
    database.setConfig('ollama_repeat_penalty', args.repeat_penalty.toString());
    updates.push(`repeat_penalty → ${args.repeat_penalty}`);
  }

  if (args.num_predict !== undefined) {
    if (args.num_predict < -1 || args.num_predict > 16384) {
      return makeError(ErrorCodes.INVALID_PARAM, 'num_predict must be -1 (unlimited) or between 1 and 16384');
    }
    database.setConfig('ollama_num_predict', args.num_predict.toString());
    updates.push(`num_predict → ${args.num_predict === -1 ? 'unlimited' : args.num_predict}`);
  }

  if (args.mirostat !== undefined) {
    if (![0, 1, 2].includes(args.mirostat)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'mirostat must be 0 (off), 1 (v1), or 2 (v2)');
    }
    database.setConfig('ollama_mirostat', args.mirostat.toString());
    updates.push(`mirostat → ${args.mirostat === 0 ? 'off' : `v${args.mirostat}`}`);
  }

  if (args.mirostat_tau !== undefined) {
    if (args.mirostat_tau < 1.0 || args.mirostat_tau > 10.0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'mirostat_tau must be between 1.0 and 10.0');
    }
    database.setConfig('ollama_mirostat_tau', args.mirostat_tau.toString());
    updates.push(`mirostat_tau → ${args.mirostat_tau}`);
  }

  if (args.mirostat_eta !== undefined) {
    if (args.mirostat_eta < 0.01 || args.mirostat_eta > 1.0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'mirostat_eta must be between 0.01 and 1.0');
    }
    database.setConfig('ollama_mirostat_eta', args.mirostat_eta.toString());
    updates.push(`mirostat_eta → ${args.mirostat_eta}`);
  }

  if (args.seed !== undefined) {
    database.setConfig('ollama_seed', args.seed.toString());
    updates.push(`seed → ${args.seed === -1 ? 'random' : args.seed}`);
  }

  // Ollama host and auto-start settings
  if (args.host !== undefined) {
    database.setConfig('ollama_host', args.host);
    updates.push(`host → ${args.host}`);
  }

  if (args.auto_start_enabled !== undefined) {
    database.setConfig('ollama_auto_start_enabled', args.auto_start_enabled ? '1' : '0');
    updates.push(`auto_start_enabled → ${args.auto_start_enabled ? 'Yes' : 'No'}`);
  }

  if (args.auto_start_timeout_ms !== undefined) {
    if (args.auto_start_timeout_ms < 5000 || args.auto_start_timeout_ms > 60000) {
      return makeError(ErrorCodes.INVALID_PARAM, 'auto_start_timeout_ms must be between 5000 and 60000');
    }
    database.setConfig('ollama_auto_start_timeout_ms', args.auto_start_timeout_ms.toString());
    updates.push(`auto_start_timeout_ms → ${args.auto_start_timeout_ms}ms`);
  }

  if (args.binary_path !== undefined) {
    database.setConfig('ollama_binary_path', args.binary_path);
    updates.push(`binary_path → ${args.binary_path}`);
  }

  if (args.auto_detect_wsl_host !== undefined) {
    database.setConfig('ollama_auto_detect_wsl_host', args.auto_detect_wsl_host ? '1' : '0');
    updates.push(`auto_detect_wsl_host → ${args.auto_detect_wsl_host ? 'Yes' : 'No'}`);
  }

  if (updates.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## No Changes\n\nNo tuning parameters provided. Use \`get_llm_tuning\` to see current values.`
      }]
    };
  }

  let output = `## LLM Tuning Updated\n\n`;
  output += `**Changes applied:**\n`;
  updates.forEach(u => output += `- ${u}\n`);
  output += `\nChanges take effect immediately for new tasks.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Apply an LLM tuning preset
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleApplyLlmPreset(args) {
  const { preset } = args;
  if (!preset) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'preset is required');
  }

  const presetsJson = serverConfig.get('ollama_presets');
  if (!presetsJson) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'No presets configured');
  }

  let presets;
  try { presets = JSON.parse(presetsJson); } catch { presets = {}; }
  const presetConfig = presets[preset];
  if (!presetConfig) {
    return makeError(ErrorCodes.INVALID_PARAM, `Unknown preset: ${preset}. Available: ${Object.keys(presets).join(', ')}`);
  }

  // Apply all preset values
  const applied = [];
  if (presetConfig.temperature !== undefined) {
    database.setConfig('ollama_temperature', presetConfig.temperature.toString());
    applied.push(`temperature: ${presetConfig.temperature}`);
  }
  if (presetConfig.top_p !== undefined) {
    database.setConfig('ollama_top_p', presetConfig.top_p.toString());
    applied.push(`top_p: ${presetConfig.top_p}`);
  }
  if (presetConfig.top_k !== undefined) {
    database.setConfig('ollama_top_k', presetConfig.top_k.toString());
    applied.push(`top_k: ${presetConfig.top_k}`);
  }
  if (presetConfig.repeat_penalty !== undefined) {
    database.setConfig('ollama_repeat_penalty', presetConfig.repeat_penalty.toString());
    applied.push(`repeat_penalty: ${presetConfig.repeat_penalty}`);
  }
  if (presetConfig.num_ctx !== undefined) {
    database.setConfig('ollama_num_ctx', presetConfig.num_ctx.toString());
    applied.push(`num_ctx: ${presetConfig.num_ctx}`);
  }
  if (presetConfig.mirostat !== undefined) {
    database.setConfig('ollama_mirostat', presetConfig.mirostat.toString());
    applied.push(`mirostat: ${presetConfig.mirostat === 0 ? 'off' : `v${presetConfig.mirostat}`}`);
  }

  database.setConfig('ollama_preset', preset);

  let output = `## Preset Applied: ${preset}\n\n`;
  output += `**Settings:**\n`;
  applied.forEach(a => output += `- ${a}\n`);
  output += `\nChanges take effect immediately for new tasks.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * List all available LLM presets
 * @param {Object} _args - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleListLlmPresets(_args) {
  const presetsJson = serverConfig.get('ollama_presets');
  const currentPreset = serverConfig.get('ollama_preset') || 'code';

  if (!presetsJson) {
    return {
      content: [{
        type: 'text',
        text: `## No Presets Configured\n\nPresets have not been initialized.`
      }]
    };
  }

  let presets;
  try { presets = JSON.parse(presetsJson); } catch { presets = []; }

  let output = `## LLM Tuning Presets\n\n`;
  output += `**Current:** \`${currentPreset}\`\n\n`;
  output += `| Preset | Temp | Top-P | Top-K | Repeat | Context | Mirostat | Best For |\n`;
  output += `|--------|------|-------|-------|--------|---------|----------|----------|\n`;

  const descriptions = {
    code: 'Code generation/editing',
    precise: 'Deterministic output',
    creative: 'Creative/varied text',
    balanced: 'Consistent quality',
    fast: 'Speed over quality'
  };

  for (const [name, p] of Object.entries(presets)) {
    const marker = name === currentPreset ? '→ ' : '  ';
    output += `| ${marker}${name} | ${p.temperature} | ${p.top_p} | ${p.top_k} | ${p.repeat_penalty} | ${p.num_ctx} | ${p.mirostat === 0 ? 'off' : 'v' + p.mirostat} | ${descriptions[name] || ''} |\n`;
  }

  output += `\nUse \`apply_llm_preset preset="<name>"\` to switch.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Get model-specific tuning settings
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetModelSettings(args) {
  const { model } = args;
  const settingsJson = serverConfig.get('ollama_model_settings');

  if (!settingsJson) {
    return {
      content: [{
        type: 'text',
        text: `## No Model Settings Configured\n\nModel-specific settings have not been initialized.`
      }]
    };
  }

  let settings;
  try {
    settings = JSON.parse(settingsJson);
  } catch (err) {
    return makeError(ErrorCodes.INVALID_PARAM, `Invalid model settings JSON: ${err.message}`);
  }

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Invalid model settings format: expected an object');
  }

  if (model) {
    // Show specific model
    const modelSettings = settings[model];
    if (!modelSettings) {
      return {
        content: [{
          type: 'text',
          text: `## Model Not Found: ${model}\n\nAvailable models: ${Object.keys(settings).join(', ')}\n\nUse \`set_model_settings\` to add settings for this model.`
        }]
      };
    }

    let output = `## Model Settings: ${model}\n\n`;
    output += `**Description:** ${modelSettings.description || 'No description'}\n\n`;
    output += `| Parameter | Value |\n`;
    output += `|-----------|-------|\n`;
    for (const [key, value] of Object.entries(modelSettings)) {
      if (key !== 'description') {
        output += `| ${key} | ${value} |\n`;
      }
    }
    output += `\nThese settings override global defaults when using this model.`;
    return { content: [{ type: 'text', text: output }] };
  }

  // Show all models
  let output = `## Model-Specific Settings\n\n`;
  output += `These override global defaults when the model is used.\n\n`;
  output += `| Model | Temp | Top-K | Context | Description |\n`;
  output += `|-------|------|-------|---------|-------------|\n`;

  for (const [name, s] of Object.entries(settings)) {
    output += `| ${name} | ${s.temperature || '-'} | ${s.top_k || '-'} | ${s.num_ctx || '-'} | ${s.description || ''} |\n`;
  }

  output += `\n**Tuning Priority:** Per-task > Model-specific > Global defaults\n`;
  output += `\nUse \`get_model_settings model="<name>"\` for details.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Set model-specific tuning settings
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetModelSettings(args) {
  const { model, temperature, num_ctx, top_p, top_k, repeat_penalty, mirostat, description } = args;

  if (!model) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'model is required');
  }

  const settingsJson = serverConfig.get('ollama_model_settings') || '{}';
  let settings;
  try {
    settings = JSON.parse(settingsJson);
  } catch (err) {
    return makeError(ErrorCodes.INVALID_PARAM, `Invalid model settings JSON: ${err.message}`);
  }

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Invalid model settings format: expected an object');
  }

  // Initialize model settings if not exists
  if (!settings[model]) {
    settings[model] = {};
  }

  const updates = [];

  if (temperature !== undefined) {
    if (temperature < 0.1 || temperature > 1.0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'temperature must be between 0.1 and 1.0');
    }
    settings[model].temperature = temperature;
    updates.push(`temperature → ${temperature}`);
  }

  if (num_ctx !== undefined) {
    if (num_ctx < 1024 || num_ctx > 32768) {
      return makeError(ErrorCodes.INVALID_PARAM, 'num_ctx must be between 1024 and 32768');
    }
    settings[model].num_ctx = num_ctx;
    updates.push(`num_ctx → ${num_ctx}`);
  }

  if (top_p !== undefined) {
    if (top_p < 0.1 || top_p > 1.0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'top_p must be between 0.1 and 1.0');
    }
    settings[model].top_p = top_p;
    updates.push(`top_p → ${top_p}`);
  }

  if (top_k !== undefined) {
    if (top_k < 1 || top_k > 100) {
      return makeError(ErrorCodes.INVALID_PARAM, 'top_k must be between 1 and 100');
    }
    settings[model].top_k = top_k;
    updates.push(`top_k → ${top_k}`);
  }

  if (repeat_penalty !== undefined) {
    if (repeat_penalty < 1.0 || repeat_penalty > 2.0) {
      return makeError(ErrorCodes.INVALID_PARAM, 'repeat_penalty must be between 1.0 and 2.0');
    }
    settings[model].repeat_penalty = repeat_penalty;
    updates.push(`repeat_penalty → ${repeat_penalty}`);
  }

  if (mirostat !== undefined) {
    if (![0, 1, 2].includes(mirostat)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'mirostat must be 0 (off), 1 (v1), or 2 (v2)');
    }
    settings[model].mirostat = mirostat;
    updates.push(`mirostat → ${mirostat === 0 ? 'off' : 'v' + mirostat}`);
  }

  if (description !== undefined) {
    settings[model].description = description;
    updates.push(`description → "${description}"`);
  }

  if (updates.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## No Changes\n\nNo settings provided for model "${model}".\n\nUse \`get_model_settings model="${model}"\` to see current settings.`
      }]
    };
  }

  database.setConfig('ollama_model_settings', JSON.stringify(settings));

  let output = `## Model Settings Updated: ${model}\n\n`;
  output += `**Changes applied:**\n`;
  updates.forEach(u => output += `- ${u}\n`);
  output += `\nThese settings will be used when "${model}" is selected.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Get model-specific system prompts
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetModelPrompts(args) {
  const { model } = args;
  const promptsJson = serverConfig.get('ollama_model_prompts');

  if (!promptsJson) {
    return {
      content: [{
        type: 'text',
        text: `## No Model Prompts Configured\n\nModel prompts have not been initialized.`
      }]
    };
  }

  let prompts;
  try { prompts = JSON.parse(promptsJson); } catch { prompts = {}; }

  if (model) {
    const prompt = prompts[model];
    if (!prompt) {
      return {
        content: [{
          type: 'text',
          text: `## No Prompt for: ${model}\n\nAvailable models: ${Object.keys(prompts).join(', ')}\n\nUse \`set_model_prompt\` to add one.`
        }]
      };
    }
    const output = `## System Prompt: ${model}\n\n\`\`\`\n${prompt}\n\`\`\``;
    return { content: [{ type: 'text', text: output }] };
  }

  let output = `## Model System Prompts\n\n`;
  for (const [name, prompt] of Object.entries(prompts)) {
    const preview = prompt.split('\n')[0].substring(0, 60) + '...';
    output += `### ${name}\n${preview}\n\n`;
  }
  output += `Use \`get_model_prompts model="<name>"\` to see full prompt.`;
  return { content: [{ type: 'text', text: output }] };
}


/**
 * Set model-specific system prompt
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetModelPrompt(args) {
  const { model, prompt } = args;

  if (!model || !prompt) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'model and prompt are required');
  }

  const promptsJson = serverConfig.get('ollama_model_prompts') || '{}';
  let prompts;
  try { prompts = JSON.parse(promptsJson); } catch { prompts = {}; }

  prompts[model] = prompt;
  database.setConfig('ollama_model_prompts', JSON.stringify(prompts));

  let output = `## System Prompt Updated: ${model}\n\n`;
  output += `\`\`\`\n${prompt}\n\`\`\`\n\n`;
  output += `This prompt will be used when "${model}" is selected.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Get instruction templates
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetInstructionTemplates(args) {
  const taskManager = require('../task-manager');
  const providers = ['hashline-ollama', 'claude-cli', 'codex'];

  if (args.provider) {
    // Get template for specific provider
    const customTemplate = serverConfig.get(`instruction_template_${args.provider}`);
    const defaultTemplate = taskManager.DEFAULT_INSTRUCTION_TEMPLATES?.[args.provider] || 'No default template';

    let output = `## Instruction Template: ${args.provider}\n\n`;
    if (customTemplate) {
      output += `### Custom Template\n\`\`\`\n${customTemplate}\n\`\`\`\n\n`;
      output += `### Default Template\n\`\`\`\n${defaultTemplate}\n\`\`\``;
    } else {
      output += `### Active Template (Default)\n\`\`\`\n${defaultTemplate}\n\`\`\`\n\n`;
      output += `*No custom template set. Use \`set_instruction_template\` to customize.*`;
    }

    return { content: [{ type: 'text', text: output }] };
  }

  // List all providers
  const wrappingEnabled = serverConfig.getBool('instruction_wrapping_enabled');
  let output = `## Instruction Templates\n\n`;
  output += `**Wrapping Enabled:** ${wrappingEnabled ? 'Yes' : 'No'}\n\n`;
  output += `Templates wrap task descriptions with standardized safeguard instructions.\n\n`;

  for (const provider of providers) {
    const customTemplate = serverConfig.get(`instruction_template_${provider}`);
    const status = customTemplate ? 'Custom' : 'Default';
    output += `### ${provider} (${status})\n`;

    const template = customTemplate || taskManager.DEFAULT_INSTRUCTION_TEMPLATES?.[provider] || 'No template';
    const preview = template.split('\n').slice(0, 3).join('\n') + '...';
    output += `\`\`\`\n${preview}\n\`\`\`\n\n`;
  }

  output += `Use \`get_instruction_templates provider="<name>"\` to see full template.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Set instruction template
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetInstructionTemplate(args) {
  const { provider, model, template } = args;

  if (!provider || !template) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'provider and template are required');
  }

  const validProviders = ['hashline-ollama', 'claude-cli', 'codex'];
  if (!validProviders.includes(provider)) {
    return makeError(ErrorCodes.INVALID_PARAM, `Invalid provider. Must be one of: ${validProviders.join(', ')}`);
  }

  // Check template has required placeholder
  if (!template.includes('{TASK_DESCRIPTION}')) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Template must include {TASK_DESCRIPTION} placeholder');
  }

  // SECURITY: validate model name to prevent config key injection
  if (model && !/^[a-zA-Z0-9_.\-:]+$/.test(model)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Invalid model name. Only alphanumeric, hyphens, underscores, dots, and colons allowed.');
  }

  const configKey = model
    ? `instruction_template_${provider}_${model}`
    : `instruction_template_${provider}`;

  database.setConfig(configKey, template);

  const targetDesc = model ? `${provider} (model: ${model})` : provider;
  let output = `## Instruction Template Updated: ${targetDesc}\n\n`;
  output += `\`\`\`\n${template}\n\`\`\`\n\n`;
  output += `Available placeholders:\n`;
  output += `- \`{TASK_DESCRIPTION}\` - The original task description\n`;
  output += `- \`{FILES}\` - Files to be modified\n`;
  output += `- \`{PROJECT}\` - Project name`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Toggle instruction wrapping
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleToggleInstructionWrapping(args) {
  const { enabled } = args;

  database.setConfig('instruction_wrapping_enabled', enabled ? '1' : '0');

  let output = `## Instruction Wrapping ${enabled ? 'Enabled' : 'Disabled'}\n\n`;
  if (enabled) {
    output += `Task descriptions will be wrapped with instruction templates that include:\n`;
    output += `- Safeguard rules (no stubs, no empty files)\n`;
    output += `- Code quality guidelines\n`;
    output += `- Provider-specific formatting instructions\n`;
  } else {
    output += `Task descriptions will be passed directly to LLMs without modification.\n`;
    output += `**Warning:** This removes safeguard instructions that prevent common LLM mistakes.`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Get hardware tuning settings
 * @param {Object} _args - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetHardwareTuning(_args) {
  const numGpu = serverConfig.get('ollama_num_gpu') || '-1';
  const numThread = serverConfig.get('ollama_num_thread') || '0';
  const keepAlive = serverConfig.get('ollama_keep_alive') || '5m';

  let output = `## Hardware Tuning\n\n`;
  output += `| Setting | Value | Description |\n`;
  output += `|---------|-------|-------------|\n`;
  output += `| num_gpu | ${numGpu} | GPU layers (-1=auto, 0=CPU, N=layers) |\n`;
  output += `| num_thread | ${numThread} | CPU threads (0=auto) |\n`;
  output += `| keep_alive | ${keepAlive} | Model memory retention |\n\n`;

  output += `### GPU Layer Recommendations\n`;
  output += `| GPU | VRAM | Recommended Layers |\n`;
  output += `|-----|------|--------------------|\n`;
  output += `| RTX 4060 | 8GB | 35-40 (7B models) |\n`;
  output += `| RTX 3080 | 10GB | 45-50 (7B), 30-35 (13B) |\n`;
  output += `| RTX 3080 | 16GB | Full (7B), 45-50 (13B) |\n`;
  output += `| RTX 3090/4090 | 24GB | 70 (32B), Full (16B and below) |\n\n`;
  output += `**Benchmark Results (RTX 3090/4090):**\n`;
  output += `- qwen3-coder:30b-a3b (MoE): ~112 tok/s @ auto (recommended)\n`;
  output += `- qwen2.5-coder:32b: 36 tok/s @ num_gpu=70 (legacy)\n`;
  output += `- deepseek-coder-v2:16b: 192 tok/s @ auto\n`;
  output += `- phi3:14b: 77 tok/s @ auto\n\n`;

  output += `Use \`set_hardware_tuning\` to modify.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Set hardware tuning settings
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetHardwareTuning(args) {
  const { num_gpu, num_thread, keep_alive } = args;
  const updates = [];

  if (num_gpu !== undefined) {
    if (num_gpu < -1 || num_gpu > 100) {
      return makeError(ErrorCodes.INVALID_PARAM, 'num_gpu must be -1 (auto), 0 (CPU), or 1-100 (layers)');
    }
    database.setConfig('ollama_num_gpu', num_gpu.toString());
    updates.push(`num_gpu → ${num_gpu === -1 ? 'auto' : num_gpu === 0 ? 'CPU only' : num_gpu + ' layers'}`);
  }

  if (num_thread !== undefined) {
    if (num_thread < 0 || num_thread > 128) {
      return makeError(ErrorCodes.INVALID_PARAM, 'num_thread must be 0 (auto) or 1-128');
    }
    database.setConfig('ollama_num_thread', num_thread.toString());
    updates.push(`num_thread → ${num_thread === 0 ? 'auto' : num_thread}`);
  }

  if (keep_alive !== undefined) {
    database.setConfig('ollama_keep_alive', keep_alive);
    updates.push(`keep_alive → ${keep_alive}`);
  }

  if (updates.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## No Changes\n\nNo hardware settings provided.`
      }]
    };
  }

  let output = `## Hardware Tuning Updated\n\n`;
  output += `**Changes:**\n`;
  updates.forEach(u => output += `- ${u}\n`);
  output += `\nChanges take effect on next Ollama request.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Get auto-tuning configuration
 * @param {Object} _args - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetAutoTuning(_args) {
  const enabled = serverConfig.isOptIn('ollama_auto_tuning_enabled');
  const rulesJson = serverConfig.get('ollama_auto_tuning_rules');

  let output = `## Auto-Tuning Configuration\n\n`;
  output += `**Status:** ${enabled ? '✓ Enabled' : '✗ Disabled'}\n\n`;

  if (!rulesJson) {
    output += `No auto-tuning rules configured.`;
    return { content: [{ type: 'text', text: output }] };
  }

  let rules;
  try { rules = JSON.parse(rulesJson); } catch { rules = {}; }

  output += `### Rules\n`;
  output += `| Rule | Patterns | Temp | Top-K | Mirostat |\n`;
  output += `|------|----------|------|-------|----------|\n`;

  for (const [name, rule] of Object.entries(rules)) {
    const patterns = rule.patterns.slice(0, 3).join(', ') + (rule.patterns.length > 3 ? '...' : '');
    const t = rule.tuning;
    output += `| ${name} | ${patterns} | ${t.temperature || '-'} | ${t.top_k || '-'} | ${t.mirostat === 0 ? 'off' : t.mirostat || '-'} |\n`;
  }

  output += `\n**How it works:** Task descriptions are analyzed for keywords.\n`;
  output += `Matching rules automatically adjust tuning for optimal results.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Set auto-tuning configuration
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetAutoTuning(args) {
  const { enabled, rule, patterns, tuning } = args;
  const updates = [];

  if (enabled !== undefined) {
    database.setConfig('ollama_auto_tuning_enabled', enabled ? '1' : '0');
    updates.push(`auto-tuning → ${enabled ? 'enabled' : 'disabled'}`);
  }

  if (rule && (patterns || tuning)) {
    const rulesJson = serverConfig.get('ollama_auto_tuning_rules') || '{}';
    let rules;
    try { rules = JSON.parse(rulesJson); } catch { rules = {}; }

    if (!rules[rule]) {
      rules[rule] = { patterns: [], tuning: {} };
    }

    if (patterns) {
      rules[rule].patterns = patterns;
      updates.push(`${rule}.patterns → [${patterns.join(', ')}]`);
    }

    if (tuning) {
      rules[rule].tuning = { ...rules[rule].tuning, ...tuning };
      updates.push(`${rule}.tuning → temp:${tuning.temperature || '-'}, top_k:${tuning.top_k || '-'}, mirostat:${tuning.mirostat || '-'}`);
    }

    database.setConfig('ollama_auto_tuning_rules', JSON.stringify(rules));
  }

  if (updates.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## No Changes\n\nProvide \`enabled\` or \`rule\` with \`patterns\`/\`tuning\`.`
      }]
    };
  }

  let output = `## Auto-Tuning Updated\n\n`;
  output += `**Changes:**\n`;
  updates.forEach(u => output += `- ${u}\n`);

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Run performance benchmark on Ollama host(s)
 * @param {Object} args - Handler arguments.
 * @returns {Promise<Object>} Response payload.
 */
async function handleRunBenchmark(args) {
  try {
  
  const { host_id, host_url, model, test_type = 'basic', gpu_layers, context_sizes } = args;
  

  // Try to load benchmark module
  let benchmark;
  try {
    benchmark = require('../benchmark');
  } catch (e) {
    return {
      content: [{
        type: 'text',
        text: `## Benchmark Error\n\nCould not load benchmark module: ${e.message}`
      }]
    };
  }

  // Determine target host
  let targetHost, hostName;

  if (host_url) {
    targetHost = host_url;
    hostName = host_url;
  } else if (host_id) {
    const hosts = hostManagement.listOllamaHosts ? hostManagement.listOllamaHosts() : [];
    const found = hosts.find(h => h.id === host_id || h.name.toLowerCase() === host_id.toLowerCase());
    if (!found) {
      return {
        content: [{
          type: 'text',
          text: `## Benchmark Error\n\nHost "${host_id}" not found. Use \`list_ollama_hosts\` to see available hosts.`
        }]
      };
    }
    targetHost = found.url;
    hostName = found.name;
  } else {
    // Use first healthy host
    const hosts = hostManagement.listOllamaHosts ? hostManagement.listOllamaHosts().filter(h => h.enabled && h.status === 'healthy') : [];
    if (hosts.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `## Benchmark Error\n\nNo healthy Ollama hosts available.`
        }]
      };
    }
    const selected = hosts[0];
    targetHost = selected.url;
    hostName = selected.name;
  }

  // Get models
  let targetModels;
  if (model) {
    targetModels = [model];
  } else {
    targetModels = await benchmark.getHostModels(targetHost);
    targetModels = targetModels.filter(m => !m.includes('embed') && !m.includes('nomic'));
    if (targetModels.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `## Benchmark Error\n\nNo models found on ${targetHost}. Is Ollama running?`
        }]
      };
    }
  }

  let output = `## Performance Benchmark\n\n`;
  output += `**Host:** ${hostName} (${targetHost})\n`;
  output += `**Models:** ${targetModels.join(', ')}\n`;
  output += `**Test Type:** ${test_type}\n\n`;

  try {
    // Run basic benchmark
    const results = await benchmark.runBenchmarkSuite(targetHost, targetModels, hostName);

    // Calculate averages
    const modelStats = {};
    for (const result of results) {
      if (!result.success) continue;
      if (!modelStats[result.model]) {
        modelStats[result.model] = { total: 0, count: 0 };
      }
      modelStats[result.model].total += parseFloat(result.tokensPerSecond);
      modelStats[result.model].count++;
    }

    output += `### Model Performance (avg tok/s)\n\n`;
    output += `| Model | Tokens/sec |\n`;
    output += `|-------|------------|\n`;

    const ranked = Object.entries(modelStats)
      .map(([model, stats]) => ({ model, avg: stats.total / stats.count }))
      .sort((a, b) => b.avg - a.avg);

    ranked.forEach(m => {
      output += `| ${m.model} | ${m.avg.toFixed(2)} |\n`;
    });

    // Run GPU layer tests if requested
    if (test_type === 'gpu' || test_type === 'full') {
      const largeModel = targetModels.find(m => m.includes('32b') || m.includes('34b')) ||
                         targetModels.find(m => m.includes('22b') || m.includes('16b')) ||
                         targetModels[0];

      const layers = gpu_layers || [-1, 50, 60, 70, 80, 99];
      const gpuResults = await benchmark.testGpuLayers(targetHost, largeModel, layers);

      output += `\n### GPU Layer Optimization (${largeModel})\n\n`;
      output += `| Layers | Tokens/sec |\n`;
      output += `|--------|------------|\n`;

      let bestGpu = null;
      for (const r of gpuResults) {
        if (r.success) {
          output += `| ${r.numGpu === -1 ? 'auto' : r.numGpu} | ${r.tokensPerSecond} |\n`;
          if (!bestGpu || parseFloat(r.tokensPerSecond) > parseFloat(bestGpu.tokensPerSecond)) {
            bestGpu = r;
          }
        }
      }

      if (bestGpu) {
        output += `\n**Optimal:** num_gpu=${bestGpu.numGpu === -1 ? 'auto' : bestGpu.numGpu} (${bestGpu.tokensPerSecond} tok/s)\n`;
      }
    }

    // Run context size tests if requested
    if (test_type === 'context' || test_type === 'full') {
      const sizes = context_sizes || [4096, 8192, 16384, 32768];
      const ctxResults = await benchmark.testContextSizes(targetHost, targetModels[0], sizes);

      output += `\n### Context Window Performance (${targetModels[0]})\n\n`;
      output += `| Context | Tokens/sec | Load Time |\n`;
      output += `|---------|------------|------------|\n`;

      for (const r of ctxResults) {
        if (r.success) {
          output += `| ${r.numCtx} | ${r.tokensPerSecond} | ${r.loadDuration.toFixed(2)}s |\n`;
        }
      }
    }

    return { content: [{ type: 'text', text: output }] };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `## Benchmark Error\n\n${error.message}`
      }]
    };
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

// ── Unified tuning dispatcher (Phase 3.2 consolidation) ──

const MANAGE_TUNING_DISPATCH = {
  get_llm:          (args) => handleGetLlmTuning(args),
  set_llm:          (args) => handleSetLlmTuning(args),
  apply_preset:     (args) => handleApplyLlmPreset(args),
  list_presets:     (args) => handleListLlmPresets(args),
  get_model:        (args) => handleGetModelSettings(args),
  set_model:        (args) => handleSetModelSettings(args),
  get_prompts:      (args) => handleGetModelPrompts(args),
  set_prompt:       (args) => handleSetModelPrompt(args),
  get_templates:    (args) => handleGetInstructionTemplates(args),
  set_template:     (args) => handleSetInstructionTemplate(args),
  toggle_wrapping:  (args) => handleToggleInstructionWrapping(args),
  get_hardware:     (args) => handleGetHardwareTuning(args),
  set_hardware:     (args) => handleSetHardwareTuning(args),
  get_auto:         (args) => handleGetAutoTuning(args),
  set_auto:         (args) => handleSetAutoTuning(args),
  benchmark:        (args) => handleRunBenchmark(args),
};

async function handleManageTuning(args) {
  try {
    const { action } = args;
    if (!action) return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'action is required for manage_tuning');
    const dispatcher = MANAGE_TUNING_DISPATCH[action];
    if (!dispatcher) {
      const validActions = Object.keys(MANAGE_TUNING_DISPATCH).join(', ');
      return makeError(ErrorCodes.INVALID_PARAM, `Unknown action: ${action}. Valid: ${validActions}`);
    }
    return await dispatcher(args);
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, `manage_tuning failed: ${err.message}`);
  }
}

function createProviderTuningHandlers() {
  return {
    handleGetLlmTuning,
    handleSetLlmTuning,
    handleApplyLlmPreset,
    handleListLlmPresets,
    handleGetModelSettings,
    handleSetModelSettings,
    handleGetModelPrompts,
    handleSetModelPrompt,
    handleGetInstructionTemplates,
    handleSetInstructionTemplate,
    handleToggleInstructionWrapping,
    handleGetHardwareTuning,
    handleSetHardwareTuning,
    handleGetAutoTuning,
    handleSetAutoTuning,
    handleRunBenchmark,
    handleManageTuning,
  };
}

module.exports = {
  handleGetLlmTuning,
  handleSetLlmTuning,
  handleApplyLlmPreset,
  handleListLlmPresets,
  handleGetModelSettings,
  handleSetModelSettings,
  handleGetModelPrompts,
  handleSetModelPrompt,
  handleGetInstructionTemplates,
  handleSetInstructionTemplate,
  handleToggleInstructionWrapping,
  handleGetHardwareTuning,
  handleSetHardwareTuning,
  handleGetAutoTuning,
  handleSetAutoTuning,
  handleRunBenchmark,
  handleManageTuning,
  createProviderTuningHandlers,
};
