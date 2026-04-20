/**
 * Unit Tests: validation/preflight-types.js
 *
 * Tests pre-flight type validation:
 * 1. parseTypeSignatures — parsing the IMPORTED TYPE SIGNATURES block
 * 2. validateTaskAgainstTypes — cross-checking task description against types
 * 3. buildPreflightHints — formatting hints for prompt injection
 */

const {
  parseTypeSignatures,
  validateTaskAgainstTypes,
  buildPreflightHints,
  _fuzzyMatch,
} = require('../validation/preflight-types');

// ─── parseTypeSignatures ────────────────────────────────────────────────

describe('parseTypeSignatures', () => {
  it('parses enum with string values', () => {
    const input = `
// src/types.ts
export enum BillingCadence {
  Weekly = 'weekly',
  Biweekly = 'biweekly',
  Monthly = 'monthly',
}`;
    const result = parseTypeSignatures(input);
    expect(result.enums).toHaveLength(1);
    expect(result.enums[0].name).toBe('BillingCadence');
    expect(result.enums[0].file).toBe('src/types.ts');
    expect(result.enums[0].members).toEqual(['Weekly', 'Biweekly', 'Monthly']);
  });

  it('parses enum with numeric values', () => {
    const input = `
// src/constants.ts
export enum Priority {
  Low = 0,
  Medium = 1,
  High = 2,
}`;
    const result = parseTypeSignatures(input);
    expect(result.enums).toHaveLength(1);
    expect(result.enums[0].members).toEqual(['Low', 'Medium', 'High']);
  });

  it('parses enum with implicit values', () => {
    const input = `
// src/types.ts
export enum Direction {
  Up,
  Down,
  Left,
  Right,
}`;
    const result = parseTypeSignatures(input);
    expect(result.enums).toHaveLength(1);
    expect(result.enums[0].members).toEqual(['Up', 'Down', 'Left', 'Right']);
  });

  it('parses interface with typed fields', () => {
    const input = `
// src/types.ts
export interface SubscriptionPlanDefinition {
  id: string;
  name: string;
  renewalAmount: number;
  cadence: BillingCadence;
  description: string;
}`;
    const result = parseTypeSignatures(input);
    expect(result.interfaces).toHaveLength(1);
    expect(result.interfaces[0].name).toBe('SubscriptionPlanDefinition');
    expect(result.interfaces[0].fields).toEqual(['id', 'name', 'renewalAmount', 'cadence', 'description']);
  });

  it('parses interface with optional fields', () => {
    const input = `
// src/types.ts
export interface Config {
  host: string;
  port?: number;
  debug?: boolean;
}`;
    const result = parseTypeSignatures(input);
    expect(result.interfaces).toHaveLength(1);
    expect(result.interfaces[0].fields).toEqual(['host', 'port', 'debug']);
  });

  it('parses type aliases', () => {
    const input = `
// src/types.ts
export type Status = 'active' | 'inactive' | 'pending';`;
    const result = parseTypeSignatures(input);
    expect(result.types).toHaveLength(1);
    expect(result.types[0].name).toBe('Status');
    expect(result.types[0].definition).toContain("'active'");
  });

  it('handles multi-file sections', () => {
    const input = `
// src/types.ts
export enum Color {
  Red = 'red',
  Blue = 'blue',
}

export interface Shape {
  color: Color;
  size: number;
}
// src/utils.ts
export enum Size {
  Small = 'small',
  Large = 'large',
}`;
    const result = parseTypeSignatures(input);
    expect(result.enums).toHaveLength(2);
    expect(result.enums[0].file).toBe('src/types.ts');
    expect(result.enums[1].file).toBe('src/utils.ts');
    expect(result.interfaces).toHaveLength(1);
    expect(result.interfaces[0].file).toBe('src/types.ts');
  });

  it('parses class with methods and fields', () => {
    const input = `
// src/services/AccountService.ts
export class AccountService {
  private requestCount: number;
  protected name: string;
  public getUser(): User;
  async loadProfile(id: number): Promise<void>;
  private resetState(): void;
}`;
    const result = parseTypeSignatures(input);
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].name).toBe('AccountService');
    expect(result.classes[0].fields).toEqual(['requestCount', 'name']);
    expect(result.classes[0].methods).toEqual(['getUser', 'loadProfile', 'resetState']);
  });

  it('parses abstract class methods', () => {
    const input = `
// src/base.ts
export abstract class BaseSystem {
  abstract initialize(): void;
  abstract update(dt: number): void;
  protected log(msg: string): void;
}`;
    const result = parseTypeSignatures(input);
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].methods).toEqual(['initialize', 'update', 'log']);
  });

  it('parses class with getters and setters', () => {
    const input = `
// src/config.ts
export class AppConfig {
  private _host: string;
  get host(): string;
  set host(value: string);
  static getInstance(): AppConfig;
}`;
    const result = parseTypeSignatures(input);
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].fields).toEqual(['_host']);
    expect(result.classes[0].methods).toContain('host');
    expect(result.classes[0].methods).toContain('getInstance');
  });

  it('skips constructor in class methods', () => {
    const input = `
// src/app.ts
export class App {
  constructor(config: Config);
  run(): void;
}`;
    const result = parseTypeSignatures(input);
    expect(result.classes[0].methods).toEqual(['run']);
    expect(result.classes[0].methods).not.toContain('constructor');
  });

  it('returns empty result for empty input', () => {
    const empty = { enums: [], interfaces: [], types: [], classes: [] };
    expect(parseTypeSignatures('')).toEqual(empty);
    expect(parseTypeSignatures(null)).toEqual(empty);
    expect(parseTypeSignatures(undefined)).toEqual(empty);
  });

  it('handles header text before file sections', () => {
    const input = `
### IMPORTED TYPE SIGNATURES
Types/interfaces from imported dependencies (for reference, do not modify these files):

// src/types.ts
export enum Status {
  Active = 'active',
}`;
    const result = parseTypeSignatures(input);
    expect(result.enums).toHaveLength(1);
    expect(result.enums[0].name).toBe('Status');
  });
});

