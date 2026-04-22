#!/usr/bin/env bash
set -euo pipefail

FEATURE_NAME="${1:-}"
if [ -z "$FEATURE_NAME" ]; then
  echo "Usage: scripts/worktree-cutover.sh <feature-name>"
  exit 1
fi

SAFE_NAME=$(echo "$FEATURE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
BRANCH="feat/${SAFE_NAME}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="${REPO_ROOT}/.worktrees/feat-${SAFE_NAME}"
TORQUE_API="http://127.0.0.1:3457"

if [ ! -d "$WORKTREE_DIR" ]; then
  echo "ERROR: Worktree not found at ${WORKTREE_DIR}"
  exit 1
fi

if ! git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "ERROR: Branch ${BRANCH} does not exist"
  exit 1
fi

echo ""
echo "  Worktree Cutover"
echo "  ================"
echo "  Feature: ${FEATURE_NAME}"
echo "  Branch:  ${BRANCH}"
echo "  Merge:   ${BRANCH} → main"
echo ""

if (cd "$WORKTREE_DIR" && ! git diff --quiet HEAD 2>/dev/null); then
  echo "ERROR: Worktree has uncommitted changes. Commit or stash them first."
  exit 1
fi

# Guard main's working tree too — another Claude session may be editing on main
# right now. If we merge + restart-barrier into main with dirty tracked files,
# the merge can "succeed" cleanly (non-overlapping paths) while the concurrent
# session's uncommitted edits get clobbered by later git ops. Fail fast so the
# other session can commit or stash first. (Untracked files are left alone.)
if ! git -C "${REPO_ROOT}" diff --quiet 2>/dev/null || \
   ! git -C "${REPO_ROOT}" diff --cached --quiet 2>/dev/null; then
  echo "ERROR: Main working tree has uncommitted tracked changes. Commit or stash them first."
  echo "       A concurrent Claude session may be editing on main — check before proceeding."
  echo "       Offending files:"
  git -C "${REPO_ROOT}" status --short | grep -vE '^\?\?' | sed 's/^/         /'
  echo "       Override (if you've verified this is safe): CUTOVER_ALLOW_DIRTY_MAIN=1 $0 $1"
  if [ "${CUTOVER_ALLOW_DIRTY_MAIN:-0}" != "1" ]; then
    exit 1
  fi
  echo "[warn] CUTOVER_ALLOW_DIRTY_MAIN=1 set — proceeding with dirty main."
fi

echo "  Merging ${BRANCH} into main..."
git merge "$BRANCH" --no-edit
echo "[ok] Merged"

# Dashboard bundle is served from dashboard/dist/. Only dist/index.html and
# dist/vite.svg are tracked — dist/assets/*.js|*.css are gitignored. If a
# feature branch touched dashboard sources or bumped deps, the committed
# index.html now references hashed asset filenames that don't exist on
# anyone else's disk until they rebuild. Do the rebuild now so the live
# TORQUE server (which serves from dashboard/dist) won't 404 the bundle
# after restart. Gate on the merge diff so server-only cutovers stay quiet.
merge_changed_files=$(git diff --name-only HEAD@{1} HEAD 2>/dev/null || true)
if echo "$merge_changed_files" | grep -qE "^dashboard/(src/|package(-lock)?\.json$|vite\.config\.)"; then
  echo "  Dashboard sources changed — rebuilding bundle..."
  if [ -d "${REPO_ROOT}/dashboard" ]; then
    # npx vite build (not 'npm run build') so the torque-remote-guard doesn't
    # route the build to the remote workstation — dashboard/dist must live
    # on the local filesystem to be served by dashboard-server.js.
    (cd "${REPO_ROOT}/dashboard" && npx vite build 2>&1 | tail -3) \
      || echo "[warn] Dashboard rebuild failed — bundles may be stale. Run 'cd dashboard && npx vite build' manually."
    if ! git -C "${REPO_ROOT}" diff --quiet -- dashboard/dist/index.html 2>/dev/null; then
      echo "[warn] dashboard/dist/index.html changed during rebuild — origin/main will drift from local."
      echo "       Commit it so future pulls stay in sync:"
      echo "         git add dashboard/dist/index.html && git commit -m 'chore(dashboard): rebuild bundle'"
    fi
  fi
fi

TORQUE_RUNNING=false
if curl -s --max-time 2 "${TORQUE_API}/api/version" > /dev/null 2>&1; then
  TORQUE_RUNNING=true
fi

# --- Restart via barrier primitive ---
# Instead of cooperative drain + stop-torque.sh (which races with factory
# auto_advance), we use the restart barrier: POST /api/v2/system/restart-server
# submits a provider='system' barrier task that blocks the queue scheduler from
# promoting any new work. Running tasks finish naturally, then the server
# restarts itself. No external kill required.

if [ "$TORQUE_RUNNING" = "true" ]; then
  # Cutover drain budget. Observed 2026-04-21: a 30-minute timeout is too
  # short when a factory batch carries an 8-hour Codex worktree task in
  # flight — the barrier expires before the task can finish cooperatively,
  # forcing restart while real work is still running. A full hour absorbs
  # the common long-task shapes without blocking cutover indefinitely; the
  # user can still override by exporting BARRIER_TIMEOUT_MIN before running.
  BARRIER_TIMEOUT_MIN=${BARRIER_TIMEOUT_MIN:-60}

  # --- Dry-run support ---
  # Set CUTOVER_DRY_RUN=1 to print the intended API calls without executing.
  if [ "${CUTOVER_DRY_RUN:-0}" = "1" ]; then
    echo "[dry-run] Would check for existing barrier:"
    echo "  GET ${TORQUE_API}/api/v2/tasks?status=running&provider=system&limit=10"
    echo "  GET ${TORQUE_API}/api/v2/tasks?status=queued&provider=system&limit=10"
    echo "[dry-run] Would submit restart barrier:"
    echo "  POST ${TORQUE_API}/api/v2/system/restart-server"
    echo "  Body: {\"reason\":\"Cutover to ${FEATURE_NAME}\",\"timeout_minutes\":${BARRIER_TIMEOUT_MIN}}"
    echo "[dry-run] Would poll barrier task:"
    echo "  GET ${TORQUE_API}/api/v2/tasks/<task_id>"
    echo "[dry-run] Would verify new server:"
    echo "  curl http://127.0.0.1:3458/sse"
  else
    echo "  Submitting restart barrier (drain + restart)..."

    # 1. Check for an existing barrier task — prevents concurrent cutovers
    #    from racing. If one exists, attach to it instead of submitting a new one.
    EXISTING_BARRIER=""
    for CHECK_STATUS in running queued; do
      RESP=$(curl -s --max-time 5 "${TORQUE_API}/api/v2/tasks?status=${CHECK_STATUS}&limit=100" 2>/dev/null || echo "")
      # Extract tasks with provider='system' — look for the barrier pattern.
      # POSIX-only (sed -E); grep -oP errors on gitbash Windows under the
      # default locale and the warnings leak into cutover output.
      FOUND=$(echo "$RESP" | sed -nE 's/.*"id"[[:space:]]*:[[:space:]]*"([^"\\]+)"[^{]*"provider"[[:space:]]*:[[:space:]]*"system".*/\1/p' | head -1 || true)
      if [ -n "$FOUND" ]; then
        EXISTING_BARRIER="$FOUND"
        break
      fi
    done

    if [ -n "$EXISTING_BARRIER" ]; then
      echo "  Existing barrier found (${EXISTING_BARRIER:0:8}) — attaching..."
      BARRIER_TASK_ID="$EXISTING_BARRIER"
    else
      # 2. Submit the restart barrier
      RESTART_RESP=$(curl -s --max-time 10 \
        -X POST "${TORQUE_API}/api/v2/system/restart-server" \
        -H "Content-Type: application/json" \
        -d "{\"reason\":\"Cutover to ${FEATURE_NAME}\",\"timeout_minutes\":${BARRIER_TIMEOUT_MIN}}" \
        2>/dev/null || echo "")

      if [ -z "$RESTART_RESP" ]; then
        echo "[error] Failed to submit restart barrier — no response from TORQUE."
        echo "        Merge landed but TORQUE was NOT restarted."
        echo "        Fallback: bash stop-torque.sh && nohup node server/index.js > /dev/null 2>&1 &"
        exit 2
      fi

      # Extract task_id from response. TORQUE's restart endpoint returns
      # either a plain JSON body ({"task_id":"...","status":"..."}) or the
      # MCP-tool-wrapped shape where the id is inside a `result` string
      # with backslash-escaped quotes. Prefer the JSON key; fall back to
      # the first UUID in the body so both shapes work.
      # Uses sed -E + grep -oE (POSIX), not grep -oP — gitbash on Windows
      # ships with a grep that errors "-P supports only unibyte and UTF-8
      # locales" under the default locale, which silently broke the id
      # extraction and left cutovers without an auto-restart (2026-04-20).
      BARRIER_TASK_ID=$(echo "$RESTART_RESP" | sed -nE 's/.*"task_id"[[:space:]]*:[[:space:]]*"([^"\\]+)".*/\1/p' | head -1 || true)
      if [ -z "$BARRIER_TASK_ID" ]; then
        BARRIER_TASK_ID=$(echo "$RESTART_RESP" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1 || true)
      fi
      BARRIER_STATUS=$(echo "$RESTART_RESP" | sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"([^"\\]+)".*/\1/p' | head -1 || true)

      if [ -z "$BARRIER_TASK_ID" ]; then
        echo "[error] Restart barrier response missing task_id."
        echo "        Response: ${RESTART_RESP}"
        echo "        Merge landed but TORQUE was NOT restarted."
        exit 2
      fi

      echo "  Barrier task: ${BARRIER_TASK_ID:0:8} (${BARRIER_STATUS})"

      # If status is already restart_scheduled, the pipeline was empty and
      # the server is about to restart — skip straight to the wait-for-new-server.
      if [ "$BARRIER_STATUS" = "restart_scheduled" ]; then
        echo "[ok] Pipeline was empty — server restart scheduled immediately."
      fi
    fi

    # 3. Poll the barrier task until completed or failed.
    #    The server's drain watcher handles the actual drain; we just watch
    #    the barrier task status. Timeout: same as the barrier's own timeout
    #    plus a small buffer for the grace period and process restart.
    POLL_DEADLINE=$(( $(date +%s) + (BARRIER_TIMEOUT_MIN + 1) * 60 ))

    if [ "${BARRIER_STATUS:-}" != "restart_scheduled" ]; then
      echo "  Waiting for pipeline drain..."
      while true; do
        TASK_RESP=$(curl -s --max-time 5 "${TORQUE_API}/api/v2/tasks/${BARRIER_TASK_ID}" 2>/dev/null || echo "")
        TASK_STATUS=$(echo "$TASK_RESP" | sed -nE 's/.*"status"[[:space:]]*:[[:space:]]*"([^"\\]+)".*/\1/p' | head -1 || true)

        if [ "$TASK_STATUS" = "completed" ]; then
          echo "[ok] Barrier completed — server restarting."
          break
        fi
        if [ "$TASK_STATUS" = "failed" ]; then
          TASK_ERROR=$(echo "$TASK_RESP" | sed -nE 's/.*"error_output"[[:space:]]*:[[:space:]]*"([^"\\]+)".*/\1/p' | head -1 || true)
          echo "[error] Barrier task failed: ${TASK_ERROR:-unknown}"
          echo "        Merge landed but TORQUE was NOT restarted."
          echo "        Options:"
          echo "        1. Wait for tasks to complete, then re-run: bash $0 $1"
          echo "        2. Cancel in-flight tasks manually, then re-run"
          echo "        3. Emergency override: bash stop-torque.sh --force && restart manually"
          exit 2
        fi
        # 'cancelled' is terminal — the barrier was aborted (operator ran
        # cancel_task, or an orchestrator timed out). Without this case the
        # poll loop kept looping silently until POLL_DEADLINE. Treat it as
        # an explicit abort: merge landed, TORQUE not restarted; re-run or
        # force-restart to recover. Observed 2026-04-21 when a phantom
        # drain-counter wedge was cleared by manual cancel_task.
        if [ "$TASK_STATUS" = "cancelled" ]; then
          echo "[error] Barrier task was cancelled mid-drain."
          echo "        Merge landed but TORQUE was NOT restarted."
          echo "        The queue has resumed (cancelled is terminal) but the"
          echo "        server is still running the old code."
          echo "        Options:"
          echo "        1. Re-run cutover to trigger a fresh barrier: bash $0 $1"
          echo "        2. Emergency override: bash stop-torque.sh --force && restart manually"
          exit 2
        fi
        if [ -z "$TASK_STATUS" ]; then
          # Server may have already shut down mid-poll — this is expected
          # during the restart grace period. Break and check for new server.
          echo "  Server unreachable (expected during restart)."
          break
        fi

        if [ "$(date +%s)" -gt "$POLL_DEADLINE" ]; then
          echo "[error] Timed out waiting for barrier task ${BARRIER_TASK_ID:0:8}."
          echo "        Merge landed but TORQUE was NOT restarted."
          exit 2
        fi

        echo "    Barrier ${BARRIER_TASK_ID:0:8}: ${TASK_STATUS} — sleeping 10s..."
        sleep 10
      done
    fi

    # 4. Wait for the new server to come up. The barrier handler triggers
    #    emitShutdown with a 1500ms grace period, then the process exits.
    #    The server auto-restarts (or the OS restarts it) on the updated main.
    #    We wait up to 30 seconds for the new process.
    echo "  Waiting for TORQUE to restart on updated main..."
    sleep 4
    RESTART_ATTEMPTS=0
    MAX_RESTART_WAIT=26  # 4s initial + up to 26 * 2s = 56s total
    while [ "$RESTART_ATTEMPTS" -lt "$MAX_RESTART_WAIT" ]; do
      if curl -s --max-time 2 "${TORQUE_API}/api/version" > /dev/null 2>&1; then
        echo "[ok] TORQUE restarted on updated main"
        break
      fi
      RESTART_ATTEMPTS=$((RESTART_ATTEMPTS + 1))
      sleep 2
    done

    if [ "$RESTART_ATTEMPTS" -ge "$MAX_RESTART_WAIT" ]; then
      echo "[warn] TORQUE did not come back up within 60s. Starting manually..."
      nohup node "${REPO_ROOT}/server/index.js" > /dev/null 2>&1 &
      sleep 4
      if curl -s --max-time 2 "${TORQUE_API}/api/version" > /dev/null 2>&1; then
        echo "[ok] TORQUE started manually on updated main"
      else
        echo "[warn] TORQUE may not have started. Check manually."
      fi
    fi
  fi
else
  echo "  TORQUE not running — no restart needed. Start it when ready."
fi

echo "  Cleaning up worktree..."
git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR"
echo "[ok] Worktree removed"

git branch -d "$BRANCH" 2>/dev/null || git branch -D "$BRANCH" 2>/dev/null || true
echo "[ok] Branch ${BRANCH} deleted"

echo ""
echo "  Cutover complete!"
echo "  Main is now up to date with ${FEATURE_NAME}."
echo ""
