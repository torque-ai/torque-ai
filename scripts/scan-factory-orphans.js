#!/usr/bin/env node
/**
 * CLI wrapper for the factory orphan-branch reconciler.
 *
 * Usage:
 *   node scripts/scan-factory-orphans.js <project-path> [<project-name>]
 *
 * Scans the given project's origin remote for factory-named feature
 * branches that carry commits never merged to base, then writes a markdown
 * report to <project>/docs/findings/<date>-factory-orphans-<name>.md.
 *
 * Intended for operator triage — auto-merge is not attempted, the operator
 * decides per-branch whether to ff-merge, cherry-pick, or delete.
 */
'use strict';

const path = require('path');
const { findOrphanFactoryBranches, writeOrphanFindings } = require(
  path.join(__dirname, '..', 'server', 'factory', 'orphan-reconciler'),
);

function main() {
  const projectPath = process.argv[2];
  if (!projectPath) {
    console.error('usage: scan-factory-orphans.js <project-path> [<project-name>]');
    process.exit(2);
  }
  const absPath = path.resolve(projectPath);
  const projectName = process.argv[3] || path.basename(absPath);

  const orphans = findOrphanFactoryBranches({ projectPath: absPath });
  const file = writeOrphanFindings({
    projectPath: absPath,
    projectName,
    orphans,
  });

  console.log(`Scanned ${projectName}: found ${orphans.length} orphan factory branch(es) on origin.`);
  console.log(`Report: ${file}`);
  if (orphans.length > 0) {
    console.log('\nSummary:');
    for (const o of orphans) {
      console.log(`  ${o.workItemId}\t${o.aheadCount} commit(s)\t${o.branch}`);
    }
  }
}

try { main(); } catch (err) {
  console.error('scan-factory-orphans failed:', err.message);
  process.exit(1);
}
