'use strict';

const TEMPLATES = {
  decompose: {
    system: `You are a senior software architect performing task decomposition for an automated build system.
Your job is to break a feature request into concrete, ordered sub-tasks that an LLM code generator can execute independently.
Each task must be self-contained with clear inputs and outputs.
Respond ONLY with valid JSON — no markdown, no explanation outside the JSON.`,

    user: `Decompose this feature into implementation tasks.

**Feature:** {{feature_name}}
**Description:** {{feature_description}}
**Working Directory:** {{working_directory}}
**Project Structure:** {{project_structure}}
**Existing Patterns:** {{existing_patterns}}

Respond with a JSON object:
{
  "tasks": [
    {
      "step": "types|data|events|system|tests|wire|other",
      "description": "Detailed task description including exact file paths and what to create/modify",
      "depends_on": ["step names this depends on"],
      "provider_hint": "codex|ollama|deepinfra|null",
      "estimated_complexity": "simple|normal|complex"
    }
  ],
  "reasoning": "Brief explanation of decomposition strategy",
  "confidence": 0.0-1.0
}`,

    schema: {
      type: 'object',
      required: ['tasks'],
      properties: {
        tasks: { type: 'array', items: { type: 'object', required: ['step', 'description', 'depends_on'] } },
        reasoning: { type: 'string' },
        confidence: { type: 'number' },
      },
    },
  },

  diagnose: {
    system: `You are a build system failure analyst. Given a failed task's error output, you diagnose the root cause and recommend a recovery action.
Choose the most specific, actionable recovery. Prefer fixing over retrying. Prefer retrying over escalating.
Respond ONLY with valid JSON — no markdown, no explanation outside the JSON.`,

    user: `Diagnose this task failure and recommend recovery.

**Task:** {{task_description}}
**Provider:** {{provider}}
**Exit Code:** {{exit_code}}
**Retry Count:** {{retry_count}}
**Error Output (last 5KB):**
\`\`\`
{{error_output}}
\`\`\`

Respond with a JSON object:
{
  "action": "retry|fix_task|switch_provider|switch_model|redesign|escalate",
  "reason": "Root cause diagnosis",
  "fix_description": "If action is fix_task, describe exactly what the fix task should do",
  "suggested_provider": "Provider to switch to, if applicable",
  "suggested_model": "Model to switch to, if applicable",
  "timeout_adjustment": 1.0-3.0,
  "confidence": 0.0-1.0
}`,

    schema: {
      type: 'object',
      required: ['action', 'reason', 'confidence'],
      properties: {
        action: { type: 'string', enum: ['retry', 'fix_task', 'switch_provider', 'switch_model', 'redesign', 'escalate'] },
        reason: { type: 'string' },
        fix_description: { type: 'string' },
        suggested_provider: { type: 'string' },
        suggested_model: { type: 'string' },
        timeout_adjustment: { type: 'number' },
        confidence: { type: 'number' },
      },
    },
  },

  review: {
    system: `You are a code review system evaluating LLM-generated code changes. Assess quality, correctness, completeness, and safety.
Focus on: missing implementations (stubs/TODOs), type correctness, test coverage, security issues, and whether the output matches the task requirements.
Respond ONLY with valid JSON — no markdown, no explanation outside the JSON.`,

    user: `Review this completed task output.

**Task:** {{task_description}}
**Task Output:**
\`\`\`
{{task_output}}
\`\`\`

**Validation Results:** {{validation_results}}
**File Changes:** {{file_changes}}
**Build Output:** {{build_output}}

Respond with a JSON object:
{
  "decision": "approve|reject|request_changes",
  "reason": "Overall assessment",
  "issues": [
    {
      "severity": "critical|error|warning|info",
      "file": "affected file path",
      "description": "what's wrong",
      "suggestion": "how to fix it"
    }
  ],
  "quality_score": 0-100,
  "confidence": 0.0-1.0
}`,

    schema: {
      type: 'object',
      required: ['decision', 'reason', 'confidence'],
      properties: {
        decision: { type: 'string', enum: ['approve', 'reject', 'request_changes'] },
        reason: { type: 'string' },
        issues: { type: 'array' },
        quality_score: { type: 'number' },
        confidence: { type: 'number' },
      },
    },
  },
};

function buildPrompt(templateName, variables) {
  const template = TEMPLATES[templateName];
  if (!template) {
    throw new Error(`Unknown template: "${templateName}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
  }
  let userPrompt = template.user;
  userPrompt = userPrompt.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    return variables[key] !== undefined && variables[key] !== null ? String(variables[key]) : '';
  });
  return { system: template.system, user: userPrompt, schema: template.schema };
}

module.exports = { TEMPLATES, buildPrompt };
