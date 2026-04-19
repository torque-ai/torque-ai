'use strict';

function parsePlanFile(content) {
  const lines = content.split('\n');
  const title = (lines.find(l => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').trim();
  const goal = (content.match(/\*\*Goal:\*\*\s*([^\n]+)/) || [])[1]?.trim() || null;
  const tech_stack = (content.match(/\*\*Tech Stack:\*\*\s*([^\n]+)/) || [])[1]?.trim() || null;

  // Accept h2/h3/h4 task headers — plans vary in nesting depth (top-level
  // `## Task N:` vs. under a `## Tasks` umbrella with `### Task N:`). The
  // strict h2-only regex produced zero-task parses on otherwise-valid plans
  // and triggered the EXECUTE spin-loop (2026-04-19 item 102 incident).
  const taskHeaderRe = /^#{2,4}\s+Task\s+(\d+)\s*[:.]\s*(.+?)\s*$/;
  const stepRe = /^\s*-\s*\[([ xX])\]\s*\*\*Step\s+([0-9]+[A-Za-z]?)\s*[:.]\s*([^*]+?)\s*\*\*/;

  const tasks = [];
  let currentTask = null;
  let currentStep = null;
  let inCode = false;
  let codeLang = null;
  let codeBuf = [];
  let inIndentedCode = false;
  let indentedCodeBuf = [];
  let taskStartIdx = null;

  function flushIndentedCode() {
    if (currentStep && indentedCodeBuf.length > 0) {
      currentStep.code_blocks.push({ lang: null, content: indentedCodeBuf.join('\n') });
    }
    indentedCodeBuf = [];
    inIndentedCode = false;
  }

  function closeStep() {
    if (currentStep) {
      if (codeBuf.length) currentStep.code_blocks.push({ lang: codeLang, content: codeBuf.join('\n') });
      flushIndentedCode();
      codeBuf = []; codeLang = null; inCode = false;
      currentStep = null;
    }
  }
  function closeTask(endIdx = null) {
    closeStep();
    if (currentTask) {
      currentTask.completed = currentTask.steps.length > 0 && currentTask.steps.every(s => s.done);
      const commitStep = currentTask.steps.find(s => /commit/i.test(s.title));
      if (commitStep) {
        for (const block of commitStep.code_blocks) {
          const m = block.content.match(/git commit -m ["'`](.+?)["'`]/);
          if (m) { currentTask.commit_message = m[1]; break; }
        }
      }
      // Capture the raw markdown text of this task (from its ## header up
      // to the next ## header) so consumers can scan the prose between
      // step checkboxes and code blocks — that prose is where file paths
      // like "Create `server/foo.js`:" live.
      if (taskStartIdx !== null) {
        const sliceEnd = endIdx === null ? lines.length : endIdx;
        currentTask.raw_markdown = lines.slice(taskStartIdx, sliceEnd).join('\n');
      }
      tasks.push(currentTask);
      currentTask = null;
      taskStartIdx = null;
    }
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];
    if (!inCode && currentStep) {
      if (/^(?: {4}|\t)/.test(line)) {
        inIndentedCode = true;
        indentedCodeBuf.push(line.replace(/^(?: {4}|\t)/, ''));
        continue;
      }

      if (inIndentedCode && line.trim() === '') {
        indentedCodeBuf.push('');
        continue;
      }

      if (inIndentedCode) {
        flushIndentedCode();
      }
    }

    if (/^```/.test(line)) {
      if (!inCode) { inCode = true; codeLang = line.replace(/^```/, '').trim() || null; codeBuf = []; }
      else {
        if (currentStep) currentStep.code_blocks.push({ lang: codeLang, content: codeBuf.join('\n') });
        inCode = false; codeBuf = []; codeLang = null;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const th = line.match(taskHeaderRe);
    if (th) {
      closeTask(lineIdx);
      currentTask = { task_number: Number(th[1]), task_title: th[2], steps: [], commit_message: null, completed: false };
      taskStartIdx = lineIdx;
      continue;
    }
    const sh = line.match(stepRe);
    if (sh && currentTask) {
      closeStep();
      const stepLabel = sh[2];
      currentStep = {
        step_number: /^\d+$/.test(stepLabel) ? Number(stepLabel) : stepLabel,
        title: sh[3].trim(),
        done: sh[1].toLowerCase() === 'x',
        code_blocks: [],
        raw_checkbox_line: line,
      };
      currentTask.steps.push(currentStep);
      continue;
    }
  }
  closeTask();

  return { title, goal, tech_stack, tasks };
}

function parsePlanMarkdown(content) {
  const parsed = parsePlanFile(content);
  return {
    ...parsed,
    step_count: parsed.tasks.reduce((sum, task) => sum + task.steps.length, 0),
  };
}

function extractVerifyCommand(planContent, projectDefault) {
  if (projectDefault) return projectDefault;
  const tech = (planContent.match(/\*\*Tech Stack:\*\*\s*([^\n]+)/) || [])[1] || '';
  if (/vitest/i.test(tech)) return 'npx vitest run';
  if (/tsc|typescript/i.test(tech)) return 'npx tsc --noEmit && npx vitest run';
  if (/jest/i.test(tech)) return 'npx jest';
  return 'npm test';
}

module.exports = { parsePlanFile, parsePlanMarkdown, extractVerifyCommand };
