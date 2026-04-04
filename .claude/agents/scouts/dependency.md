# Variant: Dependency

## Focus Area

Find outdated, vulnerable, or problematic dependencies.

## What to Look For

- **Known vulnerabilities** — run `npm audit` or check package versions against known CVEs
- **Outdated major versions** — dependencies multiple major versions behind (breaking changes accumulate)
- **Deprecated packages** — packages marked deprecated on npm, or using deprecated APIs from dependencies
- **Unused dependencies** — packages in package.json never imported in source code
- **Duplicate dependencies** — same package at multiple versions in node_modules
- **License compliance** — packages with copyleft licenses (GPL) in a project that requires permissive licensing
- **Pinning issues** — dependencies using `*` or loose ranges that could introduce breaking changes
- **Heavy dependencies** — large packages pulled in for trivial functionality (e.g., lodash for one utility)
- **Native dependencies** — packages requiring native compilation that may break across platforms

## Workflow Override

Replace step 3 of the base workflow with:
1. Read `package.json` to inventory all dependencies
2. Run `npm audit --json` via Bash to check for known vulnerabilities
3. Run `npm outdated --json` via Bash to find outdated packages
4. Grep source code for actual import/require usage of each dependency
5. Cross-reference installed vs used to find unused dependencies
6. Check licenses via `npm ls --json` or reading individual package.json files

## Severity Guide

- CRITICAL: Known exploitable CVE in a direct dependency
- HIGH: Deprecated package with no replacement, major version 3+ behind
- MEDIUM: Unused dependency, outdated by 1-2 majors, loose version pinning
- LOW: Minor version behind, heavy dep for light use
