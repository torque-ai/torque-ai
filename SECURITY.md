# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x-beta | Yes |

## Reporting a Vulnerability

If you discover a security vulnerability in TORQUE, please report it responsibly:

1. **Do NOT open a public issue** for security vulnerabilities
2. Use [GitHub Security Advisories](https://github.com/torque-ai/torque-ai/security/advisories/new) to report privately, or email **security@torque-ai.dev** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if any)

## Response Timeline

- **Acknowledgment:** Within 48 hours of report
- **Assessment:** Within 5 business days
- **Fix (Critical/High):** Within 14 days
- **Fix (Medium/Low):** Within 30 days

## Security Practices

### Authentication
- API keys use HMAC-SHA-256 hashing — plaintext keys are never stored
- REST API requires `Authorization: Bearer` or `X-Torque-Key` header for authenticated endpoints
- MCP SSE transport uses session tokens (one-time use, 60s TTL)
- Shutdown endpoint restricted to localhost + API key
- Health/readiness/liveness probes are intentionally unauthenticated

### Data Protection
- API keys and secrets are redacted from logs via pattern matching
- Database credentials are never exposed in API responses
- HMAC-SHA256 verification for inbound webhooks
- See [PRIVACY.md](PRIVACY.md) for data locality guarantees

### Network Security
- SSRF protection via hostname pattern validation on webhook URLs
- HTTPS enforcement for outbound webhook delivery
- Rate limiting (200 req/min per IP) on REST API
- Security headers (X-Frame-Options, X-Content-Type-Options, X-XSS-Protection) on all HTTP responses
- CORS restricted to configured origins

### Dependency Management
- Regular `npm audit` checks in CI pipeline
- No production dependencies with known critical vulnerabilities

## Security Audit (2026-03-14)

A comprehensive security audit identified and resolved all findings:

| Severity | Found | Fixed |
|----------|-------|-------|
| Critical | 3 | 3 |
| High | 5 | 5 |
| Medium | 16 | 16 |
| Low | 3 | 3 |

Key fixes:
- Environment variable injection prevention (child processes no longer inherit all parent env vars)
- Strict authentication defaults for V2 control plane API
- Sensitive file filtering in context stuffing (`.env` files excluded from cloud API prompts)
- Double-encoding path traversal blocking
- IPv6 SSRF bypass prevention
- Per-tool authorization support

## MCP Plugin Context

When installed as an MCP server, TORQUE:
- Spawns child processes only when the user explicitly submits a task — never automatically
- Makes network calls only to user-configured providers (Ollama hosts, cloud APIs)
- Starts with core tools only — advanced tools require explicit unlock via `unlock_tier` or `unlock_all_tools`
- Stores all data locally in SQLite — see [PRIVACY.md](PRIVACY.md)

## Known Limitations

- Dashboard WebSocket connections do not currently require authentication (tracked as RB-074)
- MCP SSE transport relies on network-level access control
- Local Ollama communication is unencrypted (intended for trusted LAN only)
