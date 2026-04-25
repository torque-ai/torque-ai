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
TORQUE_PROBE_TIMEOUT_SECONDS=${CUTOVER_PROBE_TIMEOUT_SECONDS:-5}

torque_api_reachable() {
  # /livez is intentionally cheap and avoids false "not running" reports when
  # heavier endpoints are slow under factory load. Fall back to /api/version for
  # older servers that predate health probes.
  curl -s --max-time "${TORQUE_PROBE_TIMEOUT_SECONDS}" "${TORQUE_API}/livez" > /dev/null 2>&1 \
    || curl -s --max-time "${TORQUE_PROBE_TIMEOUT_SECONDS}" "${TORQUE_API}/api/version" > /dev/null 2>&1
}

resolve_torque_pid_file() {
  if [ -n "${TORQUE_PID_FILE:-}" ]; then
    echo "${TORQUE_PID_FILE}"
    return 0
  fi
  if [ -n "${TORQUE_DATA_DIR:-}" ]; then
    echo "${TORQUE_DATA_DIR}/torque.pid"
    return 0
  fi
  if [ -f "${HOME}/.torque/torque.pid" ] || [ -d "${HOME}/.torque" ]; then
    echo "${HOME}/.torque/torque.pid"
    return 0
  fi
  if [ -f "${REPO_ROOT}/server/torque.pid" ] || [ -d "${REPO_ROOT}/server" ]; then
    echo "${REPO_ROOT}/server/torque.pid"
    return 0
  fi
  echo "${TMPDIR:-/tmp}/torque/torque.pid"
}

read_pid_signature() {
  local pid_file="${1:-}"
  if [ -z "$pid_file" ] || [ ! -f "$pid_file" ]; then
    return 1
  fi
  node - "$pid_file" <<'EOF'
const fs = require('fs');

const pidFile = process.argv[2];
if (!pidFile) {
  process.exit(1);
}

try {
  const raw = fs.readFileSync(pidFile, 'utf8').trim();
  if (!raw) process.exit(1);

  try {
    const parsed = JSON.parse(raw);
    if (parsed && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : '';
      process.stdout.write(`${parsed.pid}|${startedAt}`);
      process.exit(0);
    }
  } catch {}

  const legacyPid = Number.parseInt(raw, 10);
  if (!Number.isInteger(legacyPid) || legacyPid <= 0) {
    process.exit(1);
  }
  process.stdout.write(`${legacyPid}|`);
} catch {
  process.exit(1);
}
EOF
}

pid_signature_changed() {
  local before="${1:-}"
  local after="${2:-}"
  [ -n "$before" ] && [ -n "$after" ] && [ "$before" != "$after" ]
}

TORQUE_PID_FILE_PATH="$(resolve_torque_pid_file)"
TORQUE_PRE_RESTART_PID_SIGNATURE=""

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

# The main repo's HEAD can drift off `main` — the factory's mergeWorktree and
# other cutovers run `git checkout <ref>` on the shared repo, and aren't
# guaranteed to land back on main. If we don't verify here, `git merge`
# silently merges into whatever branch happens to be checked out and
# `origin/main` never gets the fix. Documented regression: 2026-04-24
# feat/fix-dashboard-projection landed on feat/factory-project-routing-template
# because HEAD was on that branch when cutover ran.
current_branch=$(git -C "${REPO_ROOT}" symbolic-ref --short HEAD 2>/dev/null || echo "")
if [ "${current_branch}" != "main" ]; then
  echo "  Main repo was on '${current_branch}' — switching to main first."
  git -C "${REPO_ROOT}" checkout main
  post_switch=$(git -C "${REPO_ROOT}" symbolic-ref --short HEAD 2>/dev/null || echo "")
  if [ "${post_switch}" != "main" ]; then
    echo "ERROR: Could not switch to 'main' (still on '${post_switch}'). Aborting cutover."
    exit 1
  fi
fi

git merge "$BRANCH" --no-edit

