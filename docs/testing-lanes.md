# TORQUE Test Lanes

Use test lanes when running TORQUE tests concurrently from multiple agents or shells.
Each lane gets its own data directory, temp directory, Vitest template DB, worker
root, coverage output, Playwright output, cache directory, and port block.

## Commands

```powershell
scripts/test-lane.ps1 -Lane 1 -Preset server-smoke
scripts/test-lane.ps1 -Lane 2 -Preset server-file -File server/tests/task-operations.test.js
scripts/test-lane.ps1 -Lane 3 -Preset dashboard-unit
scripts/test-lane.ps1 -Lane 4 -Preset dashboard-e2e
scripts/test-lane.ps1 -Lane auto -Preset server-smoke
scripts/test-lane.ps1 -Lane 2 -Command "cd server; npx vitest run tests/api-server.test.js"
```

Use `-Lane auto` for factory-style runs; it picks the first free lane and exits
only when all lanes are owned by live processes. Explicit lanes still exit
immediately if another live process owns that lane lock. Stale locks whose PID
is no longer alive are reclaimed automatically.

## Lane Map

| Lane | Dashboard | API | MCP | GPU metrics | Vite |
|------|-----------|-----|-----|-------------|------|
| 1 | 3456 | 3457 | 3458 | 9394 | 5173 |
| 2 | 3556 | 3557 | 3558 | 9494 | 5273 |
| 3 | 3656 | 3657 | 3658 | 9594 | 5373 |
| 4 | 3756 | 3757 | 3758 | 9694 | 5473 |

The default lane root is `C:\tmp\torque-test-lanes` on Windows and
`<os.tmpdir()>/torque-test-lanes` elsewhere. Override it with
`TORQUE_TEST_LANE_ROOT` or `-LaneRoot`.

## Environment Contract

`scripts/test-lane.ps1` sets:

- `TORQUE_TEST_LANE`
- `TORQUE_TEST_LANE_ROOT`
- `TORQUE_TEST_LANE_DIR`
- `TORQUE_DATA_DIR`
- `TORQUE_TEST_SANDBOX`
- `TORQUE_TEST_SANDBOX_DIR`
- `TORQUE_VITEST_TEMPLATE_DIR`
- `TORQUE_VITEST_WORKER_ROOT`
- `TORQUE_DASHBOARD_PORT`
- `TORQUE_API_PORT`
- `TORQUE_MCP_SSE_PORT`
- `TORQUE_GPU_METRICS_PORT`
- `TORQUE_DASHBOARD_DEV_PORT`
- `TORQUE_DASHBOARD_PROXY_TARGET`
- `TORQUE_VITEST_COVERAGE_DIR`
- `PLAYWRIGHT_OUTPUT_DIR`
- `TMP`, `TEMP`, and `TMPDIR`

Running tests without the launcher keeps the existing defaults.

## Factory Verification

When the TORQUE factory verifies a project that contains `scripts/test-lane.js`,
raw verify commands are wrapped as:

```powershell
node scripts/test-lane.js --lane auto --command-base64 <encoded-command>
```

The encoded command is decoded by the launcher after a lane lock is acquired,
so existing project and work-item `verify_command` values keep their behavior
while gaining lane isolation.

## Dashboard E2E

The `dashboard-e2e` preset starts Vite on the lane's Vite port and points the
dashboard proxy at the lane's dashboard API port. Playwright disables dev-server
reuse for lane runs, serializes lane E2E workers to avoid mock API port
contention, and sets `VITE_TORQUE_E2E_AUTH_BYPASS=1` for its Vite child process.
