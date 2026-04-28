#!/usr/bin/env bash
# Pretty-print codegraph telemetry from a running TORQUE instance.
#
# Usage:
#   scripts/cg-telemetry-report.sh             # last 168 h (one week)
#   scripts/cg-telemetry-report.sh 24          # last 24 h
#   scripts/cg-telemetry-report.sh 720         # last 30 d
#
# Reads from $TORQUE_API_BASE (default: http://127.0.0.1:3457). Exits non-zero
# when TORQUE isn't reachable so cron / CI consumers see a clear failure.

set -euo pipefail

HOURS="${1:-168}"
ENDPOINT="${TORQUE_API_BASE:-http://127.0.0.1:3457}/api/v2/codegraph/telemetry?since_hours=${HOURS}"

if ! command -v curl >/dev/null 2>&1; then
  echo "[cg-telemetry] curl not found in PATH" >&2
  exit 2
fi

RESP="$(curl -fsS --max-time 10 "$ENDPOINT" 2>&1)" || {
  echo "[cg-telemetry] failed to reach TORQUE at ${ENDPOINT}" >&2
  echo "[cg-telemetry] (is the server up? livez at ${TORQUE_API_BASE:-http://127.0.0.1:3457}/livez)" >&2
  exit 1
}

# Prefer node since TORQUE always ships it; fall back to python; finally raw.
if command -v node >/dev/null 2>&1; then
  printf '%s' "$RESP" | node -e '
    let buf = "";
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => {
      let d;
      try { d = JSON.parse(buf); } catch { console.log(buf); return; }
      const r = (d && (d.data || d)) || {};
      const tools = Array.isArray(r.tools) ? r.tools : [];
      const since = r.since_hours || "?";
      console.log(`Codegraph telemetry — last ${since}h, total_calls=${r.total_calls || 0}\n`);
      if (tools.length === 0) {
        console.log("(no recorded calls in window — either nothing called the cg_* tools, or telemetry is unavailable)");
        return;
      }
      const w = (s, n) => String(s == null ? "" : s).padEnd(n);
      const wr = (s, n) => String(s == null ? "" : s).padStart(n);
      console.log(w("tool", 28) + wr("calls", 6) + wr("avg_ms", 9) + wr("max_ms", 8) + wr("strict%", 9) + wr("trunc%", 8) + wr("stale%", 8) + wr("err%", 6));
      console.log("─".repeat(82));
      for (const t of tools) {
        console.log(
          w(t.tool, 28) +
          wr(t.calls, 6) +
          wr(t.avg_duration_ms ?? "-", 9) +
          wr(t.max_duration_ms ?? "-", 8) +
          wr(t.strict_pct == null ? "-" : t.strict_pct, 9) +
          wr(t.truncation_pct ?? 0, 8) +
          wr(t.staleness_pct ?? 0, 8) +
          wr(t.error_pct ?? 0, 6),
        );
      }
      console.log("\nSee docs/codegraph-telemetry-runbook.md for what each percentage means and which to act on.");
    });
  '
elif command -v python3 >/dev/null 2>&1; then
  printf '%s' "$RESP" | python3 -m json.tool
else
  printf '%s\n' "$RESP"
fi
