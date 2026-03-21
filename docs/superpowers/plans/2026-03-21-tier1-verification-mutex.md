# Verification Mutex / Merge Serialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Prevent merge conflicts when multiple workflows complete simultaneously by serializing the commit/verify step.

**Architecture:** A CommitMutex (async semaphore with capacity 1) guards the auto-commit step in await_workflow and await_task. Tasks queue for the lock, execute commit + verify atomically, then release. Timeout prevents indefinite blocking.

**Tech Stack:** In-process async mutex, existing await_workflow/await_task handlers

**Inspired by:** agent-orchestrator (verificationMutex serializing merge+verify across tracks)

---

### Task 1: CommitMutex module

**Files:**
- Create: `server/utils/commit-mutex.js`
- Test: `server/tests/commit-mutex.test.js`

Simple async semaphore with capacity 1:
- `acquire(timeoutMs = 30000)` -- returns a release function, throws on timeout
- `release()` -- allows next waiter to proceed
- `isLocked()` -- returns boolean
- `waitingCount()` -- returns number of queued waiters

- [ ] Step 1: Write failing tests (acquire/release, mutual exclusion, timeout, FIFO ordering)
- [ ] Step 2: Implement commit-mutex.js
- [ ] Step 3: Run tests
- [ ] Step 4: Commit

---

### Task 2: Wire into await_workflow auto-commit

**Files:**
- Modify: `server/handlers/workflow/await.js` -- wrap auto-commit section with mutex

- [ ] Step 1: Import commitMutex singleton
- [ ] Step 2: Wrap the verify_command + auto_commit section in await_workflow with acquire/release
- [ ] Step 3: Ensure release happens in finally block (no lock leaks)
- [ ] Step 4: Write test -- two concurrent workflows serialize their commits
- [ ] Step 5: Run tests
- [ ] Step 6: Commit

---

### Task 3: Wire into await_task auto-commit

**Files:**
- Modify: `server/handlers/workflow/await.js` -- wrap await_task auto-commit with same mutex

- [ ] Step 1: Wrap the verify_command + auto_commit section in await_task with acquire/release
- [ ] Step 2: Ensure release in finally block
- [ ] Step 3: Run tests
- [ ] Step 4: Commit
