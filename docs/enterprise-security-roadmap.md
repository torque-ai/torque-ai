# TORQUE Enterprise Security Roadmap

**Status:** Future multi-user deployment roadmap
**Audience:** Maintainers planning shared team, lab, or enterprise deployments
**Baseline:** Track A secure-by-default single-user deployment
**Last updated:** 2026-04-20

This document describes how TORQUE should evolve from the current single-operator
security model into a multi-user deployment model. It is not a commercial
packaging plan and does not change the current open-source deployment posture.
The intent is to make the dependency order, implementation scope, and readiness
gates clear before any multi-user or externally reachable deployment is built.

---

## Current Security Baseline

Track A establishes a secure default for the current single-user model:

- MCP requests are authenticated at the protocol handler, with `initialize`
  allowed before authentication so clients can complete setup
  (`server/mcp-protocol.js`).
- Stdio sessions are trusted process-local sessions; SSE sessions require an API
  key, authenticate reconnects, enforce session ownership checks, and cap total
  and per-IP connections (`server/mcp-sse.js`).
- API keys are generated on first startup and stored through the config layer;
  sensitive config values are encrypted where supported
  (`server/db/config-core.js`).
- Remote agent requests use timing-safe shared-secret comparison, reject missing
  secrets, whitelist environment variables, reject shell metacharacters, enforce
  command allowlists, constrain working directories, and cap captured output
  (`server/plugins/remote-agents/agent-server.js`).
- Backups write a `.sha256` sidecar on creation and require hash verification on
  restore unless an explicit force option is used (`server/db/backup-core.js`).
- CORS is strict by default for browser origins, request bodies have size/time
  limits, and SSE/WebSocket subscription and connection counts are capped.

This baseline is appropriate for one trusted operator running TORQUE on a local
machine with optional remote agents. It is not sufficient for a shared server,
regulated environment, hosted control plane, or deployment where different users
must be isolated from one another.

---

## Target Deployment Model

A future enterprise-ready deployment should support three profiles without
breaking the current single-user profile:

| Profile | Use case | Required controls |
| --- | --- | --- |
| Single operator | Local workstation or personal lab | Current Track A defaults |
| Team instance | Shared internal TORQUE server for a trusted team | User identity, scoped keys, RBAC, project isolation, audit logging |
| Enterprise instance | Shared server across teams, environments, or compliance boundaries | Team controls plus tenant quotas, immutable audit export, centralized identity, TLS policy, gateway integration |

All enterprise features should be additive and feature-gated. Existing local
installations should remain usable with the current API-key and localhost
dashboard model.

---

## Roadmap Matrix

| Capability | Dependency | Effort | Priority | Readiness gate |
| --- | --- | --- | --- | --- |
| Granular API key scoping | Current key manager | Medium | P1 | Keys can be read-only, submit-only, operator, or admin without handler-specific bypasses |
| RBAC enforcement | Scoped keys and user identity | Medium | P1 | Every REST, MCP, dashboard, and agent-control action maps to an explicit permission |
| Mandatory audit logging | Stable actor identity | Medium | P1 | State transitions, auth events, and protected config changes are recorded before commit |
| Project-level isolation | RBAC | Medium | P1 | Task, workflow, provider, host, and artifact queries are filtered by project membership |
| OAuth2/OIDC login | User/session model | High | P2 | External IdP users can log in without local passwords; sessions carry stable subject IDs |
| JWT session tokens | User/session model and RBAC | Medium | P2 | Dashboard/API sessions can be validated without database reads on every request |
| HMAC request signing | Scoped integration keys | Low | P2 | Integration requests include timestamp, nonce, and body signature with replay rejection |
| mTLS for remote agents | Agent registry identity | Medium | P2 | Each agent has a unique client cert, rotation path, and revocation handling |
| Secret rotation lifecycle | Key, JWT, HMAC, and agent secret stores | Medium | P3 | Current and previous secret versions overlap during a bounded grace period |
| Immutable audit trail | Mandatory audit logging | Medium | P3 | Audit rows form a verifiable hash chain and can be exported as signed NDJSON |
| Data retention policies | Project/tenant ownership | Medium | P3 | Records, outputs, and audit data expire by policy with legal-hold override |
| Namespace multi-tenancy | Project isolation and quotas | High | P3 | Providers, hosts, budgets, concurrency, and retention are isolated per namespace |
| TLS everywhere | Certificate configuration | Medium | P3 | Dashboard, REST, MCP, agent, and metrics listeners reject plaintext in enterprise mode |
| Interface binding policy | TLS and deployment config | Low | P3 | Each listener binds only to approved interfaces; unsafe `0.0.0.0` exposure is blocked or loudly warned |
| API gateway integration | Stable auth and health contracts | Medium | P3 | Reverse proxies can enforce TLS, rate limits, headers, and health checks with documented examples |

