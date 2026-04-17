'use strict';

function render(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => {
    if (vars[name] === undefined) return match;
    return String(vars[name]);
  });
}

async function runPattern({ pattern, input, vars = {}, callModel }) {
  const mergedVars = { ...vars, input };
  const user = pattern.user_template
    ? render(pattern.user_template, mergedVars)
    : (input || '');

  return callModel({
    system: pattern.system,
    user,
    pattern_name: pattern.name,
  });
}

module.exports = { runPattern, render };
