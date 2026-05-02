'use strict';

const path = require('path');
const Database = require('better-sqlite3');

// Mock credential-crypto so we don't depend on real key material; the
// crypto functions themselves are tested elsewhere (credential-crypto.test.js).
function installMock(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const fakeKey = Buffer.alloc(32, 0x42);
const mockCrypto = {
  getOrCreateKey: vi.fn(() => fakeKey),
  encrypt: vi.fn((payload) => ({
    encrypted_value: 'enc-' + JSON.stringify(payload),
    iv: 'iv',
    auth_tag: 'tag',
  })),
  decrypt: vi.fn((enc) => {
    if (typeof enc === 'string' && enc.startsWith('enc-')) {
      return JSON.parse(enc.slice(4));
    }
    throw new Error('cannot decrypt');
  }),
};
installMock(
  path.join(__dirname, '..', 'utils', 'credential-crypto.js'),
  mockCrypto,
);

const {
  resolveDbHandle,
  ensureManagedOAuthTables,
  encryptSecret,
  decryptSecret,
  parseMetadata,
  normalizeRequiredString,
  normalizeOptionalString,
  normalizeRequiredSecret,
  normalizeOptionalSecret,
  normalizeAuthType,
  normalizeOptionalTimestamp,
  normalizeMetadataObject,
} = require('../auth/store-utils');

describe('resolveDbHandle', () => {
  it('returns the handle when it has prepare + exec', () => {
    const handle = { prepare: () => {}, exec: () => {} };
    expect(resolveDbHandle(handle)).toBe(handle);
  });

  it('calls getDbInstance when the input has it', () => {
    const inner = { prepare: () => {}, exec: () => {} };
    const outer = { getDbInstance: () => inner };
    expect(resolveDbHandle(outer)).toBe(inner);
  });

  it('returns null for null/undefined', () => {
    expect(resolveDbHandle(null)).toBeNull();
    expect(resolveDbHandle(undefined)).toBeNull();
  });

  it('returns null for plain objects without prepare/exec/getDbInstance', () => {
    expect(resolveDbHandle({ foo: 'bar' })).toBeNull();
  });
});

describe('ensureManagedOAuthTables', () => {
  it('creates the auth_configs and connected_accounts tables', () => {
    const db = new Database(':memory:');
    ensureManagedOAuthTables(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const names = tables.map(t => t.name);
    expect(names).toContain('auth_configs');
    expect(names).toContain('connected_accounts');
    db.close();
  });

  it('is idempotent (safe to call twice)', () => {
    const db = new Database(':memory:');
    ensureManagedOAuthTables(db);
    expect(() => ensureManagedOAuthTables(db)).not.toThrow();
    db.close();
  });

  it('creates the expected indexes on connected_accounts', () => {
    const db = new Database(':memory:');
    ensureManagedOAuthTables(db);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='connected_accounts'"
    ).all().map(i => i.name);
    expect(indexes).toContain('idx_conn_accounts_user_toolkit');
    expect(indexes).toContain('idx_conn_accounts_status');
    db.close();
  });
});

describe('normalizeRequiredString', () => {
  it('returns the trimmed string', () => {
    expect(normalizeRequiredString('  hello  ', 'name')).toBe('hello');
    expect(normalizeRequiredString('hello', 'name')).toBe('hello');
  });

  it('throws for empty/whitespace string', () => {
    expect(() => normalizeRequiredString('', 'name')).toThrow('name is required');
    expect(() => normalizeRequiredString('   ', 'name')).toThrow('name is required');
  });

  it('throws for non-string', () => {
    expect(() => normalizeRequiredString(null, 'name')).toThrow('name is required');
    expect(() => normalizeRequiredString(undefined, 'name')).toThrow('name is required');
    expect(() => normalizeRequiredString(42, 'name')).toThrow('name is required');
  });
});

describe('normalizeOptionalString', () => {
  it('returns null for undefined/null', () => {
    expect(normalizeOptionalString(undefined, 'x')).toBeNull();
    expect(normalizeOptionalString(null, 'x')).toBeNull();
  });

  it('returns null for empty/whitespace string', () => {
    expect(normalizeOptionalString('', 'x')).toBeNull();
    expect(normalizeOptionalString('   ', 'x')).toBeNull();
  });

  it('returns the trimmed value for non-empty strings', () => {
    expect(normalizeOptionalString('  hello  ', 'x')).toBe('hello');
  });

  it('throws for non-string types', () => {
    expect(() => normalizeOptionalString(42, 'x')).toThrow('x must be a string');
    expect(() => normalizeOptionalString({}, 'x')).toThrow('x must be a string');
  });
});

describe('normalizeRequiredSecret', () => {
  it('returns the value unchanged (no trimming for secrets)', () => {
    expect(normalizeRequiredSecret('  has-padding  ', 'secret')).toBe('  has-padding  ');
  });

  it('throws for empty/whitespace strings', () => {
    expect(() => normalizeRequiredSecret('', 's')).toThrow('s is required');
    expect(() => normalizeRequiredSecret('   ', 's')).toThrow('s is required');
  });

  it('throws for non-string', () => {
    expect(() => normalizeRequiredSecret(null, 's')).toThrow('s is required');
  });
});

describe('normalizeOptionalSecret', () => {
  it('returns null for undefined/null/empty', () => {
    expect(normalizeOptionalSecret(undefined, 's')).toBeNull();
    expect(normalizeOptionalSecret(null, 's')).toBeNull();
    expect(normalizeOptionalSecret('', 's')).toBeNull();
  });

  it('preserves whitespace in secrets', () => {
    expect(normalizeOptionalSecret('  padded  ', 's')).toBe('  padded  ');
  });

  it('throws for non-string', () => {
    expect(() => normalizeOptionalSecret(42, 's')).toThrow('s must be a string');
  });
});

describe('normalizeAuthType', () => {
  it('accepts each valid auth type', () => {
    expect(normalizeAuthType('oauth2')).toBe('oauth2');
    expect(normalizeAuthType('api_key')).toBe('api_key');
    expect(normalizeAuthType('basic')).toBe('basic');
    expect(normalizeAuthType('bearer')).toBe('bearer');
  });

  it('trims surrounding whitespace before validation', () => {
    expect(normalizeAuthType('  oauth2  ')).toBe('oauth2');
  });

  it('throws for invalid auth_type', () => {
    expect(() => normalizeAuthType('invalid')).toThrow('auth_type must be one of: oauth2, api_key, basic, bearer');
    expect(() => normalizeAuthType('OAUTH2')).toThrow(); // case-sensitive
  });

  it('throws for empty/missing', () => {
    expect(() => normalizeAuthType('')).toThrow('auth_type is required');
    expect(() => normalizeAuthType(null)).toThrow('auth_type is required');
  });
});

describe('normalizeOptionalTimestamp', () => {
  it('returns null for null/undefined/empty', () => {
    expect(normalizeOptionalTimestamp(undefined, 'ts')).toBeNull();
    expect(normalizeOptionalTimestamp(null, 'ts')).toBeNull();
    expect(normalizeOptionalTimestamp('', 'ts')).toBeNull();
  });

  it('coerces numeric strings', () => {
    expect(normalizeOptionalTimestamp('1234567890', 'ts')).toBe(1234567890);
  });

  it('returns the number itself for numeric input', () => {
    expect(normalizeOptionalTimestamp(1234567890, 'ts')).toBe(1234567890);
    expect(normalizeOptionalTimestamp(0, 'ts')).toBe(0);
  });

  it('throws for non-finite values', () => {
    expect(() => normalizeOptionalTimestamp('abc', 'ts')).toThrow('ts must be a finite number');
    expect(() => normalizeOptionalTimestamp(NaN, 'ts')).toThrow('ts must be a finite number');
    expect(() => normalizeOptionalTimestamp(Infinity, 'ts')).toThrow('ts must be a finite number');
  });
});

describe('normalizeMetadataObject', () => {
  it('returns {} for null/undefined', () => {
    expect(normalizeMetadataObject(null)).toEqual({});
    expect(normalizeMetadataObject(undefined)).toEqual({});
  });

  it('passes through plain objects unchanged (same reference)', () => {
    const input = { foo: 'bar' };
    expect(normalizeMetadataObject(input)).toBe(input);
  });

  it('throws for arrays', () => {
    expect(() => normalizeMetadataObject([])).toThrow('metadata must be a plain object');
    expect(() => normalizeMetadataObject([1, 2])).toThrow('metadata must be a plain object');
  });

  it('throws for primitives', () => {
    expect(() => normalizeMetadataObject('string')).toThrow();
    expect(() => normalizeMetadataObject(42)).toThrow();
    expect(() => normalizeMetadataObject(true)).toThrow();
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('encrypts a non-empty string into a JSON envelope', () => {
    const result = encryptSecret('my-token');
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result);
    expect(parsed).toMatchObject({ encrypted_value: expect.any(String), iv: 'iv', auth_tag: 'tag' });
  });

  it('returns null for empty/non-string secrets', () => {
    expect(encryptSecret('')).toBeNull();
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(42)).toBeNull();
  });

  it('round-trips a secret through encrypt+decrypt', () => {
    const enc = encryptSecret('round-trip-value');
    expect(decryptSecret(enc)).toBe('round-trip-value');
  });

  it('returns null for empty/non-string ciphertext', () => {
    expect(decryptSecret('')).toBeNull();
    expect(decryptSecret('   ')).toBeNull();
    expect(decryptSecret(null)).toBeNull();
  });

  it('returns null when decryption throws', () => {
    expect(decryptSecret('not-a-json-envelope')).toBeNull();
  });

  it('returns null when decrypted payload has no value field', () => {
    // Construct a JSON envelope that decrypts to an object with no .value
    const enc = 'enc-' + JSON.stringify({});
    const envelope = JSON.stringify({ encrypted_value: enc, iv: 'iv', auth_tag: 'tag' });
    expect(decryptSecret(envelope)).toBeNull();
  });
});

describe('parseMetadata', () => {
  it('returns {} for empty/non-string input', () => {
    expect(parseMetadata('')).toEqual({});
    expect(parseMetadata('   ')).toEqual({});
    expect(parseMetadata(null)).toEqual({});
    expect(parseMetadata(undefined)).toEqual({});
    expect(parseMetadata(42)).toEqual({});
  });

  it('parses a JSON object string', () => {
    expect(parseMetadata('{"a": 1}')).toEqual({ a: 1 });
  });

  it('returns {} for malformed JSON', () => {
    expect(parseMetadata('{not valid')).toEqual({});
  });

  it('returns {} when JSON parses to non-object', () => {
    expect(parseMetadata('"a string"')).toEqual({});
    expect(parseMetadata('42')).toEqual({});
    expect(parseMetadata('true')).toEqual({});
    expect(parseMetadata('null')).toEqual({});
  });

  it('returns {} for arrays', () => {
    expect(parseMetadata('[1, 2]')).toEqual({});
  });
});