---

## Phase 1: Identity, Authorization, and Audit

### Granular API Key Scoping

The current API key model should evolve from role-only access into explicit
scopes. Each key record should include:

- `scopes`: normalized resource/action scopes such as `tasks:read`,
  `tasks:submit`, `tasks:cancel`, `workflows:manage`, `providers:read`,
  `providers:manage`, `audit:read`, and `admin:*`.
- `project_ids`: optional project restrictions for automation keys.
- `expires_at`, `last_used_at`, `created_by`, `revoked_at`, and optional IP
  allowlist metadata.

Handlers should check scopes through one shared authorization helper rather than
embedding authorization logic in each endpoint. MCP tool dispatch should use the
same permission table as REST/dashboard handlers so that transport choice does
not change authorization.

### Role-Based Access Control

RBAC should start with built-in roles that match existing TORQUE operations:

| Role | Permissions |
| --- | --- |
| Viewer | Read tasks, workflows, health, metrics, and non-sensitive provider status |
| Submitter | Viewer plus submit tasks/workflows within assigned projects |
| Operator | Submitter plus cancel tasks, manage providers/hosts, run approved maintenance |
| Auditor | Read audit logs and compliance exports; no mutation rights |
| Admin | Full system configuration, user management, key issuance, and break-glass actions |

Role checks must be enforced in middleware or a shared policy layer before
requests reach business logic. Admin-only operations should remain auditable even
when initiated from localhost.

### Mandatory Audit Logging

Audit logging should become part of the commit path for sensitive operations.
The audit record should include:

- Actor identity: user ID, API key ID, session ID, agent ID, or open-mode
  sentinel where applicable.
- Source metadata: IP, user agent, transport, request ID, and project/namespace.
- Resource metadata: resource type, resource ID, action, and result.
- Change data: redacted before/after JSON for config, provider, user, key, task,
  workflow, and namespace mutations.
- Timing: UTC timestamp and monotonic sequence number.

The audit API should expose filtered reads for Admin and Auditor roles only.
Log writes should be append-only from application code.

### Project-Level Isolation

Every user-facing resource should carry a `project_id` or inherit one through
its parent object. Query helpers should apply project filters centrally so list,
detail, metrics, event stream, and export endpoints cannot accidentally leak data
from another project. Project membership should support per-project roles and
should be checked before task cancellation, workflow mutation, artifact reads,
and provider use.

Phase 1 is complete when two users in different projects cannot observe or
mutate each other's tasks, workflows, artifacts, provider assignments, or events
through any transport.

---

## Phase 2: Enterprise Authentication

### OAuth2/OIDC Integration

TORQUE should act as an OIDC relying party for dashboard login and as an OAuth2
resource server for bearer-token API calls. Configuration should support
issuer discovery, client ID/secret, redirect URI, scopes, allowed domains, and
claim mapping. The OIDC `sub` claim should become the canonical external
identity linked to a local user record.

The authorization code flow with PKCE should be the default browser flow.
Refresh tokens should stay server-side or in secure `HttpOnly` cookies. The
system should support at least Okta, Azure AD/Entra ID, GitHub Enterprise, Google
Workspace, and generic OIDC providers through discovery metadata.

