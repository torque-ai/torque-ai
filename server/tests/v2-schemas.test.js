const {
  MODEL_SOURCES,
  validateInferenceRequest,
  validateProviderQuery,
} = require('../api/v2-schemas');

describe('MODEL_SOURCES', () => {
  it('includes registry and live provider API model inventories', () => {
    expect(MODEL_SOURCES).toEqual(expect.arrayContaining([
      'provider_api_live',
      'registry',
    ]));
  });
});

describe('validateInferenceRequest', () => {
  it('accepts a prompt payload and normalizes string fields', () => {
    const result = validateInferenceRequest({
      prompt: '  Ship the patch  ',
      provider: '  codex  ',
      model: '  gpt-5.3-codex-spark  ',
      stream: false,
      async: true,
      transport: '  HYBRID  ',
      timeout_ms: 120000,
    });

    expect(result).toEqual({
      valid: true,
      errors: [],
      value: {
        prompt: 'Ship the patch',
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        stream: false,
        async: true,
        transport: 'hybrid',
        timeout_ms: 120000,
      },
    });
  });

  it('accepts messages and falls back to the configured default provider', () => {
    const result = validateInferenceRequest({
      messages: [
        { role: ' user ', content: '  Review this diff  ' },
        { role: 'assistant', content: 42 },
        { role: 'system', content: false },
      ],
    }, { defaultProvider: '  ollama  ' });

    expect(result).toEqual({
      valid: true,
      errors: [],
      value: {
        messages: [
          { role: 'user', content: 'Review this diff' },
          { role: 'assistant', content: '42' },
          { role: 'system', content: 'false' },
        ],
        provider: 'ollama',
      },
    });
  });

  it('rejects non-object request bodies', () => {
    const result = validateInferenceRequest('invalid');

    expect(result.valid).toBe(false);
    expect(result.value).toEqual({});
    expect(result.errors).toEqual([
      expect.objectContaining({
        field: 'body',
        code: 'type',
      }),
    ]);
  });

  it('rejects payloads that omit both prompt and messages and have no default provider', () => {
    const result = validateInferenceRequest({
      model: 'gpt-5.3-codex-spark',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'messages',
          code: 'missing',
        }),
        expect.objectContaining({
          field: 'provider',
          code: 'missing',
        }),
      ]),
    );
  });

  it('rejects payloads that provide both prompt and messages', () => {
    const result = validateInferenceRequest({
      prompt: 'hello',
      messages: [{ role: 'user', content: 'world' }],
      provider: 'codex',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'messages',
          code: 'ambiguous',
        }),
      ]),
    );
  });

  it('rejects invalid message entries and invalid scalar fields', () => {
    const result = validateInferenceRequest({
      messages: [
        null,
        { role: ' ', content: 'hi' },
        { role: 'user', content: ' ' },
      ],
      provider: 'codex',
      stream: 'true',
      async: 'false',
      transport: 'webrtc',
      timeout_ms: 0,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'messages[0]',
          code: 'type',
        }),
        expect.objectContaining({
          field: 'messages[1].role',
          code: 'type',
        }),
        expect.objectContaining({
          field: 'messages[2].content',
          code: 'type',
        }),
        expect.objectContaining({
          field: 'stream',
          code: 'type',
        }),
        expect.objectContaining({
          field: 'async',
          code: 'type',
        }),
        expect.objectContaining({
          field: 'transport',
          code: 'value',
        }),
        expect.objectContaining({
          field: 'timeout_ms',
          code: 'range',
        }),
      ]),
    );
  });
});

describe('validateProviderQuery', () => {
  it('accepts and normalizes provider filters', () => {
    const result = validateProviderQuery({
      id: '  codex  ',
      transport: ' HYBRID ',
      status: ' HEALTHY ',
      enabled: 'true',
      default: '0',
      local: false,
      include_disabled: '1',
    });

    expect(result).toEqual({
      valid: true,
      errors: [],
      value: {
        provider_id: 'codex',
        transport: 'hybrid',
        status: 'healthy',
        enabled: true,
        default: false,
        local: false,
        include_disabled: true,
      },
    });
  });

  it('accepts matching id and provider_id aliases', () => {
    const result = validateProviderQuery({
      id: 'groq',
      provider_id: 'groq',
    }, { requireId: true });

    expect(result).toEqual({
      valid: true,
      errors: [],
      value: {
        provider_id: 'groq',
      },
    });
  });

  it('rejects non-object query payloads', () => {
    const result = validateProviderQuery('invalid');

    expect(result.valid).toBe(false);
    expect(result.value).toEqual({});
    expect(result.errors).toEqual([
      expect.objectContaining({
        field: 'query',
        code: 'type',
      }),
    ]);
  });

  it('rejects missing provider ids when requireId is enabled', () => {
    const result = validateProviderQuery({}, { requireId: true });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'provider_id',
          code: 'missing',
        }),
      ]),
    );
  });

  it('rejects conflicting id aliases', () => {
    const result = validateProviderQuery({
      id: 'codex',
      provider_id: 'groq',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'provider_id',
          code: 'ambiguous',
        }),
      ]),
    );
  });

  it('rejects invalid enum and boolean query values', () => {
    const result = validateProviderQuery({
      transport: 'smtp',
      status: 'completed',
      enabled: 'yes',
      default: 'no',
      local: 'sometimes',
      include_disabled: 'maybe',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'transport',
          code: 'value',
        }),
        expect.objectContaining({
          field: 'status',
          code: 'value',
        }),
        expect.objectContaining({
          field: 'enabled',
          code: 'type',
        }),
        expect.objectContaining({
          field: 'default',
          code: 'type',
        }),
        expect.objectContaining({
          field: 'local',
          code: 'type',
        }),
        expect.objectContaining({
          field: 'include_disabled',
          code: 'type',
        }),
      ]),
    );
  });
});
