# Slot-Pull Scheduler

The slot-pull scheduler implements late-binding provider assignment. Tasks can enter the queue without a fixed provider, and the provider is chosen only when a real execution slot opens.

## What It Does

- Keeps queued work in a shared unassigned pool with `status='queued'` and `provider=NULL`.
- When a provider has capacity, it pulls the best matching task for its own capabilities, quality band, and concurrency limit.
- Selection is priority-first, then oldest-first, with a starvation override that can eventually relax quality-tier gating for old tasks without relaxing capability requirements.

## How It Differs From Legacy Scheduling

- Legacy scheduling decides the provider earlier and queues work against that provider.
- Slot-pull leaves the provider unset until dispatch time, so providers compete for eligible work from the same unassigned pool.
- In `slot-pull` mode, `queue-scheduler` stops doing the legacy assignment pass and instead calls `slot-pull-scheduler.onSlotFreed()` when capacity changes.

## Key Functions

- `findBestTaskForProvider(provider)`: scans unassigned queued tasks and returns the first task that matches provider eligibility, required capabilities, and quality-band rules.
- `runSlotPullPass()`: walks enabled providers with open slots, claims matching tasks, and starts them.
- `claimTask(taskId, provider)`: atomically assigns a provider only if the task is still unclaimed.
- `requeueAfterFailure(taskId, failedProvider)`: removes the failed provider from `eligible_providers`, re-queues the task with `provider=NULL`, or permanently fails it when no eligible providers remain.

## Configuration

- Config key: `scheduling_mode`
- Supported values: `legacy`, `slot-pull`
- Default seed value: `legacy`
- When set to `slot-pull`, queue processing uses the late-binding pull model described above.
