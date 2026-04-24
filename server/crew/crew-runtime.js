'use strict';

const Ajv = require('ajv');
const logger = require('../logger').child({ component: 'crew-runtime' });

const ajv = new Ajv({ strict: false });
const VALID_MODES = new Set(['round_robin', 'parallel', 'hierarchical']);

function extractOutput(result) {
  return result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'output')
    ? result.output
    : result;
}

function compileValidator(outputSchema) {
  if (!outputSchema) {
    return null;
  }
  try {
    return ajv.compile(outputSchema);
  } catch (err) {
    throw new Error(`runCrew: invalid output_schema: ${err.message}`);
  }
}

function pushHistory(history, roleName, output) {
  history.push({
    role: roleName,
    round: history.length,
    output,
  });
}

function validateRunCrewOptions({ roles, mode, max_rounds, callRole }) {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error('runCrew: roles must be a non-empty array');
  }
  for (const [index, role] of roles.entries()) {
    const roleName = typeof role?.name === 'string' ? role.name.trim() : '';
    if (!roleName) {
      throw new Error(`runCrew: roles[${index}] must include a non-empty name`);
    }
  }
  if (typeof callRole !== 'function') {
    throw new Error('runCrew: callRole must be a function');
  }
  if (!Number.isInteger(max_rounds) || max_rounds < 1) {
    throw new Error('runCrew: max_rounds must be a positive integer');
  }
  if (!VALID_MODES.has(mode)) {
    throw new Error(`runCrew: mode must be one of ${Array.from(VALID_MODES).join(', ')}`);
  }
}

async function runRoundRobin({ objective, roles, callRole, history, validate }) {
  for (const role of roles) {
    const result = await callRole({ role, history, objective });
    const output = extractOutput(result);
    pushHistory(history, role.name, output);
    if (validate && validate(output)) {
      return { matched: true, final_output: output };
    }
  }
  return { matched: false };
}

async function runParallel({ objective, roles, callRole, history, validate }) {
  const results = await Promise.all(roles.map((role) => Promise.resolve()
    .then(() => callRole({ role, history, objective }))
    .then((result) => ({ role, output: extractOutput(result) }))));

  for (const { role, output } of results) {
    pushHistory(history, role.name, output);
  }
  for (const { output } of results) {
    if (validate && validate(output)) {
      return { matched: true, final_output: output };
    }
  }
  return { matched: false };
}

async function runHierarchical({ objective, roles, callRole, history, validate }) {
  const manager = roles[0];
  const workers = roles.slice(1);

  const managerResult = await callRole({ role: manager, history, objective, workers });
  const managerOutput = extractOutput(managerResult);
  pushHistory(history, manager.name, managerOutput);
  if (validate && validate(managerOutput)) {
    return { matched: true, final_output: managerOutput };
  }

  const nextRoleName = managerOutput?.delegate_to;
  const target = workers.find((role) => role.name === nextRoleName);
  if (!target) {
    return { matched: false };
  }

  const workerResult = await callRole({ role: target, history, objective });
  const workerOutput = extractOutput(workerResult);
  pushHistory(history, target.name, workerOutput);
  if (validate && validate(workerOutput)) {
    return { matched: true, final_output: workerOutput };
  }

  return { matched: false };
}

async function runCrew(opts = {}) {
  const {
    objective,
    roles,
    mode = 'round_robin',
    max_rounds = 5,
    output_schema,
    callRole,
  } = opts;

  validateRunCrewOptions({ roles, mode, max_rounds, callRole });

  const validate = compileValidator(output_schema);
  const history = [];
  const runner = mode === 'parallel'
    ? runParallel
    : mode === 'hierarchical'
      ? runHierarchical
      : runRoundRobin;

  for (let round = 0; round < max_rounds; round += 1) {
    const result = await runner({ objective, roles, callRole, history, validate });
    if (result.matched) {
      logger.debug?.({ mode, rounds: round + 1, history_entries: history.length }, 'runCrew terminated after output matched schema');
      return {
        terminated_by: 'output_matched_schema',
        rounds: round + 1,
        history,
        final_output: result.final_output,
      };
    }
  }

  logger.debug?.({ mode, rounds: max_rounds, history_entries: history.length }, 'runCrew terminated after reaching max rounds');
  return {
    terminated_by: 'max_rounds',
    rounds: max_rounds,
    history,
    final_output: history[history.length - 1]?.output || null,
  };
}

module.exports = { runCrew };