### JWT Session Tokens

After login or API-key exchange, TORQUE can issue short-lived signed access
tokens containing subject, role, scopes, project memberships, tenant namespace,
expiry, issuer, audience, and `jti`. Signing should use asymmetric keys with a
published JWKS endpoint so gateways and adjacent services can verify tokens.

Refresh tokens should be opaque server-side records, not long-lived bearer JWTs.
Logout, user disablement, and suspected compromise should add access-token JTIs
to a revocation table until natural expiry.

### HMAC Request Signing

For service integrations and remote automation, HMAC request signing should
protect request integrity and prevent replay:

- Client sends `X-Torque-Timestamp`, `X-Torque-Nonce`, and
  `X-Torque-Signature`.
- Signature input is method, canonical path, query hash, body SHA-256,
  timestamp, and nonce.
- Server rejects requests outside a short clock-skew window and stores nonces
  for the same window to reject replay.
- Each HMAC key is scoped like an API key and rotates through the same secret
  lifecycle.

HMAC signing is not a replacement for TLS; it is an additional integrity control
for automation clients and gateways.

### mTLS for Remote Agents

Remote agents should move from shared secret authentication to unique
certificate identities:

- Each registered agent receives a client certificate issued by a TORQUE-managed
  CA or by an external enterprise CA.
- The server validates the client certificate before accepting health, sync, or
  run requests.
- The registry stores certificate fingerprint, issuer, serial number, expiry,
  status, and last-seen metadata.
- Revocation should support a local denylist immediately and CRL/OCSP-compatible
  export later.

Shared-secret agent auth can remain as a compatibility mode, but enterprise mode
should require mTLS for network-exposed agents.

---

## Phase 3: Compliance and Tenant Controls

### Immutable Audit Trail

Mandatory audit logging should be extended with tamper evidence. Each audit row
should include a `chain_hash` derived from the previous row hash and canonical
event content. Verification should detect missing, modified, or reordered rows
and return the first invalid sequence number.

Compliance exports should produce signed NDJSON plus manifest metadata:

- Export time range, project/namespace filters, and actor filter.
- Hash of every exported object.
- Signature over the manifest.
- Verification command and expected digest.

### Data Retention Policies

Retention should be configurable by namespace and project:

- Task metadata and events: default 90 days.
- Task output and artifacts: default 30 to 90 days depending on size and
  sensitivity.
- Audit records: default 365 days or longer for regulated deployments.
- Backup files: count and age based retention with integrity sidecars preserved.

Retention jobs should soft-delete first, then hard-delete after a grace period.
Legal hold must override normal purge. Every purge batch should emit an audit
event and a summary artifact.

### Secret Rotation Lifecycle

All long-lived credentials should share one rotation model:

- Current and previous versions are accepted during an explicit overlap window.
- New credentials are generated server-side and shown once where applicable.
- Consumers receive expiry warnings before the old version is rejected.
- Break-glass rotation can revoke the previous version immediately.

This lifecycle should cover API keys, HMAC keys, JWT signing keys, session
secrets, agent shared secrets, mTLS CA material, webhook secrets, provider API
keys, and backup/export signing keys.

### Namespace Multi-Tenancy

Namespaces should isolate shared infrastructure across teams or environments.
Each namespace should define:

- Allowed providers and remote agents.
- Max concurrent tasks, workflow limits, queue priority bounds, and budget caps.
- Default retention policies and audit export destinations.
- Project membership boundaries.
- Optional dedicated data directory or database partition for high-isolation
  deployments.

The scheduler must check namespace capacity before assigning work. Provider and
host routing must never cross namespace boundaries unless an Admin has
explicitly configured a shared provider pool.

---

## Phase 4: Network and Deployment Hardening

### TLS Everywhere

Enterprise mode should reject plaintext access for dashboard, REST, MCP SSE,
streamable HTTP, agent, and metrics listeners. Certificate provisioning should
support:

