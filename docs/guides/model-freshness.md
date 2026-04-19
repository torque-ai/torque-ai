# Model Freshness Monitor

Ollama model tags roll over silently — `qwen3-coder:30b` today may point at a
different digest tomorrow after a new build ships. This plugin watches the
digests of models you already pulled and notifies you when the registry has a
newer build.

## What it does

- Auto-seeds a watchlist from every registered Ollama host's local model list.
- Runs a daily HEAD request against `registry.ollama.ai` for each watched
  `family:tag`.
- When the registry digest differs from your local digest, emits an event via
  the notification queue.
- **Notify-only.** Nothing ever auto-pulls. You decide when to upgrade.

## Tools

| Tool | Purpose |
|------|---------|
| `model_watchlist_list` | Show what's being tracked |
| `model_watchlist_add { family, tag }` | Add a family:tag to the watchlist |
| `model_watchlist_remove { family, tag }` | Stop watching (soft-delete) |
| `model_freshness_scan_now` | Run the scan on-demand |
| `model_freshness_events` | List pending drift events |

## Typical flow

1. Install TORQUE — plugin auto-seeds from your Ollama hosts.
2. A new build of `qwen3-coder:30b` ships at 02:00; your scan runs at 03:00.
3. Scan finds a digest mismatch → event inserted, notification queued.
4. Next time you run `check_notifications` or visit the dashboard, you see:
   "qwen3-coder:30b — new digest available. Run `ollama pull qwen3-coder:30b`."
5. You decide. The monitor never pulls on your behalf.

## Disabling

Remove `'model-freshness'` from `DEFAULT_PLUGIN_NAMES` in `server/index.js` and
restart. Data stays in the DB but no further scans run.

## Scope (what it does NOT do)

- No auto-pull.
- No discovery of entirely new model families. (Run `ollama launch claude`
  interactively to see what's available.)
- No benchmark-based recommendations.
- No cloud-tag tracking. The `ollama-cloud` provider hits `api.ollama.com`
  separately; those tags are unreachable via `registry.ollama.ai`.
