#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/flake-hunt/run-loop.sh [runs] [--label label]

Runs the server Vitest suite repeatedly through torque-remote and collects
Vitest JSON reporter output under scripts/flake-hunt/results/<label>/.

Arguments:
  runs             Optional positive integer run count. Defaults to 20.
  --label label    Optional result label. Defaults to YYYY-MM-DD-HHMMSS.
USAGE
}

die() {
  echo "[flake-hunt] ERROR: $*" >&2
  exit 1
}

RUN_COUNT="20"
RUN_COUNT_SET="false"
LABEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      shift
      [[ $# -gt 0 ]] || die "--label requires a value"
      LABEL="$1"
      ;;
    --label=*)
      LABEL="${1#--label=}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      die "Unknown option: $1"
      ;;
    *)
      [[ "$RUN_COUNT_SET" == "false" ]] || die "Unexpected extra positional argument: $1"
      RUN_COUNT="$1"
      RUN_COUNT_SET="true"
      ;;
  esac
  shift
done

[[ "$RUN_COUNT" =~ ^[0-9]+$ ]] || die "Run count must be a positive integer"
(( RUN_COUNT > 0 )) || die "Run count must be greater than zero"

if [[ -z "$LABEL" ]]; then
  LABEL="$(date '+%Y-%m-%d-%H%M%S')"
fi

[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || die "Label may only contain letters, numbers, dots, underscores, and dashes"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULT_DIR="$SCRIPT_DIR/results/$LABEL"

if [[ -n "${TORQUE_REMOTE_BIN:-}" ]]; then
  REMOTE_CMD=("$TORQUE_REMOTE_BIN")
elif command -v torque-remote >/dev/null 2>&1; then
  REMOTE_CMD=("$(command -v torque-remote)")
elif [[ -f "$REPO_ROOT/bin/torque-remote" ]]; then
  REMOTE_CMD=("bash" "$REPO_ROOT/bin/torque-remote")
else
  die "torque-remote not found in PATH or at $REPO_ROOT/bin/torque-remote"
fi

mkdir -p "$RESULT_DIR"

echo "[flake-hunt] label: $LABEL"
echo "[flake-hunt] runs: $RUN_COUNT"
echo "[flake-hunt] results: $RESULT_DIR"

for ((i = 1; i <= RUN_COUNT; i++)); do
  remote_json="/tmp/flake-run-${i}.json"
  local_tmp_json="/tmp/flake-run-${i}.json"
  fetch_tmp="/tmp/flake-run-${i}.json.fetch.$$"
  result_json="$RESULT_DIR/flake-run-${i}.json"
  log_file="$RESULT_DIR/flake-run-${i}.log"

  echo "[flake-hunt] run ${i}/${RUN_COUNT}: starting"

  rm -f "$local_tmp_json" "$fetch_tmp"
  "${REMOTE_CMD[@]}" rm -f "$remote_json" >>"$log_file" 2>&1 || true

  set +e
  "${REMOTE_CMD[@]}" cd server '&&' npx vitest run --reporter=json --outputFile "$remote_json" >"$log_file" 2>&1
  run_status=$?
  set -e

  set +e
  "${REMOTE_CMD[@]}" cat "$remote_json" >"$fetch_tmp" 2>>"$log_file"
  fetch_status=$?
  set -e

  if [[ $fetch_status -ne 0 || ! -s "$fetch_tmp" ]]; then
    rm -f "$fetch_tmp"
    die "Run $i did not produce readable JSON at $remote_json; see $log_file"
  fi

  mv "$fetch_tmp" "$local_tmp_json"
  cp "$local_tmp_json" "$result_json"

  echo "[flake-hunt] run ${i}/${RUN_COUNT}: exit ${run_status}, saved $(basename "$result_json")"

  if (( i < RUN_COUNT )); then
    sleep 2
  fi
done

echo "[flake-hunt] complete: $RESULT_DIR"
