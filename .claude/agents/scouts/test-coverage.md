# Variant: Test Coverage

## Focus Area

Find untested code, weak tests, and coverage gaps.

## What to Look For

- **Untested modules** — source files with no corresponding test file
- **Critical paths without tests** — auth, payment, data persistence, task execution code lacking test coverage
- **Mock-heavy tests** — tests that mock so much they don't verify real behavior
- **Missing edge cases** — tests only covering happy path, no error scenarios, no boundary values
- **Assertion-free tests** — tests that run code but don't assert outcomes (false confidence)
- **Flaky test patterns** — tests depending on timing, order, or external state
- **Missing integration tests** — unit tests exist but no tests verify modules work together
- **Stale tests** — tests referencing functions/modules that no longer exist
- **Test file organization** — tests not co-located with source or not following naming conventions

## Workflow Override

Replace step 3 of the base workflow with:
1. Glob for all source files in scope: `server/**/*.js` (excluding tests, node_modules)
2. Glob for all test files: `server/tests/**/*.test.js`
3. Cross-reference: which source files have no matching test file?
4. For untested files, check file size and assess criticality (large files with business logic are higher priority)
5. For tested files, read a sample of tests to assess quality (assertions, mocks, edge cases)
6. Check for test utilities that might provide coverage not visible from file naming

## Severity Guide

- CRITICAL: Core execution/security module with zero test coverage
- HIGH: Business logic module untested, or tests that are all mocks with no real assertions
- MEDIUM: Missing edge case tests, partial coverage of important module
- LOW: Minor utility untested, test organization issues