# Sanity-check: confirm the merge actually landed on main. Catches the next
# failure mode where someone edits the cutover script and reintroduces a path
# that leaves us on the wrong branch.
post_merge_branch=$(git -C "${REPO_ROOT}" symbolic-ref --short HEAD 2>/dev/null || echo "")
if [ "${post_merge_branch}" != "main" ]; then
  echo "ERROR: post-merge branch is '${post_merge_branch}', expected 'main'. Refusing to proceed."
  exit 1
fi
if ! git merge-base --is-ancestor "${BRANCH}" main; then
  echo "ERROR: main does not contain '${BRANCH}' after merge. Cutover failed silently."
  exit 1
fi

# Post-merge working-tree parity check. `git merge` is supposed to update the
# working tree to match the new HEAD, but on Windows a locked file (AV scan,
# editor open on a tracked file, stale file handle in an aborted worktree)
# can leave `git merge` exiting clean with disk state still holding the old
# content. The merge commit lands, no error fires, and the first process
# that later runs `git add --renormalize .` (the factory's mergeWorktree
# path) silently commits the stale disk content under a misleading message.
# 2026-04-24 saw that clobber 150 lines of shipped perf work on main.
# Diff HEAD vs. the working tree with EOL + whitespace ignored — if the
# diff is non-empty after a fresh merge, something's wrong and we should
# abort before handing off to the restart barrier.
if ! git -C "${REPO_ROOT}" diff --quiet --ignore-cr-at-eol --ignore-all-space HEAD 2>/dev/null; then
  drifted=$(git -C "${REPO_ROOT}" diff --name-only --ignore-cr-at-eol --ignore-all-space HEAD 2>/dev/null | head -20)
  echo "ERROR: post-merge working tree has semantic drift vs HEAD."
  echo "       The merge commit landed but disk content doesn't match — most"
  echo "       likely a Windows file-lock during checkout. Investigate before"
  echo "       triggering the restart barrier; the factory's renormalize path"
  echo "       would otherwise capture the drift and clobber main."
  echo "       Drifted files:"
  echo "$drifted" | sed 's/^/         /'
  echo ""
  echo "       To recover: verify no editors/AV hold tracked files open, then"
  echo "       'git checkout HEAD -- .' to re-materialize HEAD content, then"
  echo "       re-run the cutover."
  exit 1
fi

echo "[ok] Merged"

# If the merge updated any tracked hook source under scripts/ (currently
# scripts/pre-push-hook), refresh the installed copy in .git/hooks/ so the
# next push gets the new version. Without this, hook source updates land
# on main but stay dormant until someone manually runs install-git-hooks
# or creates a new worktree — the symptom is "I shipped a hook fix but
# the gate is still using the old hook." Idempotent and quiet on no-op.
if echo "$merge_changed_files" | grep -qE "^scripts/(install-git-hooks\.sh|.*-hook)$"; then
  if [ -x "${REPO_ROOT}/scripts/install-git-hooks.sh" ]; then
    echo "  Hook source changed in merge — refreshing .git/hooks/..."
    bash "${REPO_ROOT}/scripts/install-git-hooks.sh" || \
      echo "[warn] install-git-hooks failed — .git/hooks may be stale. Run 'bash scripts/install-git-hooks.sh' manually."
  fi
fi

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
if torque_api_reachable; then
  TORQUE_RUNNING=true
  TORQUE_PRE_RESTART_PID_SIGNATURE=$(read_pid_signature "${TORQUE_PID_FILE_PATH}" 2>/dev/null || true)
fi

