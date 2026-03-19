# TORQUE Enterprise Security Roadmap

**Status:** Planning — not yet implemented
**Target audience:** Future development team evaluating enterprise deployment

---

## Current Security Model (v1 — Single User)

- Auto-generated API key, protocol-layer enforcement
- Localhost dashboard exemption
- Shared secret for remote agents (with TLS)
- SHA-256 backup integrity verification

The v1 model assumes a single trusted operator running TORQUE on a personal workstation. All security controls are designed around this constraint: the API key grants full access, the dashboard is exempt on localhost, and remote agents authenticate with a single shared secret. This is appropriate for solo development but does not scale to teams, cloud deployments, or regulated environments.

---

## Enterprise Authentication Upgrades

### Mutual TLS (mTLS) for Agents

In mTLS, both the server and each agent present X.509 certificates during the TLS handshake, so the connection is authenticated in both directions before any application-level payload is exchanged. Each registered agent would receive a unique client certificate issued by a TORQUE-managed CA (or an external CA for organizations that already run PKI infrastructure). The server pins the expected CA and rejects any connection whose client cert does not chain to it. Certificate rotation would be handled by a `/api/agents/{id}/rotate-cert` endpoint that issues a new cert with a configurable overlap window so the old cert remains valid until the agent acknowledges the new one. Revocation would be enforced via a CRL stored in the database and checked on each new connection; a lightweight OCSP responder endpoint (`/api/pki/ocsp`) could serve as an alternative for agents that support it.

**Effort:** Medium | **Priority:** High for enterprise

### HMAC Request Signing

