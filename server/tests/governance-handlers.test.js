'use strict';

const HANDLER_MODULE = require.resolve('../handlers/governance-handlers');
const CONTAINER_MODULE = require.resolve('../container');
const DATABASE_MODULE = require.resolve('../database');
const GOVERNANCE_RULES_MODULE = require.resolve('../db/governance-rules');

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function clearModuleCache() {
  delete require.cache[HANDLER_MODULE];
  delete require.cache[CONTAINER_MODULE];
  delete require.cache[DATABASE_MODULE];
  delete require.cache[GOVERNANCE_RULES_MODULE];
}

function createRulesStore(rules = [{
  id: 'rule-1',
  stage: 'submission',
  mode: 'warn',
  enabled: true,
  config: null,
}]) {
  return {
    seedBuiltinRules: vi.fn(),
    getAllRules: vi.fn(() => rules),
    getRule: vi.fn((ruleId) => rules.find((rule) => rule.id === ruleId) || null),
    updateRuleMode: vi.fn(),
    toggleRule: vi.fn(),
  };
}

function loadHandlers({
  governanceRulesValue = null,
  governanceRulesError = null,
  containerDbValue = null,
  containerDbError = null,
  databaseDbValue = null,
  databaseDbError = null,
} = {}) {
  clearModuleCache();

  const createdRules = createRulesStore();
  const createGovernanceRules = vi.fn(() => createdRules);
  const databaseModule = {
    getDbInstance: vi.fn(() => {
      if (databaseDbError) {
        throw databaseDbError;
      }
      return databaseDbValue;
    }),
  };
  const defaultContainer = {
    get: vi.fn((name) => {
      if (name === 'governanceRules') {
        if (governanceRulesError) {
          throw governanceRulesError;
        }
        return governanceRulesValue;
      }
      if (name === 'db') {
        if (containerDbError) {
          throw containerDbError;
        }
        return containerDbValue;
      }
      return undefined;
    }),
  };

  installCjsModuleMock('../container', { defaultContainer });
  installCjsModuleMock('../database', databaseModule);
  installCjsModuleMock('../db/governance-rules', {
    VALID_MODES: ['warn', 'block', 'shadow'],
    createGovernanceRules,
  });

  const handlers = require('../handlers/governance-handlers');
  return {
    handlers,
    createGovernanceRules,
    createdRules,
    databaseModule,
    defaultContainer,
  };
}

describe('handlers/governance-handlers resolveGovernanceRules', () => {
  afterEach(() => {
    clearModuleCache();
  });

  it('uses the governanceRules service from the container before other fallbacks', async () => {
    const governanceRules = createRulesStore();
    const { handlers, createGovernanceRules, databaseModule, defaultContainer } = loadHandlers({
      governanceRulesValue: governanceRules,
      databaseDbValue: { prepare: vi.fn() },
    });

    const result = await handlers.handleGetGovernanceRules();

    expect(result.status).toBe(200);
    expect(result.structuredData.count).toBe(1);
    expect(governanceRules.getAllRules).toHaveBeenCalledOnce();
    expect(defaultContainer.get).toHaveBeenCalledTimes(1);
    expect(defaultContainer.get).toHaveBeenCalledWith('governanceRules');
    expect(createGovernanceRules).not.toHaveBeenCalled();
    expect(databaseModule.getDbInstance).not.toHaveBeenCalled();
  });

  it('uses container db before falling back to the raw database module', async () => {
    const containerDb = { prepare: vi.fn() };
    const { handlers, createGovernanceRules, createdRules, databaseModule, defaultContainer } = loadHandlers({
      containerDbValue: containerDb,
      databaseDbValue: { prepare: vi.fn() },
    });

    const result = await handlers.handleGetGovernanceRules();

    expect(result.status).toBe(200);
    expect(result.structuredData.count).toBe(1);
    expect(defaultContainer.get.mock.calls.map(([name]) => name)).toEqual(['governanceRules', 'db']);
    expect(createGovernanceRules).toHaveBeenCalledTimes(1);
    expect(createGovernanceRules).toHaveBeenCalledWith({ db: containerDb });
    expect(createdRules.seedBuiltinRules).toHaveBeenCalledOnce();
    expect(databaseModule.getDbInstance).not.toHaveBeenCalled();
  });

  it('still falls back to the raw database module as a last resort', async () => {
    const databaseDb = { prepare: vi.fn() };
    const { handlers, createGovernanceRules, createdRules, databaseModule, defaultContainer } = loadHandlers({
      containerDbError: new Error('container db unavailable'),
      databaseDbValue: databaseDb,
    });

    const result = await handlers.handleGetGovernanceRules();

    expect(result.status).toBe(200);
    expect(result.structuredData.count).toBe(1);
    expect(defaultContainer.get.mock.calls.map(([name]) => name)).toEqual(['governanceRules', 'db']);
    expect(databaseModule.getDbInstance).toHaveBeenCalledOnce();
    expect(createGovernanceRules).toHaveBeenCalledTimes(1);
    expect(createGovernanceRules).toHaveBeenCalledWith({ db: databaseDb });
    expect(createdRules.seedBuiltinRules).toHaveBeenCalledOnce();
  });
});