summarize_running_blockers() {
  local resp
  resp=$(curl -s --max-time 5 "${TORQUE_API}/api/v2/tasks?status=running&limit=20" 2>/dev/null || echo "")
  if [ -z "$resp" ]; then
    return 0
  fi
  node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(input); } catch { return; }
      const items = parsed?.data?.items || parsed?.items || parsed?.tasks || [];
      const blockers = items
        .filter(task => task && task.provider !== "system" && task.status === "running")
        .slice(0, 5);
      if (blockers.length === 0) return;
      console.log(`    Blocking running task${blockers.length === 1 ? "" : "s"}:`);
      for (const task of blockers) {
        const id = String(task.id || "").slice(0, 8) || "unknown";
        const provider = task.provider || "unknown";
        const cwd = task.working_directory || task.cwd || "";
        const desc = String(task.description || task.task_description || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 90);
        const where = cwd ? ` cwd=${cwd}` : "";
        console.log(`      ${id} ${provider}${where}${desc ? ` — ${desc}` : ""}`);
      }
    });
  ' <<< "$resp" 2>/dev/null || true
}

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
    echo "[dry-run] Would confirm process turnover before accepting health:"
    echo "  PID file: ${TORQUE_PID_FILE_PATH}"
    echo "  Require changed pid/startedAt or outage + recovery fallback"
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
      LAST_BLOCKER_REPORT=0
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

        NOW_SECONDS=$(date +%s)
        if [ $((NOW_SECONDS - LAST_BLOCKER_REPORT)) -ge "${CUTOVER_BLOCKER_REPORT_SECONDS:-60}" ]; then
          summarize_running_blockers
          LAST_BLOCKER_REPORT="$NOW_SECONDS"
        fi

        echo "    Barrier ${BARRIER_TASK_ID:0:8}: ${TASK_STATUS} — sleeping 10s..."
        sleep 10
      done
    fi

    # 4. Wait for the new server to come up. The barrier handler triggers
    #    emitShutdown with a 1500ms grace period, then the process exits.
    #    The server auto-restarts (or the OS restarts it) on the updated main.
    #    Startup can legitimately take minutes when the pre-startup backup is
    #    hashing a multi-GB SQLite DB, so keep waiting before attempting a
    #    manual start that could collide with the child process' startup lock.
    echo "  Waiting for TORQUE to restart on updated main..."
    if [ -n "${TORQUE_PRE_RESTART_PID_SIGNATURE}" ]; then
      echo "  Confirming restart via PID turnover: ${TORQUE_PID_FILE_PATH}"
    else
      echo "  PID record unavailable — falling back to outage + recovery confirmation."
    fi
    # 240s was empirically too tight: a contended workstation (multiple
    # factory tasks running, disk pressure during the orphan-tarball
    # period, slow pre-startup DB backup hashing a multi-GB sqlite) can
    # legitimately take 4-7 minutes to come back. The previous default
    # produced "TORQUE did not come back up" false alarms that triggered
    # an unnecessary manual `nohup node` and confused the operator into
    # thinking the cutover failed when it just hadn't finished yet.
    # Override via CUTOVER_RESTART_WAIT_SECONDS for slow environments.
    RESTART_WAIT_SECONDS=${CUTOVER_RESTART_WAIT_SECONDS:-480}
    RESTART_DEADLINE=$(( $(date +%s) + RESTART_WAIT_SECONDS ))
    RESTART_CONFIRMED=false
    OUTAGE_OBSERVED=false
    while [ "$(date +%s)" -lt "$RESTART_DEADLINE" ]; do
      CURRENT_REACHABLE=false
      if torque_api_reachable; then
        CURRENT_REACHABLE=true
      else
        OUTAGE_OBSERVED=true
      fi

      if [ "$CURRENT_REACHABLE" = "true" ]; then
        if [ -n "${TORQUE_PRE_RESTART_PID_SIGNATURE}" ]; then
          CURRENT_PID_SIGNATURE=$(read_pid_signature "${TORQUE_PID_FILE_PATH}" 2>/dev/null || true)
          if pid_signature_changed "${TORQUE_PRE_RESTART_PID_SIGNATURE}" "${CURRENT_PID_SIGNATURE}"; then
            echo "[ok] TORQUE restarted on updated main (confirmed via PID turnover)"
            RESTART_CONFIRMED=true
            break
          fi
        elif [ "$OUTAGE_OBSERVED" = "true" ]; then
          echo "[ok] TORQUE restarted on updated main (confirmed via outage + recovery)"
          RESTART_CONFIRMED=true
          break
        fi
      fi
      sleep 2
    done

    if [ "$RESTART_CONFIRMED" != "true" ] && torque_api_reachable; then
      if [ -n "${TORQUE_PRE_RESTART_PID_SIGNATURE}" ]; then
        echo "[error] TORQUE stayed reachable but never showed PID turnover."
        echo "        The old process may still be serving after barrier completion."
        echo "        Check ${TORQUE_PID_FILE_PATH} and torque.log before forcing a restart."
      else
        echo "[error] TORQUE stayed reachable but restart could not be confirmed."
        echo "        No PID record was available, and no outage was observed."
        echo "        Check ${TORQUE_PID_FILE_PATH} and torque.log before forcing a restart."
      fi
      exit 2
    fi

    if [ "$RESTART_CONFIRMED" != "true" ]; then
      echo "[warn] TORQUE did not come back up within ${RESTART_WAIT_SECONDS}s. Starting manually..."
      nohup node "${REPO_ROOT}/server/index.js" > /dev/null 2>&1 &
      MANUAL_WAIT_SECONDS=${CUTOVER_MANUAL_START_WAIT_SECONDS:-240}
      MANUAL_DEADLINE=$(( $(date +%s) + MANUAL_WAIT_SECONDS ))
      while [ "$(date +%s)" -lt "$MANUAL_DEADLINE" ]; do
        if torque_api_reachable; then
          if [ -n "${TORQUE_PRE_RESTART_PID_SIGNATURE}" ]; then
            CURRENT_PID_SIGNATURE=$(read_pid_signature "${TORQUE_PID_FILE_PATH}" 2>/dev/null || true)
            if pid_signature_changed "${TORQUE_PRE_RESTART_PID_SIGNATURE}" "${CURRENT_PID_SIGNATURE}"; then
              RESTART_CONFIRMED=true
              break
            fi
          else
            RESTART_CONFIRMED=true
            break
          fi
        fi
        sleep 2
      done
      if [ "$RESTART_CONFIRMED" = "true" ]; then
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
# Retry rm -rf 3x with backoff. On Windows, AV/indexer processes
# (Defender, WSearch) routinely hold open handles to files in
# node_modules/ for a few seconds after the worktree's bash session
# closes. The naive `... || rm -rf "$WORKTREE_DIR"` printed the
# infamous `rm: cannot remove ... Device or resource busy` and left
# the dir on disk — over time, dozens of orphan worktree dirs
# accumulated. Same retry pattern as torque-remote's cleanup_temp_dirs.
worktree_cleanup_ok=0
if git worktree remove "$WORKTREE_DIR" --force 2>/dev/null; then
  worktree_cleanup_ok=1