- ACME for public names.
- Imported PEM bundles for internal PKI.
- Self-signed bootstrap certificates for airgapped labs, with clear warnings.
- Rotation without service restart where feasible.

The GPU metrics endpoint should support TLS and optional mTLS so only approved
Prometheus or collector instances can scrape it.

### Interface Binding Policy

Each listener should have explicit host/interface configuration. Enterprise mode
should treat `0.0.0.0` without TLS as invalid. Recommended defaults:

| Listener | Default single-user binding | Enterprise binding |
| --- | --- | --- |
| Dashboard | `127.0.0.1` | Gateway-facing private interface |
| REST API | `127.0.0.1` | Gateway-facing private interface |
| MCP SSE/HTTP | `127.0.0.1` unless explicitly exposed | Gateway-facing private interface |
| Remote agent | `127.0.0.1` unless explicitly exposed | Agent network interface with mTLS |
| Metrics | `127.0.0.1` | Monitoring network with TLS/mTLS |

Startup diagnostics should report every listener, scheme, binding address,
configured origin list, and whether enterprise policy accepts the exposure.

### API Gateway Integration

TORQUE should document and test reverse-proxy deployment behind nginx, Caddy,
Traefik, and cloud API gateways. The platform should expose:

- `GET /api/health`, `GET /api/ready`, and `GET /api/live`.
- `GET /api/openapi.json` for REST schema publication.
- WebSocket/SSE upgrade guidance and timeout requirements.
- Header forwarding requirements for `X-Forwarded-For`, `X-Forwarded-Proto`,
  request IDs, and authenticated identity headers.
- Example rate-limit policies by IP, API key, user, and namespace.

Gateway-authenticated deployments must still pass identity and scopes into
TORQUE in a signed or otherwise verifiable form. The gateway should not become
the only authorization boundary.

---

## Dependency Order

1. Keep Track A controls enforced and covered by regression tests.
2. Add a shared authorization policy layer and map every existing operation to a
   permission.
3. Add scoped API keys and RBAC, then migrate the legacy generated key to an
   admin-scoped compatibility key.
4. Add mandatory audit logging to the same policy/action layer.
5. Add project IDs and membership filtering to all resource queries and event
   streams.
6. Add user sessions, OIDC login, and JWT access tokens.
7. Add HMAC signing for service clients and mTLS for remote agents.
8. Add immutable audit verification, retention jobs, and secret rotation.
9. Add namespace quotas and provider/host isolation.
10. Enforce enterprise network policy with TLS, binding checks, and gateway
    deployment templates.

No later phase should introduce a second authorization path. New transports,
plugins, tools, dashboards, and automation APIs must use the same identity,
scope, RBAC, project, namespace, and audit helpers.

---

## Readiness Gates

An enterprise deployment should not be considered ready until these checks pass:

- Every authenticated request has a resolved actor and every mutation emits an
  audit event.
- Permission checks are centralized and covered by tests for REST, dashboard,
  MCP, SSE/HTTP transport, and remote-agent control paths.
- Project isolation tests prove cross-project reads, writes, event streams, and
  exports are denied.
- API keys, JWTs, HMAC keys, agent credentials, and provider secrets have
  rotation and revocation tests.
- Audit-chain verification detects modified, deleted, inserted, and reordered
  audit rows.
- Retention jobs preserve held records and emit purge evidence.
- TLS and binding startup checks fail closed in enterprise mode.
- Gateway examples are exercised in an integration harness or documented with a
  repeatable smoke test.
- Backward compatibility tests show the single-user local deployment remains
  usable without enabling enterprise features.

---

## Non-Goals for Track A

Track A ends with this documentation. It does not implement OAuth2/OIDC, JWT
sessions, scoped API keys, RBAC, project isolation, namespace tenancy, mTLS,
HMAC signing, immutable audit chains, retention jobs, gateway templates, or TLS
enforcement. Those should be planned as separate feature tracks with their own
tests and migration notes.
