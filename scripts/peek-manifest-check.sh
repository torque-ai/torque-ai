#!/usr/bin/env bash
# scripts/peek-manifest-check.sh
# Pre-commit hook: blocks commits that add visual surfaces not registered in peek-manifest.json.
# Requires: node (for manifest-patterns.js)
# Exit 0 = pass, Exit 1 = block commit with message.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$PROJECT_ROOT/peek-manifest.json"

# Skip if no manifest exists (project doesn't use visual sweep)
if [ ! -f "$MANIFEST" ]; then
  exit 0
fi

# Get framework from manifest
FRAMEWORK=$(node -e "
  const m = require('$MANIFEST');
  process.stdout.write(m.framework || '');
")

if [ -z "$FRAMEWORK" ]; then
  exit 0
fi

# Get staged files (added or modified)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=AM)
if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

# Run detection via Node using the shared patterns module
RESULT=$(node -e "
  const { detectVisualSurfaces, loadManifest, findUnregistered } = require('$PROJECT_ROOT/server/hooks/manifest-patterns');
  const fs = require('fs');
  const files = process.argv.slice(1);
  const contents = {};
  for (const f of files) {
    try { contents[f] = fs.readFileSync(f, 'utf-8'); } catch {}
  }
  const surfaces = detectVisualSurfaces(files, contents, '$FRAMEWORK');
  const manifest = loadManifest('$PROJECT_ROOT');
  const unregistered = findUnregistered(surfaces, manifest);
  if (unregistered.length > 0) {
    for (const s of unregistered) {
      console.error('  ' + s.file + ' (' + s.type + ': ' + s.id + ')');
    }
    process.exit(1);
  }
" $STAGED_FILES 2>&1) || {
  echo ""
  echo "PEEK MANIFEST: New visual surface(s) detected but not registered in peek-manifest.json:"
  echo "$RESULT"
  echo ""
  echo "Add them to peek-manifest.json or mark skip_visual: true in the section entry."
  echo "To bypass: git commit --no-verify"
  exit 1
}

exit 0
