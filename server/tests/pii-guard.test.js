'use strict';

const os = require('os');

describe('pii-guard', () => {
  let piiGuard;

  beforeEach(() => {
    vi.resetModules();
    piiGuard = require('../utils/pii-guard');
  });

  describe('scanAndReplace', () => {
    it('replaces Windows user paths', () => {
      const result = piiGuard.scanAndReplace('File at C:\\Users\\alice\\Projects\\torque');
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('File at C:\\Users\\<user>\\Projects\\torque');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].category).toBe('user_paths');
    });

    it('replaces Linux user paths', () => {
      const result = piiGuard.scanAndReplace('Path /home/alice/code/app');
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('Path /home/<user>/code/app');
    });

    it('replaces Mac user paths', () => {
      const result = piiGuard.scanAndReplace('Path /Users/alice/Desktop');
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('Path /Users/<user>/Desktop');
    });

    it('replaces 192.168.x.x preserving last octet', () => {
      const result = piiGuard.scanAndReplace('Host: 192.168.55.100');
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('Host: 192.0.2.100');
    });

    it('replaces 10.x.x.x preserving last octet', () => {
      const result = piiGuard.scanAndReplace('Gateway: 10.0.0.1');
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('Gateway: 10.0.0.1');
    });

    it('replaces 172.16.0.0/12 addresses preserving last octet', () => {
      const result = piiGuard.scanAndReplace('VPN: 172.16.0.45');
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('VPN: 172.16.0.45');
    });

    it('does NOT replace RFC 5737 documentation IPs', () => {
      const result = piiGuard.scanAndReplace('Example: 192.0.2.100');
      expect(result.clean).toBe(true);
    });

    it('does NOT replace public IPs', () => {
      const result = piiGuard.scanAndReplace('DNS: 8.8.8.8');
      expect(result.clean).toBe(true);
    });

    it('replaces real email addresses', () => {
      const result = piiGuard.scanAndReplace('Contact: alice@corp.test');
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('Contact: user@example.com');
    });

    it('does NOT replace example.com emails', () => {
      const result = piiGuard.scanAndReplace('Contact: user@example.com');
      expect(result.clean).toBe(true);
    });

    it('does NOT replace noreply@ emails', () => {
      const result = piiGuard.scanAndReplace('Co-Authored-By: Bot <noreply@anthropic.com>');
      expect(result.clean).toBe(true);
    });

    it('replaces the current hostname when available', () => {
      const hostname = os.hostname();
      if (!hostname || hostname.length <= 2) {
        return;
      }

      const result = piiGuard.scanAndReplace(`Host: ${hostname}`);
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('Host: <hostname>');
      expect(result.findings[0].category).toBe('hostnames');
    });

    it('returns clean=true for safe text', () => {
      const result = piiGuard.scanAndReplace('Hello world, no PII here.');
      expect(result.clean).toBe(true);
      expect(result.sanitized).toBe('Hello world, no PII here.');
      expect(result.findings).toHaveLength(0);
    });

    it('handles empty string', () => {
      const result = piiGuard.scanAndReplace('');
      expect(result.clean).toBe(true);
      expect(result.sanitized).toBe('');
    });

    it('handles null/undefined gracefully', () => {
      const result = piiGuard.scanAndReplace(null);
      expect(result.clean).toBe(true);
      expect(result.sanitized).toBe('');
    });

    it('replaces multiple PII types in one string', () => {
      const input = 'User C:\\Users\\alice at 192.168.55.50 email alice@corp.test';
      const result = piiGuard.scanAndReplace(input);
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('User C:\\Users\\<user> at 192.0.2.50 email user@example.com');
      expect(result.findings.length).toBeGreaterThanOrEqual(3);
    });

    it('applies custom string patterns', () => {
      const result = piiGuard.scanAndReplace('Host: ZzTestHost999', {
        customPatterns: [{ pattern: 'ZzTestHost999', replacement: 'example-host' }],
      });
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('Host: example-host');
    });

    it('applies custom regex patterns', () => {
      const result = piiGuard.scanAndReplace('Project: AcmeProject v2', {
        customPatterns: [{ pattern: 'AcmeProject', replacement: 'example-project', regex: true }],
      });
      expect(result.clean).toBe(false);
      expect(result.sanitized).toBe('Project: example-project v2');
    });

    it('respects builtinOverrides to disable categories', () => {
      const result = piiGuard.scanAndReplace('Path /home/<user>/code', {
        builtinOverrides: { user_paths: false },
      });
      expect(result.clean).toBe(true);
      expect(result.sanitized).toBe('Path /home/<user>/code');
    });

    it('reports line numbers in findings', () => {
      const input = 'Line one\nPath C:\\Users\\alice\\foo\nLine three';
      const result = piiGuard.scanAndReplace(input);
      expect(result.findings[0].line).toBe(2);
    });
  });
});
