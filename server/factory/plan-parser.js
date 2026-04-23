'use strict';

const EXPLICIT_TASK_HEADER_RE = /^#{2,4}\s+Task\s+(\d+)\s*[:.]\s*(.+?)\s*$/;
const EXPLICIT_STEP_RE = /^\s*-\s*\[([ xX])\]\s*\*\*Step\s+([0-9]+[A-Za-z]?)\s*[:.]\s*([^*]+?)\s*\*\*/;
const CHECKLIST_HEADING_RE = /^(#{2,4})\s+(.+?)\s*$/;
const CHECKLIST_STEP_RE = /^\s*(?:[-*]|\d+\.)\s*\[([ xX])\]\s*(.+?)\s*$/;

function normalizeInlineMarkdown(text) {
  return String(text || '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseExplicitTaskPlan(lines) {
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
      codeBuf = [];
      codeLang = null;
      inCode = false;
      currentStep = null;
    }
  }

  function closeTask(endIdx = null) {
    closeStep();
    if (currentTask) {
      currentTask.completed = currentTask.steps.length > 0 && currentTask.steps.every((step) => step.done);
      const commitStep = currentTask.steps.find((step) => /commit/i.test(step.title));
      if (commitStep) {
        for (const block of commitStep.code_blocks) {
          const match = block.content.match(/git commit -m ["'`](.+?)["'`]/);
          if (match) {
            currentTask.commit_message = match[1];
            break;
          }
        }
      }
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
      if (!inCode) {
        inCode = true;
        codeLang = line.replace(/^```/, '').trim() || null;
        codeBuf = [];
      } else {
        if (currentStep) {
          currentStep.code_blocks.push({ lang: codeLang, content: codeBuf.join('\n') });
        }
        inCode = false;
        codeBuf = [];
        codeLang = null;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const taskHeader = line.match(EXPLICIT_TASK_HEADER_RE);
    if (taskHeader) {
      closeTask(lineIdx);
      currentTask = {
        task_number: Number(taskHeader[1]),
        task_title: taskHeader[2],
        steps: [],
        commit_message: null,
        completed: false,
      };
      taskStartIdx = lineIdx;
      continue;
    }

    const stepHeader = line.match(EXPLICIT_STEP_RE);
    if (stepHeader && currentTask) {
      closeStep();
      const stepLabel = stepHeader[2];
      currentStep = {
        step_number: /^\d+$/.test(stepLabel) ? Number(stepLabel) : stepLabel,
        title: stepHeader[3].trim(),
        done: stepHeader[1].toLowerCase() === 'x',
        code_blocks: [],
        raw_checkbox_line: line,
      };
      currentTask.steps.push(currentStep);
    }
  }

  closeTask();
  return tasks;
}

function buildChecklistSections(lines) {
  const headings = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const match = lines[lineIdx].match(CHECKLIST_HEADING_RE);
    if (!match) {
      continue;
    }
    headings.push({
      index: lineIdx,
      level: match[1].length,
      title: match[2].trim(),
    });
  }

  return headings.map((heading, index) => {
    let end = lines.length;
    for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
      if (headings[nextIndex].level <= heading.level) {
        end = headings[nextIndex].index;
        break;
      }
    }
    return { ...heading, end };
  });
}

function isLineNestedUnderSection(lineIdx, section, sections) {
  return sections.some((candidate) => (
    candidate.index > section.index
    && candidate.index < section.end
    && candidate.level > section.level
    && lineIdx >= candidate.index
    && lineIdx < candidate.end
  ));
}

function parseChecklistTaskPlan(lines) {
  const sections = buildChecklistSections(lines);
  const tasks = [];

  for (const section of sections) {
    const directChecklistLines = [];
    for (let lineIdx = section.index + 1; lineIdx < section.end; lineIdx += 1) {
      if (isLineNestedUnderSection(lineIdx, section, sections)) {
        continue;
      }
      if (CHECKLIST_STEP_RE.test(lines[lineIdx])) {
        directChecklistLines.push(lineIdx);
      }
    }

    if (directChecklistLines.length === 0) {
      continue;
    }

    const steps = [];
    let currentStep = null;
    let inCode = false;
    let codeLang = null;
    let codeBuf = [];
    let inIndentedCode = false;
    let indentedCodeBuf = [];

    function flushIndentedCode() {
      if (currentStep && indentedCodeBuf.length > 0) {
        currentStep.code_blocks.push({ lang: null, content: indentedCodeBuf.join('\n') });
      }
      indentedCodeBuf = [];
      inIndentedCode = false;
    }

    function closeStep() {
      if (!currentStep) {
        return;
      }
      if (codeBuf.length) {
        currentStep.code_blocks.push({ lang: codeLang, content: codeBuf.join('\n') });
      }
      flushIndentedCode();
      if (!currentStep.notes || currentStep.notes.length === 0) {
        delete currentStep.notes;
      }
      codeBuf = [];
      codeLang = null;
      inCode = false;
      currentStep = null;
    }

    for (let lineIdx = section.index + 1; lineIdx < section.end; lineIdx += 1) {
      if (isLineNestedUnderSection(lineIdx, section, sections)) {
        continue;
      }

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
        if (!inCode) {
          inCode = true;
          codeLang = line.replace(/^```/, '').trim() || null;
          codeBuf = [];
        } else {
          if (currentStep) {
            currentStep.code_blocks.push({ lang: codeLang, content: codeBuf.join('\n') });
          }
          inCode = false;
          codeBuf = [];
          codeLang = null;
        }
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        continue;
      }

      const checklistStep = line.match(CHECKLIST_STEP_RE);
      if (checklistStep) {
        closeStep();
        currentStep = {
          step_number: steps.length + 1,
          title: normalizeInlineMarkdown(checklistStep[2]),
          done: checklistStep[1].toLowerCase() === 'x',
          code_blocks: [],
          notes: [],
          raw_checkbox_line: line,
        };
        steps.push(currentStep);
        continue;
      }

      if (currentStep && line.trim()) {
        currentStep.notes.push(line.trim());
      }
    }

    closeStep();
    tasks.push({
      task_number: tasks.length + 1,
      task_title: normalizeInlineMarkdown(section.title),
      steps,
      commit_message: null,
      completed: steps.length > 0 && steps.every((step) => step.done),
      raw_markdown: lines.slice(section.index, section.end).join('\n'),
    });
  }

  return tasks;
}

function parsePlanFile(content) {
  const lines = content.split('\n');
  const title = (lines.find((line) => /^#\s+/.test(line)) || '').replace(/^#\s+/, '').trim();
  const goal = (content.match(/\*\*Goal:\*\*\s*([^\n]+)/) || [])[1]?.trim() || null;
  const tech_stack = (content.match(/\*\*Tech Stack:\*\*\s*([^\n]+)/) || [])[1]?.trim() || null;

  const explicitTasks = parseExplicitTaskPlan(lines);
  const tasks = explicitTasks.length > 0 ? explicitTasks : parseChecklistTaskPlan(lines);

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