Every outbound request from an agent or external caller would include three extra headers: `X-Torque-Timestamp` (Unix epoch, seconds), `X-Torque-Nonce` (random 128-bit hex), and `X-Torque-Signature` (HMAC-SHA256 of `method + path + body_sha256 + timestamp + nonce` keyed with the caller's secret). The server rejects requests whose timestamp falls outside a configurable replay window (default 60 seconds) and maintains a short-lived nonce cache (TTL = replay window) to detect replayed requests within the window. This provides integrity and replay protection without the complexity of full PKI, making it a natural bridge between the current shared-secret model and full mTLS. Key rotation follows the same overlap-window pattern as mTLS: a new key is issued, both keys are accepted during the grace period, and the old key is revoked after confirmation.

**Effort:** Low | **Priority:** Medium

### OAuth2 / OIDC Integration

TORQUE would act as an OAuth2 resource server and optionally as an OIDC relying party, delegating identity to an external provider (Okta, Azure AD, GitHub, Google Workspace, or any OIDC-compliant IdP). The authorization code flow would be used for human operators accessing the dashboard: the browser is redirected to the IdP, an authorization code is returned, and TORQUE exchanges it for an access token and ID token. The ID token's `sub` claim becomes the canonical user identity stored in the database. Refresh tokens would be stored server-side (not in the browser) and used to silently renew sessions. Configuration would live in the database under a `oidc_provider` table with fields for `issuer_url`, `client_id`, `client_secret`, `redirect_uri`, and `scopes`; a setup wizard in the dashboard would populate these from a `.well-known/openid-configuration` discovery endpoint.

**Effort:** High | **Priority:** High for enterprise

### JWT Session Tokens

After successful authentication (password, OIDC, or API key exchange), TORQUE issues a signed JWT containing the user's identity (`sub`), roles, granted scopes, and an expiry (`exp`). The token is signed with an RSA or ECDSA key whose public component is published at `/.well-known/jwks.json` so that downstream services (API gateway, external tooling) can verify tokens without calling back to TORQUE. Short-lived access tokens (15 minutes) are paired with longer-lived refresh tokens (7 days, stored in an `HttpOnly` cookie) to limit the blast radius of token leakage. A `jti` (JWT ID) claim and a server-side revocation table allow individual tokens to be invalidated before expiry — useful for logout and compromised-key scenarios. Scopes embedded in the JWT drive the RBAC layer so that permission checks are local (no DB lookup per request) for the common case.

**Effort:** Medium | **Priority:** Medium

---

## Authorization & Multi-Tenancy

### Granular API Key Scoping

Each API key record in the database would carry a `scopes` JSON column listing the operations the key may perform. Defined scopes would include `tasks:read`, `tasks:submit`, `tasks:cancel`, `workflows:read`, `workflows:manage`, `providers:read`, `providers:manage`, `admin:*`, and `metrics:read`. A read-only monitoring key can be issued with only `tasks:read` and `metrics:read`, so a CI dashboard or Grafana datasource can query TORQUE without the ability to submit or cancel anything. Key metadata (label, creator, last-used timestamp, expiry date, IP allowlist) would be stored alongside scopes so that operators can audit which keys are active and rotate stale ones. The key creation UI would present scopes as checkboxes grouped by resource type, preventing accidental over-provisioning.

**Effort:** Low | **Priority:** High

### Role-Based Access Control (RBAC)

Four built-in roles would cover the common deployment patterns: **Viewer** (read-only access to tasks, workflows, and metrics), **Submitter** (Viewer + submit tasks and workflows, cannot cancel others' work), **Operator** (Submitter + cancel any task, manage providers and hosts, view audit log), and **Admin** (full access including user management, key issuance, and system config). The permission matrix would be enforced in a middleware layer that reads the role from the JWT claim (or from the API key's associated role) before the request reaches the handler. Custom roles would be a stretch goal — organizations with unusual permission structures could define named role objects in the database and assign them the same way as built-in roles. Role assignment is an Admin-only operation and every assignment change is written to the audit log.

**Effort:** Medium | **Priority:** High for enterprise

### Project-Level Isolation

Each task and workflow record would gain a `project_id` foreign key. When a user submits a task, `project_id` is set to their default project (configurable per user). All list/read endpoints would filter by the calling user's project memberships so that a user in Project A cannot enumerate or interact with tasks in Project B. Project membership would be stored in a `project_members` join table with a per-member role (inheriting from the global RBAC roles but scoped to the project). Cross-project restrictions would be enforced at the query layer, not just the API layer, to prevent accidental data leakage through aggregate endpoints like `GET /api/stats`. Admins retain global visibility across all projects; Operators see all projects they are a member of.

**Effort:** Medium | **Priority:** High for enterprise

### Namespace Multi-Tenancy

Namespaces extend project isolation to the infrastructure level: each namespace gets its own pool of allowed providers, a cap on concurrent tasks, and a quota on total compute hours per billing period. A `namespaces` table would hold the quota configuration; the scheduler would check namespace capacity before placing a task, just as it checks per-host capacity today. Provider access lists per namespace prevent one team from consuming expensive cloud API providers allocated to another team. Resource quota enforcement would emit a `namespace.quota_exceeded` audit event and return a `429 Too Many Requests` with a `Retry-After` header so callers can back off gracefully. Namespace dashboards would display utilization against quota in real time, giving namespace admins visibility without granting them access to other namespaces.

**Effort:** High | **Priority:** Medium

---

## Audit & Compliance

### Mandatory Audit Logging

Every state transition (task submitted, started, completed, cancelled, failed), configuration change (provider enabled/disabled, host added, key issued), and authentication event (login, logout, failed auth, token refresh) would be written to an `audit_log` table before the corresponding database mutation commits. Each row records: `event_type`, `actor_id` (user or key ID), `actor_ip`, `resource_type`, `resource_id`, `before_state` (JSON), `after_state` (JSON), and `created_at` (UTC, microsecond precision). The audit log is write-only from the application layer — no handler can delete or update audit rows, only insert. A `GET /api/audit` endpoint with filtering by actor, resource type, time range, and event type allows operators to query the log without direct database access.

### Immutable Audit Trail

To detect tampering, each audit row would include a `chain_hash` column: SHA-256 of `(previous_chain_hash || event_type || actor_id || resource_id || created_at || before_state || after_state)`. The genesis row uses a fixed sentinel as the previous hash. Any gap, reorder, or modification of a row breaks the chain, which can be detected by a `GET /api/audit/verify` endpoint that replays the hash chain and reports the first invalid row. For regulated environments requiring off-system evidence, an export endpoint would produce a signed NDJSON file (one JSON object per line) with the chain hashes embedded, suitable for submission to a SIEM or long-term compliance archive. The verification endpoint itself is accessible to Admins and Auditor-role users only.

### Data Retention Policies

Each namespace or project would have a configurable retention policy specifying how long task records, audit logs, and output blobs are kept before auto-purge. Default retention is 90 days for task records and 365 days for audit logs; these can be extended or shortened per namespace. A scheduled background job (running nightly) would apply the policy: soft-deleting expired task records first, then hard-deleting after a secondary grace period, ensuring that any in-flight references are resolved before physical deletion. Legal hold would be implemented as a boolean flag on the namespace or on individual task records — held records are skipped by the purge job regardless of age. Data export (`GET /api/export?namespace=X&from=...&to=...`) would produce a ZIP containing all task records, audit logs, and output blobs for the specified range, enabling teams to archive data before a retention cutoff.

### Secret Rotation

API keys, mTLS CA keys, JWT signing keys, and HMAC secrets would all participate in a unified rotation lifecycle managed by a `secret_versions` table. Each secret has a current version and optionally a previous version; both are accepted during the overlap window (configurable, default 24 hours). A `POST /api/admin/rotate/{secret_type}` endpoint triggers rotation: generates a new secret, sets the overlap window, and schedules expiry of the old version. Agents and integrations that fail to update within the overlap window receive a `401` with a `X-Torque-Key-Expired` header to distinguish key expiry from invalid credentials. Automated rotation can be enabled on a schedule (e.g., every 90 days) with notifications sent via webhook or email to registered admins before the rotation fires.

---

## Network Security

### TLS Everywhere

All four TORQUE ports (dashboard :3456, REST API :3457, MCP SSE :3458, GPU metrics :9394) would be served over TLS by default in enterprise mode. Plain HTTP would be disabled at the listener level — not just redirected — so that no sensitive data can travel unencrypted even due to misconfiguration. Certificate provisioning would support three modes: ACME/Let's Encrypt auto-renewal (for internet-facing deployments), manual PEM import (for internal PKI), and self-signed bootstrap (for airgapped environments, with a prominent warning in the dashboard). WebSocket connections (MCP SSE transport) would automatically upgrade to WSS. The GPU metrics endpoint, currently plain HTTP for Prometheus scraping, would support mutual TLS so that only authorized Prometheus instances can scrape it.

### Interface Binding

Each TORQUE port would be independently configurable to bind to a specific network interface rather than `0.0.0.0`. For example, the dashboard could bind to `127.0.0.1` (accessible only via SSH tunnel or local browser) while the MCP SSE port binds to a specific LAN interface for agent connectivity. Binding configuration would live in the database under per-port settings, editable via the dashboard or `set_port_binding` MCP tool. A startup check would warn if any port is bound to `0.0.0.0` without TLS enabled, treating this as a misconfiguration rather than a supported state. Port-level firewall documentation would be included in the deployment guide, noting which ports require LAN vs. loopback-only exposure in typical single-operator, team, and cloud-hosted deployments.

### API Gateway Integration

TORQUE would publish health and readiness endpoints (`GET /api/health`, `GET /api/ready`) conforming to standard gateway expectations so that nginx, Caddy, Traefik, or any L7 proxy can perform health checks without additional configuration. Rate limiting at the gateway level would be documented with example configs for each supported proxy: per-IP limits for the dashboard, per-key limits for the REST API (using the `X-Torque-Key` header as the rate-limit partition key), and per-connection limits for the SSE endpoint. A `GET /api/openapi.json` endpoint would serve a full OpenAPI 3.1 spec so that gateway tooling (Kong, AWS API Gateway, Azure APIM) can auto-generate route configuration and schema validation rules. The documentation would include a recommended nginx reverse-proxy config that handles TLS termination, header forwarding (`X-Forwarded-For`, `X-Real-IP`), and WebSocket upgrade for the SSE port.

---

## Implementation Priority Matrix

| Feature | Effort | Impact | Priority |
|---------|--------|--------|----------|
| Granular API key scoping | Low | High | P1 |
| mTLS for agents | Medium | High | P1 |
| RBAC | Medium | High | P1 |
| Mandatory audit logging | Medium | High | P1 |
| OAuth2/OIDC | High | High | P2 |
| Project isolation | Medium | High | P2 |
| HMAC request signing | Low | Medium | P2 |
| JWT sessions | Medium | Medium | P2 |
| Immutable audit trail | Medium | Medium | P3 |
| Secret rotation | Medium | Medium | P3 |
| Namespace multi-tenancy | High | Medium | P3 |
| TLS everywhere | Low | Medium | P3 |

---

## Migration Path from v1

The transition from the single-user v1 model to enterprise features must be non-breaking for existing installations. The recommended migration sequence is:

1. **P1 features first** — granular key scoping, mandatory audit logging, and RBAC can be introduced with the existing single API key mapped to an `admin` role. No client changes required.
2. **OAuth2/OIDC as opt-in** — the IdP integration is activated only when `oidc_provider` config is present. Installations without OIDC config continue to use API key auth unchanged.
3. **mTLS as opt-in per agent** — the existing shared-secret agent auth remains valid; mTLS is offered as an upgrade per registered agent, not a forced cutover.
4. **Project isolation behind a feature flag** — single-user installations set `multi_project: false` (the default) and see no change; teams enable it explicitly and choose a migration date for existing tasks.
5. **Namespace multi-tenancy last** — this requires the most schema migration and is only needed for shared cloud deployments. It builds on all prior P1-P3 features.

Each P1 feature should ship independently behind the `enterprise` feature flag so that the community edition remains unchanged and enterprise features can be enabled incrementally without a big-bang cutover.
