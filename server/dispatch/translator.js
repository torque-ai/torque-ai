'use strict';

const { parseAlignedToSchema } = require('../torquefn/sap');

const TRANSLATE_PROMPT = [
  'Translate the operator utterance below into a strict JSON action matching the schema.',
  'Respond with ONLY the JSON object - no prose.',
  '',
  'Schema:',
  '{{schema}}',
  '',
  'Utterance:',
  '{{utterance}}',
].join('\n');

function renderPrompt({ schema, utterance, previousErrors = [] }) {
  const basePrompt = TRANSLATE_PROMPT
    .replace('{{schema}}', JSON.stringify(schema, null, 2))
    .replace('{{utterance}}', utterance);

  if (!Array.isArray(previousErrors) || previousErrors.length === 0) {
    return basePrompt;
  }

  return [
    basePrompt,
    '',
    'Your previous response failed validation:',
    previousErrors.join('; '),
    '',
    'Output a corrected JSON object that matches the schema exactly.',
  ].join('\n');
}

async function translateToAction({ utterance, schema, callModel, maxRetries = 2 }) {
  if (typeof callModel !== 'function') {
    throw new TypeError('translateToAction requires callModel to be a function');
  }

  let lastErrors = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let raw;
    try {
      raw = await callModel({
        prompt: renderPrompt({ schema, utterance, previousErrors: lastErrors || [] }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, errors: [`model call failed: ${message}`], attempts: attempt + 1 };
    }

    const sapResult = parseAlignedToSchema(raw, schema);
    if (sapResult.ok) {
      return { ok: true, action: sapResult.value, attempts: attempt + 1 };
    }

    lastErrors = Array.isArray(sapResult.errors) && sapResult.errors.length > 0
      ? sapResult.errors
      : ['translation failed'];
  }

  return { ok: false, errors: lastErrors || ['translation failed'], attempts: maxRetries + 1 };
}

module.exports = { translateToAction };