// ─── validateTaskAgainstTypes ───────────────────────────────────────────

describe('validateTaskAgainstTypes', () => {
  const parsedTypes = {
    enums: [
      { name: 'BillingCadence', file: 'src/types.ts', members: ['Weekly', 'Biweekly', 'Monthly'] },
    ],
    interfaces: [
      {
        name: 'SubscriptionPlanDefinition', file: 'src/types.ts',
        fields: ['id', 'name', 'renewalAmount', 'cadence', 'description'],
      },
    ],
    types: [
      { name: 'Status', file: 'src/types.ts', definition: "'active' | 'inactive'" },
    ],
  };

  it('detects wrong enum value', () => {
    const task = 'Add a template with BillingCadence.Quarterly and amount 75';
    const result = validateTaskAgainstTypes(task, parsedTypes);
    expect(result.hints.length).toBeGreaterThan(0);
    expect(result.hints[0]).toContain('Quarterly');
    expect(result.hints[0]).toContain('Weekly');
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('does not flag valid enum value', () => {
    const task = 'Add a template with BillingCadence.Monthly and amount 50';
    const result = validateTaskAgainstTypes(task, parsedTypes);
    // No enum mismatch hints
    const enumHints = result.hints.filter(h => h.includes('BillingCadence'));
    expect(enumHints).toHaveLength(0);
  });

  it('detects wrong field name with suggestion', () => {
    const task = 'Set the SubscriptionPlanDefinition billingAmount to 100';
    const result = validateTaskAgainstTypes(task, parsedTypes);
    expect(result.hints.length).toBeGreaterThan(0);
    const fieldHint = result.hints.find(h => h.includes('billingAmount'));
    expect(fieldHint).toBeDefined();
    expect(fieldHint).toContain('renewalAmount');
  });

  it('does not flag valid field name', () => {
    const task = 'Update the SubscriptionPlanDefinition renewalAmount to 100';
    const result = validateTaskAgainstTypes(task, parsedTypes);
    const fieldHints = result.hints.filter(h => h.includes('renewalAmount') && h.includes('No'));
    expect(fieldHints).toHaveLength(0);
  });

  it('detects type collision', () => {
    const task = 'Add a new Status enum to track progress';
    const result = validateTaskAgainstTypes(task, parsedTypes);
    expect(result.hints.length).toBeGreaterThan(0);
    expect(result.hints.some(h => h.includes('already exists'))).toBe(true);
  });

  it('handles case-insensitive enum value check', () => {
    const task = 'Use BillingCadence.monthly for the default';
    const result = validateTaskAgainstTypes(task, parsedTypes);
    // 'monthly' matches 'Monthly' case-insensitively — no hint
    const enumHints = result.hints.filter(h => h.includes('BillingCadence') && h.includes('no'));
    expect(enumHints).toHaveLength(0);
  });

  it('returns no hints when no types match', () => {
    const task = 'Refactor the database connection pool';
    const result = validateTaskAgainstTypes(task, parsedTypes);
    expect(result.hints).toHaveLength(0);
    expect(result.warnings).toBe(0);
  });

  it('returns no hints for null inputs', () => {
    expect(validateTaskAgainstTypes(null, parsedTypes).hints).toHaveLength(0);
    expect(validateTaskAgainstTypes('some task', null).hints).toHaveLength(0);
    expect(validateTaskAgainstTypes('', parsedTypes).hints).toHaveLength(0);
  });

  it('detects multiple wrong enum values', () => {
    const task = 'Support BillingCadence.Quarterly and BillingCadence.Annually';
    const result = validateTaskAgainstTypes(task, parsedTypes);
    expect(result.hints.length).toBe(2);
    expect(result.hints[0]).toContain('Quarterly');
    expect(result.hints[1]).toContain('Annually');
  });

  it('detects wrong class method name with suggestion', () => {
    const typesWithClass = {
      ...parsedTypes,
      classes: [
        { name: 'AccountService', file: 'src/services/AccountService.ts', methods: ['getUser', 'loadProfile', 'resetState'], fields: ['requestCount'] },
      ],
    };
    const task = 'Call the AccountService getUsr method to fetch account details';
    const result = validateTaskAgainstTypes(task, typesWithClass);
    const classHint = result.hints.find(h => h.includes('getUsr'));
    expect(classHint).toBeDefined();
    expect(classHint).toContain('getUser');
  });

  it('does not flag valid class method', () => {
    const typesWithClass = {
      enums: [], interfaces: [], types: [],
      classes: [
        { name: 'AccountService', file: 'src/services/AccountService.ts', methods: ['getUser', 'loadProfile'], fields: [] },
      ],
    };
    // Only use the class name + valid method — no extra tokens to trigger false positives
    const task = 'In AccountService, call loadProfile';
    const result = validateTaskAgainstTypes(task, typesWithClass);
    // loadProfile is a valid method — should not produce a hint about it
    const methodHints = result.hints.filter(h => h.includes('loadProfile') && h.includes('No'));
    expect(methodHints).toHaveLength(0);
  });

  it('detects class type collision', () => {
    const typesWithClass = {
      ...parsedTypes,
      classes: [
        { name: 'AccountManager', file: 'src/services/AccountManager.ts', methods: ['update'], fields: [] },
      ],
    };
    const task = 'Add a new AccountManager class for handling accounts';
    const result = validateTaskAgainstTypes(task, typesWithClass);
    expect(result.hints.some(h => h.includes('already exists') && h.includes('class'))).toBe(true);
  });
});

// ─── _fuzzyMatch ────────────────────────────────────────────────────────

describe('_fuzzyMatch', () => {
  it('returns exact substring match', () => {
    expect(_fuzzyMatch('amount', ['renewalAmount', 'cadence'])).toBe('renewalAmount');
  });

  it('returns closest match above threshold', () => {
    expect(_fuzzyMatch('billingAmount', ['renewalAmount', 'id', 'name'])).toBe('renewalAmount');
  });

  it('returns null for no candidates', () => {
    expect(_fuzzyMatch('foo', [])).toBeNull();
    expect(_fuzzyMatch('foo', null)).toBeNull();
  });

  it('returns null when no good match', () => {
    expect(_fuzzyMatch('xyz', ['abc', 'def'])).toBeNull();
  });
});

// ─── buildPreflightHints ────────────────────────────────────────────────

describe('buildPreflightHints', () => {
  it('formats hint array into prompt block', () => {
    const hints = [
      'BillingCadence has values: Weekly, Biweekly, Monthly. There is no "Quarterly" value.',
      'SubscriptionPlanDefinition fields: id, name. No "billingAmount" field.',
    ];
    const result = buildPreflightHints(hints);
    expect(result).toContain('### TYPE VALIDATION NOTES');
    expect(result).toContain('- BillingCadence');
    expect(result).toContain('- SubscriptionPlanDefinition');
    expect(result).toContain('IMPORTANT: Use only the types and fields listed above.');
  });

  it('returns empty string for empty hints', () => {
    expect(buildPreflightHints([])).toBe('');
    expect(buildPreflightHints(null)).toBe('');
    expect(buildPreflightHints(undefined)).toBe('');
  });

  it('handles single hint', () => {
    const result = buildPreflightHints(['Some correction note']);
    expect(result).toContain('### TYPE VALIDATION NOTES');
    expect(result).toContain('- Some correction note');
  });
});
