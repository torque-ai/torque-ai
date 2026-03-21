# MCP SSE Transport Auth Gap

## Summary

TORQUE's REST API can authenticate with request headers such as `Authorization: Bearer <api-key>`, but browser-based `EventSource` clients cannot attach custom headers to the initial `GET /sse` request. That creates an auth gap for the MCP SSE transport: the clean header-based API key flow works for REST, but not for browser SSE.

Today, the SSE transport in `server/mcp-sse.js` authenticates the stream at connection time using `ticket`, `apiKey`, or open mode. That means browser clients either need to put a credential in the URL, use cookies, or move authentication into protocol messages. The safest low-friction path is to keep SSE and use short-lived session tickets minted over REST, then passed in the SSE URL.

## Problem

The root issue is the browser `EventSource` API:

- `EventSource` does not expose a `headers` option.
- Browser code therefore cannot send `Authorization`, `X-API-Key`, or `X-Torque-Key` on `GET /sse`.
- The auth decision for TORQUE SSE happens before any MCP tool call, at stream establishment time.

That is a transport mismatch, not an MCP protocol bug. The REST side can receive credentials in headers. The browser SSE side cannot.

In practice, this leads to three common workarounds:

| Workaround | Status in TORQUE | Main issue |
| --- | --- | --- |
| Raw credential in URL such as `?apiKey=torque_sk_...` | Implemented for SSE today | Leaks long-lived secret into URLs, logs, browser history, and diagnostics |
| Cookie-based auth | Possible in principle because TORQUE already has session cookies for the dashboard | Requires session bootstrap, CSRF rules, and cookie scope decisions for SSE clients |
| First-message auth | Not implemented | Requires opening unauthenticated SSE sessions and adding extra protocol state before tools are allowed |

## Current State

| Surface | Current auth carrier | Browser-friendly? | Notes |
| --- | --- | --- | --- |
| REST `/api/*` | `Authorization: Bearer`, legacy `X-Torque-Key`, or `torque_session` cookie | Yes | Standard HTTP clients can attach headers or cookies |
| `POST /api/auth/ticket` | `Authorization: Bearer <api-key>` | Yes | Existing REST bootstrap for short-lived SSE tickets |
| `GET /sse` | `ticket` query, `apiKey` query, legacy `x-torque-key` header, or open mode | Only via query parameter | Browser `EventSource` cannot send auth headers |
| `POST /messages?sessionId=...` | Session state established during `GET /sse` | Yes | Not the primary auth gap |

### REST auth

The REST side already has normal HTTP auth paths:

- `server/auth/middleware.js` accepts `Authorization: Bearer <api-key>`.
- The same middleware also accepts the legacy `X-Torque-Key` header.
- It can also resolve a `torque_session` cookie for dashboard-style session auth.
- `POST /api/auth/ticket` already exists and validates a bearer API key before minting a short-lived ticket.

For REST clients, this is straightforward because `fetch`, `curl`, and SDK HTTP clients can all attach headers.

### SSE auth

The SSE side works differently:

- `GET /sse` authenticates the session when the stream is opened.
- In `server/mcp-sse.js`, the current lookup order is `ticket` first, then `apiKey` query parameter or `x-torque-key` header, then open mode.
- `POST /messages?sessionId=...` does not independently re-authenticate with a header. It relies on `session.authenticated`, which was established during `GET /sse`.
- If a session is not authenticated, later `tools/call` requests are rejected.

That means the browser problem is specifically the initial SSE handshake. The POST side is not blocked by `EventSource`; the handshake is.

### Where the gap shows up

From a browser:

- A `fetch()` call can send `Authorization: Bearer ...` to REST routes such as `/api/auth/ticket`.
- A browser `EventSource` cannot send that same header to `/sse`.

So the browser-safe flow is currently split across two paths:

1. Use REST to authenticate.
2. Use SSE to stream.

The codebase already contains pieces of that split flow, but the most obvious SSE guidance still points at raw `?apiKey=...`, which keeps the insecure workaround alive.

## Design Goals

Any solution should preserve the following:

- Browser compatibility for the SSE stream bootstrap.
- Backward compatibility for existing non-browser MCP SSE clients.
- No long-lived API keys in URLs.
- Minimal changes to the existing `/sse` plus `/messages?sessionId=...` transport model.
- Clear reconnect behavior, since SSE clients reconnect automatically.

## Proposed Solutions

| Option | How it works | Pros | Cons |
| --- | --- | --- | --- |
| A. Short-lived session token in URL | Client uses REST with header auth to mint a short-lived token, then opens `GET /sse?ticket=...` | Smallest change, works with browser `EventSource`, keeps current SSE transport, backward-compatible, already partially implemented | Token still appears in URL, reconnect flow must mint a new token, requires ticket TTL/single-use policy and URL redaction |
| B. WebSocket transport | Replace or supplement SSE with WebSocket and authenticate during WebSocket upgrade | Native bidirectional transport, better fit for request/response plus server push, headers or subprotocol auth patterns are common | Highest implementation cost, requires new transport support, proxy/load-balancer changes, client changes, and separate operational surface |
| C. Fetch-driven SSE over HTTP/2 | Replace `EventSource` with a custom streaming client built on `fetch()` so headers can be sent | Allows header-based auth, stays on HTTP semantics, can keep text-event-stream framing | More client complexity, requires a custom SSE parser, more infrastructure assumptions, and is a larger transport redesign than a ticket exchange |

## Recommendation

Use short-lived session tokens for the SSE URL and make that the primary browser-auth pattern.

This is the best fit for TORQUE because:

