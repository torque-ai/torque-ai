# Flake Hunt

Use this loop when the server suite reports a different single failing test across repeated pushes and Vitest retry does not reproduce it inside one process. The goal is to collect cross-run evidence for likely cross-file state pollution.

Run the loop from the repository root:

    bash scripts/flake-hunt/run-loop.sh

Run a shorter or labeled sample:

    bash scripts/flake-hunt/run-loop.sh 10 --label state-pollution-check

The loop runs `cd server && npx vitest run --reporter=json --outputFile /tmp/flake-run-i.json` through `torque-remote`, fetches each `/tmp/flake-run-i.json` back to the local machine, and copies the files into `scripts/flake-hunt/results/<label>/`. Per-run `.log` files are stored beside the JSON files so stderr and runner diagnostics are preserved without corrupting the JSON reporter output.

Analyze a completed result set:

    node scripts/flake-hunt/analyze.js scripts/flake-hunt/results/<label>/

The analyzer prints non-passed tests sorted by failure rate and writes `summary.md` in the same result directory. The rate column is `failing-runs/total-runs`; a test at `3/20` failed or was skipped in three separate suite runs. A rotating set of low-rate failures usually points at shared setup or teardown state, while the same high-rate test points at an isolation run or direct test fix.

Follow-up work should use the top entry from `summary.md`: run that test in isolation, run it after suspected polluting files, then bisect cleanup changes until the loop reports no non-passed tests.
