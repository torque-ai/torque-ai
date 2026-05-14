# Ephemeral-Port Migration (test port isolation)

Foundation for safe N-way gate sharding on a single workstation. Tests
that bind to fixed ports (e.g. `port: 4999`) collide when run by parallel
shards on the same machine — the standard fix is `port: 0` (kernel
assigns) + read the assigned port back from `server.address().port`.

## Why this exists

`TORQUE_GATE_SHARDS=4` was shipped as an opt-in flag for vitest fan-out
on the pre-push gate. The Linux remote run failed because parallel shards
each ran tests that bind to the same hardcoded ports (4999 MCP gateway,
4582 dashboard, 4411 API server, etc.). Cross-lane workspace isolation
doesn't help because all lanes share the same machine's port space.

## Migration pattern — option (a), explicit

Each migrated test reads the kernel-assigned port back from the start
result:

```js
// Before:
await api.start({ port: 4411 });
const res = await fetch('http://127.0.0.1:4411/foo');

// After:
const { port } = await api.start({ port: 0 });
const res = await fetch(`http://127.0.0.1:${port}/foo`);
```

The `port: 0` signal tells the kernel to assign any free ephemeral port.
The start function's resolved object reports the actual assigned port.
The test uses that captured port for any subsequent URL or assertion.

No helper wrapper — each test is explicit and grep-friendly.

## Server-side prerequisites

Every TORQUE component's `start()` must:

1. Accept `port: 0` from `options`
2. Pass `0` through to `server.listen(0, host, callback)`
3. In the listen callback, read `server.address().port` to get the
   kernel-assigned port
4. Return that actual port in the resolved result (not the 0 placeholder)
5. Sync any module-scoped port variable so `stop()` and re-entrant
   `start()` checks reference the real port

### Migration status

| Component | File | Status |
|---|---|---|
| API server | `server/api-server.js` | ✅ Migrated 2026-05-14 |
| Dashboard server | `server/dashboard/server.js` | ⏳ Pending — has auto-increment loop, needs special handling for `port: 0` |
| MCP gateway | `server/mcp/index.js` | ⏳ Pending |
| MCP SSE | `server/mcp/sse.js` | ⏳ Pending |
| Coord daemon | `server/coord/index.js` | ✅ Already uses `server.listen(config.port, ...)` — works with port: 0 |
| Peek server | `server/plugins/snapscope/peek-server.js` | ⏳ Check if applicable |
| Test stubs / mocks | Various | ⏳ Many mock `http.createServer` so don't actually bind — keep their fixed ports as decorative |

### Dashboard-server special case

`server/dashboard/server.js` has a port-availability check + auto-increment
loop (tries `basePort + 0..4`). For `port: 0` to mean ephemeral:

```js
// Sketch:
if (options.port === 0) {
  // Skip auto-increment loop; defer to kernel
  foundPort = 0;
} else {
  // existing auto-increment logic
}

// Then in the listen callback:
const address = httpServer.address();
serverPort = (address && typeof address.port === 'number') ? address.port : foundPort;
```

## Test migration

### Survey

29+ test files mention `port: <4-digit>`. Many are decorative (server
is mocked via `vi.spyOn(http, 'createServer')`). Only tests that actually
bind via real `http.createServer` need migration:

- `server/tests/api-server-core.test.js` — partially mocked
- `server/tests/api-server.test.js` — mocked
- `server/tests/dashboard-server.test.js` — has real bindings
- `server/tests/mcp-index.test.js` — mocked
- `server/tests/scripts-functional.test.js` — exercises real start scripts
- `server/tests/script-smoke.test.js` — exercises real start scripts
- `server/tests/integration-infra.test.js` — likely real
- `server/tests/dashboard-server-static.test.js` — real
- `server/tests/dashboard-routes-advanced.test.js` — real

### Step-by-step for each file

1. Search the file for `port: <number>` literals
2. Identify which lines bind a server vs. which are decorative
3. For real bindings:
   - Change to `port: 0`
   - Capture the returned `{ port }` (or read `.address().port` on the
     server object if the test holds a reference)
   - Find any `localhost:NNNN` / `127.0.0.1:NNNN` strings nearby that
     reference the same port and substitute the captured value
4. Run the file alone first: `npx vitest run path/to/file.test.js`
5. Run with `TORQUE_GATE_SHARDS=4` once a few files are migrated, to
   confirm no inter-shard collisions remain

### Mocked tests — leave alone (or normalize for documentation)

Tests that mock `http.createServer` never actually listen, so any port
literal is just a label. They don't cause shard collisions. Optional:
normalize their port literal to `0` to match the migrated style, but
not required.

## Validation gate

After every batch of migrations:

1. Run the migrated files alone on the remote: `torque-remote bash -c
   'cd server && npx vitest run <files>'`
2. Run with sharding to surface collisions: `TORQUE_GATE_SHARDS=4 git
   push origin main` (against an empty validation commit)
3. If a port collision surfaces, identify the unmigrated test and
   migrate it; otherwise the batch is good.

## When this is done

Once every real-binding test uses port 0, flip `TORQUE_GATE_SHARDS`
default from `1` to `4` so every gate run is sharded. Wall-clock should
drop by roughly N× for the server suite.
