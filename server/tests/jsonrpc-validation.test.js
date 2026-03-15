const {
  JSON_RPC_ERRORS,
  validateJsonRpcRequest,
  makeJsonRpcError,
  tryParseJsonRpc,
} = require('../utils/jsonrpc-validation');

describe('jsonrpc-validation', () => {
  describe('validateJsonRpcRequest', () => {
    it('accepts a valid JSON-RPC request', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 42,
        params: { filter: 'all' },
      };

      expect(validateJsonRpcRequest(request)).toEqual({
        valid: true,
        id: 42,
      });
    });

    it('accepts a notification request without an id', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: { ready: true },
      };

      expect(validateJsonRpcRequest(request)).toEqual({
        valid: true,
        id: null,
      });
    });

    it('accepts a null id as an edge case', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: null,
      };

      expect(validateJsonRpcRequest(request)).toEqual({
        valid: true,
        id: null,
      });
    });

    it('accepts array params in a request', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'batch/op',
        id: 'batch-1',
        params: ['a', 'b'],
      };

      expect(validateJsonRpcRequest(request)).toEqual({
        valid: true,
        id: 'batch-1',
      });
    });

    it('rejects batch request payloads at top-level', () => {
      const batch = [
        { jsonrpc: '2.0', method: 'tools/list', id: 1 },
        { jsonrpc: '2.0', method: 'tools/call', id: 2 },
      ];

      expect(validateJsonRpcRequest(batch)).toEqual({
        valid: false,
        error: JSON_RPC_ERRORS.INVALID_REQUEST,
        id: null,
      });
    });

    it('rejects missing method', () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
      };

      expect(validateJsonRpcRequest(request)).toEqual({
        valid: false,
        error: JSON_RPC_ERRORS.INVALID_REQUEST,
        id: 1,
      });
    });

    it('rejects empty string method', () => {
      const request = {
        jsonrpc: '2.0',
        method: '',
        id: 1,
      };

      expect(validateJsonRpcRequest(request)).toEqual({
        valid: false,
        error: JSON_RPC_ERRORS.INVALID_REQUEST,
        id: 1,
      });
    });

    it('rejects invalid params type', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1,
        params: 'should-not-be-string',
      };

      expect(validateJsonRpcRequest(request)).toEqual({
        valid: false,
        error: JSON_RPC_ERRORS.INVALID_PARAMS,
        id: 1,
      });
    });

    it('rejects invalid id types', () => {
      const invalidIds = [true, false, {}, [], () => 1];
      for (const id of invalidIds) {
        const request = {
          jsonrpc: '2.0',
          method: 'tools/list',
          id,
        };

        expect(validateJsonRpcRequest(request)).toEqual({
          valid: false,
          error: JSON_RPC_ERRORS.INVALID_REQUEST,
          id,
        });
      }
    });
  });

  describe('tryParseJsonRpc', () => {
    it('parses valid JSON-RPC response JSON', () => {
      const raw = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { ok: true },
      });
      const result = tryParseJsonRpc(raw);

      expect(result).toEqual({
        parsed: {
          jsonrpc: '2.0',
          id: 1,
          result: { ok: true },
        },
      });
    });

    it('returns parse error response for invalid JSON', () => {
      const result = tryParseJsonRpc('{ "jsonrpc": "2.0", "id": 1,');

      expect(result.parsed).toBeUndefined();
      expect(result.error).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JSON_RPC_ERRORS.PARSE_ERROR.code,
          message: expect.stringContaining('Parse error:'),
        },
      });
    });
  });

  describe('makeJsonRpcError', () => {
    it('builds a valid JSON-RPC error response', () => {
      const response = makeJsonRpcError('2', JSON_RPC_ERRORS.METHOD_NOT_FOUND, 'missing');

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: '2',
        error: {
          code: JSON_RPC_ERRORS.METHOD_NOT_FOUND.code,
          message: 'Method not found: missing',
        },
      });
    });

    it('returns required fields for error responses', () => {
      const response = makeJsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST);

      expect(response).toHaveProperty('jsonrpc', '2.0');
      expect(response).toHaveProperty('id', null);
      expect(response).toHaveProperty('error.code', JSON_RPC_ERRORS.INVALID_REQUEST.code);
      expect(response).toHaveProperty('error.message', JSON_RPC_ERRORS.INVALID_REQUEST.message);
    });
  });
});
