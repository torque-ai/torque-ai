'use strict';

function parsePlanFile(content) {
  const lines = content.split('\n');
  const title = (lines.find(l => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').trim();
  const goal = (content.match(/\*\*Goal:\*\*\s*([^\n]+)/) || [])[1]?.trim() || null;
  const tech_stack = (content.match(/\*\*Tech Stack:\*\*\s*([^\n]+)/) || [])[1]?.trim() || null;

  const taskHeaderRe = /^##\s+Task\s+(\d+)\s*[:.]\s*(.+?)\s*$/;
  const stepRe = /^\s*-\s*\[([ xX])\]\s*\*\*Step\s+(\d+)\s*[:.]\s*([^*]+?)\s*\*\*/;

  const tasks = [];
  let currentTask = null;
  let currentStep = null;
  let inCode = false;
  let codeLang = null;
  let codeBuf = [];

  function closeStep() {
    if (currentStep) {
      if (codeBuf.length) currentStep.code_blocks.push({ lang: codeLang, content: codeBuf.join('\n') });
      codeBuf = []; codeLang = null; inCode = false;
      currentStep = null;
    }
  }
  function closeTask() {
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
      tasks.push(currentTask);
      currentTask = null;
    }
  }

  for (const line of lines) {
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
      closeTask();
      currentTask = { task_number: Number(th[1]), task_title: th[2], steps: [], commit_message: null, completed: false };
      continue;
    }
    const sh = line.match(stepRe);
    if (sh && currentTask) {
      closeStep();
      currentStep = {
        step_number: Number(sh[2]),
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

function extractVerifyCommand(planContent, projectDefault) {
  if (projectDefault) return projectDefault;
  const tech = (planContent.match(/\*\*Tech Stack:\*\*\s*([^\n]+)/) || [])[1] || '';
  if (/vitest/i.test(tech)) return 'npx vitest run';
  if (/tsc|typescript/i.test(tech)) return 'npx tsc --noEmit && npx vitest run';
  if (/jest/i.test(tech)) return 'npx jest';
  return 'npm test';
}

module.exports = { parsePlanFile, extractVerifyCommand };