else
  for cleanup_attempt in 1 2 3; do
    if rm -rf "$WORKTREE_DIR" 2>/dev/null; then
      worktree_cleanup_ok=1
      git worktree prune 2>/dev/null || true
      break
    fi
    sleep 1
  done
fi
if [ "$worktree_cleanup_ok" -eq 1 ]; then
  echo "[ok] Worktree removed"
else
  echo "[warn] Could not remove $WORKTREE_DIR after retries — likely Windows file lock."
  echo "       The branch is merged; the dir is now an orphan. Run"
  echo "       'bash scripts/prune-merged-worktrees.sh --apply' once the"
  echo "       AV/indexer releases its handles to clean it up."
fi

git branch -d "$BRANCH" 2>/dev/null || git branch -D "$BRANCH" 2>/dev/null || true
echo "[ok] Branch ${BRANCH} deleted"

# Sweep up any older orphan worktrees whose branches are already merged.
# Best-effort, never blocks the cutover. The retry above handles THIS
# worktree; this catches the dozens of historical orphans from prior
# cutovers that lost the race to AV file locks.
if [ -x "${REPO_ROOT}/scripts/prune-merged-worktrees.sh" ]; then
  bash "${REPO_ROOT}/scripts/prune-merged-worktrees.sh" --apply --keep-factory 2>&1 | sed 's/^/  /' || true
fi

echo ""
echo "  Cutover complete!"
echo "  Main is now up to date with ${FEATURE_NAME}."
echo ""
