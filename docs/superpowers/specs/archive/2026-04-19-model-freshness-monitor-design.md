# Model Freshness Monitor — Design

## Goal

Notify the user when a locally-pulled Ollama model has a newer build available on the
official Ollama registry. Prevents silent drift where a user keeps running `qwen3-coder:30b`
for months after a better-quantized or retrained version of the same tag has shipped.

Explicit scope: **digest-drift on locally-pulled `family:tag` pairs**. No net-new family
discovery, no leaderboard integration, no automatic pulling. Net-new models are discovered
by the user running `ollama launch claude` interactively or visiting ollama.com when they
want to try something new — this monitor's job is to catch drift in what they already use.

## Why Path A over web scraping

An earlier design sketch proposed scraping `ollama.com/library/<family>/tags` and polling
leaderboards (Aider, livebench). Rejected because:
- ollama.com has no documented public catalog API. HTML parsing is fragile.
- Leaderboards are useful signals but orthogonal to "is my qwen3-coder:30b stale?" —
  they answer "should I try a different model?", which is a human decision.
- Digest-drift is the 80/20 — it answers the question that actually bites.

## Mechanism

Ollama's registry speaks OCI v2 (Docker-compatible). A `HEAD` against
`https://registry.ollama.ai/v2/library/<family>/manifests/<tag>` returns an
`ollama-content-digest` header containing the manifest digest. Example (verified live):

```
HEAD /v2/library/qwen3-coder/manifests/30b
→ 200 OK
  ollama-content-digest: 06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca
```

That digest matches the `digest` field returned by `/api/tags` on the local Ollama host for
the same model. A monitor run is just: for each watched `family:tag`, fetch the remote
digest, compare to the local digest, emit an event if they differ.

No body download, no parsing — headers only. Cloudflare caches the endpoint, so cost is
negligible even at daily cadence across dozens of families.

## Plugin placement

New plugin at `server/plugins/model-freshness/` — follows precedent of `version-control`,
`remote-agents`, `snapscope`. Loaded via `DEFAULT_PLUGIN_NAMES` in `server/index.js`. Can be
disabled by removing the name from that list.

Contract:
- `install()` — creates the two DB tables (see below), seeds the watchlist from
  `list_ollama_hosts`, registers scheduled scan via `schedule_task`.
- `uninstall()` — cancels the scheduled scan, drops the tables.
- `mcpTools` — five new tools (see below).
- `eventHandlers` — listens to `ollama_host_added` / `ollama_host_removed` so new hosts
  contribute their models to the watchlist automatically.

## Storage — two tables

```sql
CREATE TABLE model_watchlist (
  id INTEGER PRIMARY KEY,
  family TEXT NOT NULL,        -- e.g. "qwen3-coder"
  tag TEXT NOT NULL,           -- e.g. "30b"
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,        -- "auto-seed" | "user" | "leaderboard" (reserved for future)
  added_at TEXT NOT NULL,
  last_local_digest TEXT,      -- snapshot of local digest at add/last-match time
  last_scanned_at TEXT,
  UNIQUE(family, tag)
);

CREATE TABLE model_freshness_events (
  id INTEGER PRIMARY KEY,
  family TEXT NOT NULL,
  tag TEXT NOT NULL,
  old_digest TEXT,
  new_digest TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT
);
```

No leaderboard or registry-cache table — Path A doesn't need them. If a future iteration
adds family discovery, that's a separate migration.

## Auto-seed

On first plugin `install()` and on each `ollama_host_added` event:

1. For each host returned by `list_ollama_hosts`, call `/api/tags`.
2. For each returned model, split on `:` → `(family, tag)`.
3. Skip `*-cloud` tags (the monitor only tracks registry-reachable local models).
4. Upsert into `model_watchlist` with `source = "auto-seed"` if no row exists for the pair.

This gives zero-config operation: install the plugin, the user's existing models are tracked.

## Scheduled scan

Daily, at 03:00 local time by default. Implementation uses TORQUE's existing
`schedule_task` infrastructure — the plugin installs a scheduled task on first load rather
than spawning its own cron.

Scan flow:

```
for each active row in model_watchlist:
  local_digest = query each ollama host's /api/tags; find matching name:tag
  if no host has this model → mark row inactive, continue
  remote_digest = HEAD registry.ollama.ai/v2/library/<family>/manifests/<tag> →
      read `ollama-content-digest` header
  if remote_digest differs from local_digest:
    insert into model_freshness_events (family, tag, old_digest=local, new_digest=remote)
    emit notification via check_notifications queue
  update last_scanned_at
  sleep 500ms  (polite to registry.ollama.ai)
```

Errors:
- Registry 5xx or network failure → log warning, leave row untouched, retry next day.
- Registry 404 (model removed from registry) → mark row with a `registry_missing` event
  (one-time) so the user can investigate.
- Host unreachable → skip, don't generate false drift events.

Manual trigger: `model_freshness_scan_now` MCP tool bypasses the schedule and runs the loop
immediately. Returns the list of events created during that run.

## MCP tools (five)

| Tool | Purpose |
|---|---|
| `model_watchlist_list` | Return all active rows with last-scan metadata |
| `model_watchlist_add { family, tag }` | Insert a user-curated row (`source = "user"`) |
| `model_watchlist_remove { family, tag }` | Mark row `active = 0` (soft-delete; preserves history) |
| `model_freshness_scan_now` | Run the scan synchronously; return new events |
| `model_freshness_events { include_acknowledged? }` | List pending events; default excludes acked |

All five register in `server/tool-annotations.js` per
`feedback_centralized_tool_annotations.md`.

## Notification shape

Each detected drift emits:

```json
{
  "type": "model_drift",
  "family": "qwen3-coder",
  "tag": "30b",
  "old_digest": "06c10...",
  "new_digest": "a3f22...",
  "detected_at": "2026-04-20T03:00:12Z",
  "suggestion": "Run `ollama pull qwen3-coder:30b` to update on BahumutsOmen"
}
```

Delivered via:
- `check_notifications` queue (already consumed by Claude Code sessions)
- Dashboard "Model Updates" panel (new section under Operations)
- Optionally: desktop push via existing TORQUE notification infrastructure if the user has
  enabled it (no new wiring needed; freshness events use the existing notifier)

Notify-only. No auto-pull. Ever. The user decides when to upgrade a model.

## Non-goals

- **No auto-pull** — even with user opt-in. 18 GB downloads don't happen without a
  deliberate `ollama pull` from the user. This is a hard constraint, not a configuration.
- **No new-family discovery** — if the user wants to try a model they don't have, they
  run `ollama launch claude` (interactive menu shows the catalog) or visit ollama.com.
- **No benchmark running** — the monitor trusts the registry's digest as the "newer build
  shipped" signal; it does not evaluate whether the new build is actually better.
- **No cloud-tag tracking** — `*-cloud` variants are managed by `ollama-cloud` which hits
  `api.ollama.com`; the registry endpoint doesn't serve them.
- **No cross-host version reconciliation** — if two hosts have different digests for the
  same tag, both rows exist; events reflect each host separately. A merge policy can be
  added later if multi-host setups become common.
