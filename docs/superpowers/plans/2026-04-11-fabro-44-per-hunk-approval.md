# Fabro #44: Per-Hunk Approval Gates for Multi-File Edits (Mentat)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a Codex/agent task proposes a multi-file diff and the workflow is configured for human review, present the diff in the dashboard with **per-file and per-hunk Accept/Reject controls** instead of a single all-or-nothing apply. The accepted subset is committed; the rejected hunks are sent back to the agent as feedback for a follow-up pass. Inspired by Mentat's inspect mode.

**Architecture:** A new `pending_diffs` table records `(task_id, file_path, hunk_index, hunk_content, status: pending|accepted|rejected, reject_reason)`. When a task with `approval_mode: 'per_hunk'` completes, the auto-apply pipeline parses its diff, stores per-hunk rows, and pauses the task. The dashboard renders a side-by-side diff with checkboxes per hunk + per file. Operator submits a verdict; accepted hunks are applied to the working tree and committed; rejected hunks build a "feedback prompt" that's automatically resubmitted as a follow-up task.

**Tech Stack:** Node.js, parse-diff (or write a small parser), better-sqlite3. Builds on plans 14 (events), 19 (lifecycle hooks), 20 (shadow-git checkpoints).

---

## File Structure

**New files:**
- `server/migrations/0NN-pending-diffs.sql`
- `server/approval/diff-parser.js` — parse unified diff into hunks
- `server/approval/diff-applier.js` — apply selected hunks back to disk
- `server/approval/feedback-prompt.js` — build follow-up prompt from rejections
- `server/tests/diff-parser.test.js`
- `server/tests/diff-applier.test.js`
- `dashboard/src/views/DiffApproval.jsx`

**Modified files:**
- `server/handlers/task/submit.js` — accept `approval_mode: 'per_hunk' | 'per_file' | 'auto'`
- `server/tool-defs/task-defs.js`
- `server/execution/task-finalizer.js` — open approval session when configured
- `server/api/routes/approvals.js`

---

## Task 1: Diff parser

- [ ] **Step 1: Tests**

Create `server/tests/diff-parser.test.js`:

```js
'use strict';
const { describe, it, expect } = require('vitest');
const { parseUnifiedDiff } = require('../approval/diff-parser');

const SAMPLE = `diff --git a/src/foo.js b/src/foo.js
--- a/src/foo.js
+++ b/src/foo.js
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 console.log(x);
diff --git a/src/bar.js b/src/bar.js
new file mode 100644
--- /dev/null
+++ b/src/bar.js
@@ -0,0 +1,2 @@
+module.exports = function bar() {};
+
`;

describe('parseUnifiedDiff', () => {
  it('extracts files and hunks', () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('src/foo.js');
    expect(files[0].hunks).toHaveLength(1);
    expect(files[1].path).toBe('src/bar.js');
    expect(files[1].is_new).toBe(true);
  });

  it('preserves hunk content for re-application', () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files[0].hunks[0].body).toContain('-const y = 2;');
    expect(files[0].hunks[0].body).toContain('+const y = 3;');
  });

  it('returns hunk metadata: oldStart, oldLines, newStart, newLines', () => {
    const files = parseUnifiedDiff(SAMPLE);
    const h = files[0].hunks[0];
    expect(h.old_start).toBe(1);
    expect(h.old_lines).toBe(3);
    expect(h.new_start).toBe(1);
    expect(h.new_lines).toBe(4);
  });

  it('handles empty/null input gracefully', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

Create `server/approval/diff-parser.js`:

```js
'use strict';

function parseUnifiedDiff(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const lines = raw.split('\n');
  const files = [];
  let cur = null;
  let hunk = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      if (cur) files.push(cur);
      cur = { path: fileMatch[2], hunks: [], is_new: false, is_deleted: false };
      hunk = null;
      continue;
    }
    if (line.startsWith('new file mode')) { if (cur) cur.is_new = true; continue; }
    if (line.startsWith('deleted file mode')) { if (cur) cur.is_deleted = true; continue; }
    if (line.startsWith('---') || line.startsWith('+++')) continue;

    const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkHeader && cur) {
      hunk = {
        old_start: parseInt(hunkHeader[1], 10),
        old_lines: hunkHeader[2] ? parseInt(hunkHeader[2], 10) : 1,
        new_start: parseInt(hunkHeader[3], 10),
        new_lines: hunkHeader[4] ? parseInt(hunkHeader[4], 10) : 1,
        body: '',
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      hunk.body += line + '\n';
    }
  }
  if (cur) files.push(cur);
  return files;
}