- It preserves the existing `/sse` and `/messages` transport shape.
- It avoids putting long-lived API keys in the URL.
- It is backward-compatible with current clients that already know how to talk to the SSE transport.
- TORQUE already has the core pieces: `POST /api/auth/ticket` and `ticket` handling in `GET /sse`.

This is not perfect. A ticket in the URL can still show up in access logs or browser diagnostics. The difference is blast radius:

- the ticket is short-lived;
- the ticket is single-use;
- the long-lived API key stays in the header-authenticated REST call, not in the SSE URL.

That is a meaningful security improvement without requiring a transport rewrite.

## Implementation Sketch

The recommended path is to formalize the ticket flow that already exists and make raw `?apiKey=` a legacy fallback for non-browser clients.

### 1. Make ticket exchange the documented browser bootstrap

Document the browser flow as:

1. Call `POST /api/auth/ticket` with `Authorization: Bearer <api-key>`.
2. Receive `{ ticket, expiresInMs, singleUse }`.
3. Open `EventSource("/sse?ticket=...")`.
4. Read the `endpoint` event to learn the `POST /messages?sessionId=...` URL.
5. Send MCP JSON-RPC requests to that endpoint.

Example browser bootstrap:

    async function openTorqueMcpSse(baseUrl, apiKey) {
      const ticketRes = await fetch(`${baseUrl}/api/auth/ticket`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!ticketRes.ok) {
        throw new Error(`Ticket exchange failed: ${ticketRes.status}`);
      }

      const { ticket } = await ticketRes.json();
      const es = new EventSource(`${baseUrl}/sse?ticket=${encodeURIComponent(ticket)}`);

      return await new Promise((resolve, reject) => {
        es.addEventListener('endpoint', (event) => {
          resolve({
            es,
            messagesPath: event.data,
          });
        });

        es.onerror = () => reject(new Error('SSE connection failed'));
      });
    }

### 2. Treat raw `apiKey` query auth as deprecated, not primary

Keep `?apiKey=` working for backward compatibility, but change the docs and error messages so the preferred guidance is the ticket flow.

Recommended messaging:

    Authentication required.
    Browser SSE clients should:
      1. POST /api/auth/ticket with Authorization: Bearer <api-key>
      2. connect to /sse?ticket=<short-lived-ticket>

That closes the documentation gap even before any code behavior changes.

### 3. Be explicit about reconnect behavior

This is the main operational nuance.

`EventSource` reconnects automatically, but a short-lived single-use ticket cannot be reused forever. The client therefore needs a reconnect wrapper that mints a fresh ticket before opening a new stream.

Recommended client pattern:

    async function connectWithRefresh(baseUrl, apiKey) {
      let current = await openTorqueMcpSse(baseUrl, apiKey);

      current.es.addEventListener('error', async () => {
        try {
          current.es.close();
          current = await openTorqueMcpSse(baseUrl, apiKey);
        } catch (err) {
          console.error('Reconnect failed', err);
        }
      });

      return current;
    }

If TORQUE wants to keep native `EventSource` auto-retry without a wrapper, the ticket policy would need to be relaxed from single-use to short-lived multi-use, or the server would need a session reattach rule that preserves auth for a still-live session. That is possible, but it is a separate design choice and not required for the minimal fix.

### 4. Return explicit ticket metadata

The existing ticket route can stay structurally simple, but the response should make lifecycle expectations obvious:

    {
      "ticket": "uuid",
      "expiresInMs": 30000,
      "singleUse": true
    }

That helps browser clients implement reconnect and retry behavior correctly.

### 5. Redact query credentials in logs

Even with short-lived tickets, URLs should be treated as sensitive.

Recommended safeguards:

- redact `ticket=` values in application logs;
- avoid logging full query strings for `/sse`;
- ensure reverse proxies do not retain raw query parameters longer than necessary.

This is especially important because the whole point of the design is reducing URL credential exposure compared with raw `?apiKey=...`.

### 6. Keep the server-side auth flow simple

The server-side control flow for the recommended design remains close to what TORQUE already does:

    POST /api/auth/ticket
      validate Authorization: Bearer <api-key>
      create short-lived ticket
      return ticket metadata

    GET /sse?ticket=<ticket>
      consume ticket
      create authenticated SSE session
      send endpoint event

    POST /messages?sessionId=<id>
      trust session.authenticated from SSE bootstrap
      process MCP request

This is why the approach is attractive: it fixes the browser auth gap without replacing the transport.

## Why the Other Options Are Not the Default

### WebSocket transport

WebSocket is the cleanest long-term bidirectional transport, but it is not the smallest change. It would require:

- a new server transport alongside stdio and SSE;
- new auth and reconnect semantics;
- new proxy and deployment guidance;
- client updates everywhere that currently assume the MCP SSE shape.

That is reasonable if TORQUE wants a broader transport upgrade, but it is disproportionate for this specific auth gap.

### Fetch-driven SSE over HTTP/2

This path removes the `EventSource` header limitation by replacing `EventSource` with a custom client. That can work, but it changes the client contract more than a ticket exchange does:

- the browser must parse `text/event-stream` manually;
- buffering and stream behavior become the client's responsibility;
- deployment assumptions become more important.

It is a valid future direction, but not the lowest-risk fix.

## Conclusion

The auth gap is real, but it is narrow: browser `EventSource` cannot carry header-based API key auth for `GET /sse`.

TORQUE should solve that gap by promoting short-lived SSE bootstrap tickets to the default browser flow:

- authenticate over REST with headers;
- mint a short-lived ticket;
- connect to `/sse?ticket=...`;
- treat raw `?apiKey=` as legacy compatibility only.

That gives browser clients a secure-enough path, keeps the current transport intact, and avoids a larger protocol migration unless TORQUE later decides it wants WebSocket or fetch-based streaming for broader reasons.