module.exports = { parseUnifiedDiff };
```

Run tests → PASS. Commit: `feat(approval): unified-diff parser into file/hunk model`.

---

## Task 2: Pending-diff store + applier

- [ ] **Step 1: Migration**

`server/migrations/0NN-pending-diffs.sql`:

```sql
CREATE TABLE IF NOT EXISTS pending_diffs (
  pending_diff_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workflow_id TEXT,
  file_path TEXT NOT NULL,
  hunk_index INTEGER NOT NULL,
  hunk_body TEXT NOT NULL,
  is_new INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_diffs_task ON pending_diffs(task_id);
CREATE INDEX IF NOT EXISTS idx_pending_diffs_status ON pending_diffs(status);
```

- [ ] **Step 2: Tests**

Create `server/tests/diff-applier.test.js`:

```js
'use strict';
const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { applyAcceptedHunks } = require('../approval/diff-applier');

describe('applyAcceptedHunks', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffapply-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creates new file from new-file hunk', async () => {
    const hunks = [{ file_path: 'foo.js', hunk_body: '+module.exports = 1;\n', is_new: true, status: 'accepted' }];
    await applyAcceptedHunks({ workingDir: dir, hunks });
    expect(fs.readFileSync(path.join(dir, 'foo.js'), 'utf8')).toBe('module.exports = 1;\n');
  });

  it('applies in-place modification with patch util', async () => {
    fs.writeFileSync(path.join(dir, 'foo.js'), 'a\nb\nc\n');
    const hunkBody = ` a\n-b\n+B\n c\n`;
    await applyAcceptedHunks({
      workingDir: dir,
      hunks: [{ file_path: 'foo.js', hunk_body: hunkBody, status: 'accepted', old_start: 1, old_lines: 3, new_start: 1, new_lines: 3 }],
    });
    expect(fs.readFileSync(path.join(dir, 'foo.js'), 'utf8')).toBe('a\nB\nc\n');
  });

  it('skips rejected hunks', async () => {
    fs.writeFileSync(path.join(dir, 'foo.js'), 'a\n');
    await applyAcceptedHunks({
      workingDir: dir,
      hunks: [{ file_path: 'foo.js', hunk_body: ' a\n+b\n', status: 'rejected', old_start: 1, old_lines: 1, new_start: 1, new_lines: 2 }],
    });
    expect(fs.readFileSync(path.join(dir, 'foo.js'), 'utf8')).toBe('a\n');
  });
});
```

- [ ] **Step 3: Implement**

Create `server/approval/diff-applier.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

function parseHunkBody(body) {
  const oldLines = [];
  const newLines = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith(' ')) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); }
  }
  return { oldLines, newLines };
}

async function applyAcceptedHunks({ workingDir, hunks }) {
  // Group accepted hunks by file
  const byFile = new Map();
  for (const h of hunks) {
    if (h.status !== 'accepted') continue;
    if (!byFile.has(h.file_path)) byFile.set(h.file_path, []);
    byFile.get(h.file_path).push(h);
  }

  for (const [filePath, fileHunks] of byFile.entries()) {
    const absPath = path.join(workingDir, filePath);

    if (fileHunks.some(h => h.is_new)) {
      const content = fileHunks.flatMap(h => parseHunkBody(h.hunk_body).newLines).join('\n');
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content + (content.endsWith('\n') ? '' : '\n'));
      continue;
    }

    if (fileHunks.some(h => h.is_deleted)) {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      continue;
    }

    // Apply hunks in REVERSE order so earlier line numbers stay valid
    let current = fs.readFileSync(absPath, 'utf8').split('\n');
    const sorted = [...fileHunks].sort((a, b) => b.old_start - a.old_start);
    for (const h of sorted) {
      const { oldLines, newLines } = parseHunkBody(h.hunk_body);
      // Replace lines [old_start-1 .. old_start-1+old_lines)
      const before = current.slice(0, h.old_start - 1);
      const after = current.slice(h.old_start - 1 + oldLines.length);
      current = [...before, ...newLines, ...after];
    }
    fs.writeFileSync(absPath, current.join('\n'));
  }
}

module.exports = { applyAcceptedHunks };
```

Run tests → PASS. Commit: `feat(approval): per-hunk diff applier`.

---

## Task 3: Wire into task lifecycle

- [ ] **Step 1: Tool def**

In `server/tool-defs/task-defs.js`:

```js
approval_mode: {
  type: 'string',
  enum: ['auto', 'per_file', 'per_hunk'],
  default: 'auto',
  description: 'How to apply file changes from this task. auto = apply all immediately. per_file = require operator approval per file. per_hunk = require approval per hunk.',
},
```

- [ ] **Step 2: Finalizer pauses for approval**

In `server/execution/task-finalizer.js` after a successful task completes (and before file changes are applied):

```js
const meta = parseTaskMetadata(task);
const mode = meta.approval_mode || 'auto';
if (mode !== 'auto' && task.diff_output) {
  const { parseUnifiedDiff } = require('../approval/diff-parser');
  const files = parseUnifiedDiff(task.diff_output);
  const insert = db.prepare(`
    INSERT INTO pending_diffs (pending_diff_id, task_id, workflow_id, file_path, hunk_index, hunk_body, is_new, is_deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const f of files) {
    f.hunks.forEach((h, i) => {
      insert.run(`pd_${randomUUID().slice(0, 12)}`, task.task_id, task.workflow_id,
        f.path, i, h.hunk_body, f.is_new ? 1 : 0, f.is_deleted ? 1 : 0);
    });
  }
  db.prepare(`UPDATE tasks SET status = 'awaiting_approval' WHERE task_id = ?`).run(task.task_id);
  defaultContainer.get('journalWriter').write({
    workflowId: task.workflow_id, taskId: task.task_id,
    type: 'approval_required', payload: { file_count: files.length, hunk_count: files.reduce((s, f) => s + f.hunks.length, 0) },
  });
  return; // do NOT auto-apply
}
```

Add `approval_required` to `VALID_EVENT_TYPES`.

Commit: `feat(approval): finalizer holds task in awaiting_approval state for per-hunk mode`.

---

## Task 4: Apply + feedback flow

- [ ] **Step 1: Feedback prompt builder**

Create `server/approval/feedback-prompt.js`:

```js
'use strict';

function buildFeedbackPrompt({ originalTaskDescription, rejectedHunks }) {
  const grouped = new Map();
  for (const h of rejectedHunks) {
    if (!grouped.has(h.file_path)) grouped.set(h.file_path, []);
    grouped.get(h.file_path).push(h);
  }

  const sections = Array.from(grouped.entries()).map(([file, hunks]) => {
    const reasons = hunks.map(h => `- Hunk @ line ${h.old_start || '?'}: ${h.reject_reason || '(no reason given)'}`).join('\n');
    return `### ${file}\n${reasons}`;
  }).join('\n\n');

  return `Your previous attempt was partially accepted. The following hunks were rejected by the operator:

${sections}

Please revise your approach to address these rejections. Focus only on producing a corrected version of the rejected hunks. Do not redo the accepted parts.

Original task:
${originalTaskDescription}`;
}

module.exports = { buildFeedbackPrompt };
```

- [ ] **Step 2: REST**

Create `server/api/routes/approvals.js`:

```js
'use strict';
const express = require('express');
const router = express.Router();
const { defaultContainer } = require('../../container');

router.get('/', (req, res) => {
  const status = req.query.status || 'pending';
  const rows = defaultContainer.get('db').prepare(`
    SELECT pending_diff_id, task_id, file_path, hunk_index, hunk_body, status, is_new, is_deleted
    FROM pending_diffs WHERE status = ? ORDER BY task_id, file_path, hunk_index
  `).all(status);
  res.json({ pending_diffs: rows });
});

router.get('/task/:task_id', (req, res) => {
  const rows = defaultContainer.get('db').prepare(`
    SELECT * FROM pending_diffs WHERE task_id = ? ORDER BY file_path, hunk_index
  `).all(req.params.task_id);
  res.json({ task_id: req.params.task_id, pending_diffs: rows });
});

router.post('/task/:task_id/decide', express.json(), async (req, res) => {
  const db = defaultContainer.get('db');
  const decisions = req.body?.decisions || []; // [{pending_diff_id, status, reject_reason}]
  for (const d of decisions) {
    db.prepare(`UPDATE pending_diffs SET status = ?, reject_reason = ? WHERE pending_diff_id = ?`)
      .run(d.status, d.reject_reason || null, d.pending_diff_id);
  }

  const all = db.prepare('SELECT * FROM pending_diffs WHERE task_id = ?').all(req.params.task_id);
  const accepted = all.filter(h => h.status === 'accepted');
  const rejected = all.filter(h => h.status === 'rejected');

  if (accepted.length > 0) {
    const { applyAcceptedHunks } = require('../../approval/diff-applier');
    const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(req.params.task_id);
    await applyAcceptedHunks({ workingDir: task.working_directory, hunks: accepted });
  }

  if (rejected.length === 0) {
    db.prepare(`UPDATE tasks SET status = 'completed' WHERE task_id = ?`).run(req.params.task_id);
    return res.json({ ok: true, applied: accepted.length });
  }

  // Build feedback prompt and submit follow-up task
  const { buildFeedbackPrompt } = require('../../approval/feedback-prompt');
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(req.params.task_id);
  const followUpPrompt = buildFeedbackPrompt({
    originalTaskDescription: task.task_description, rejectedHunks: rejected,
  });
  const submit = defaultContainer.get('taskSubmitter');
  const followUp = await submit.submit({
    task: followUpPrompt, project: task.project, provider: task.provider,
    working_directory: task.working_directory, approval_mode: 'per_hunk',
    metadata: { follow_up_of: req.params.task_id },
  });

  db.prepare(`UPDATE tasks SET status = 'completed' WHERE task_id = ?`).run(req.params.task_id);
  res.json({ ok: true, applied: accepted.length, rejected: rejected.length, follow_up_task_id: followUp.task_id });
});

module.exports = router;
```

- [ ] **Step 3: Dashboard**

Create `dashboard/src/views/DiffApproval.jsx` rendering side-by-side diff with checkbox per hunk and per file, optional reject reason input, and "Apply selected" / "Reject all" buttons.

`await_restart`. Smoke: submit a task with `approval_mode: 'per_hunk'`, let it produce a 3-file diff. Confirm dashboard pauses. Accept 2 hunks, reject 1 with reason "wrong api". Confirm: accepted hunks applied to disk, follow-up task spawned with the rejection feedback in its prompt.

Commit: `feat(approval): per-hunk apply + reject builds follow-up feedback task`.
