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

  scout: {
    system: `You are a codebase analyst performing reconnaissance for an automated task distribution system.
Your job is to analyze a working directory, classify files by transformation pattern, and produce structured signals that allow work to begin BEFORE your analysis is complete.
Do NOT modify any files. Your output is analysis only.
You MUST output signals in two phases — pattern discovery first, then file classification in batches.`,

    user: `Analyze the following scope in two phases.

**Scope:** {{scope}}
**Working Directory:** {{working_directory}}
**File List:** {{file_list}}

## Phase 1: Pattern Discovery
1. Read 10-20 candidate files to understand the transformation scope
2. Group files by the transformation they need (same change = same pattern)
3. For EACH pattern, pick one representative file and produce BOTH the complete file content BEFORE transformation and the complete file content AFTER transformation
4. Identify any shared files that multiple patterns depend on (e.g., a helper class that needs to be created first)
5. Output a __PATTERNS_READY__ signal with your findings

## Phase 2: File Classification
6. Continue scanning the remaining candidate files
7. For every 5-10 files classified, output a __SCOUT_DISCOVERY__ signal with the batch
8. When all files are scanned, output a __SCOUT_COMPLETE__ signal

## CRITICAL: Output signals as you go, NOT all at the end.

### Example output format:

Analyzing files in src/App/Sections...
Found 3 patterns across first 15 files.

__PATTERNS_READY__
{
  "patterns": [
    {
      "id": "single-field-validation",
      "description": "Dialog with one required TextBox check",
      "transformation": "Replace inline check with ValidationHelper.ValidateRequired()",
      "exemplar_files": ["src/App/ExampleDialog.xaml.cs"],
      "exemplar_diff": "- old code\\n+ new code",
      "exemplar_before": "using System.Windows;\\n\\npublic partial class ExampleDialog : Window\\n{\\n    public ExampleDialog() { InitializeComponent(); }\\n\\n    private void OnSave(object sender, RoutedEventArgs e)\\n    {\\n        if (string.IsNullOrWhiteSpace(NameBox.Text))\\n        {\\n            ErrorMessage.Text = \\"Name is required.\\";\\n            ErrorMessage.Visibility = Visibility.Visible;\\n            return;\\n        }\\n        ErrorMessage.Visibility = Visibility.Collapsed;\\n        DialogResult = true;\\n    }\\n}",
      "exemplar_after": "using System.Windows;\\nusing App.Shared;\\n\\npublic partial class ExampleDialog : Window\\n{\\n    public ExampleDialog() { InitializeComponent(); }\\n\\n    private void OnSave(object sender, RoutedEventArgs e)\\n    {\\n        if (!ValidationHelper.ValidateRequired(ErrorMessage, NameBox, \\"Name is required.\\")) return;\\n        ValidationHelper.ClearError(ErrorMessage);\\n        DialogResult = true;\\n    }\\n}",
      "file_count": 15
    }
  ],
  "shared_dependencies": [
    { "file": "src/App/Shared/ValidationHelper.cs", "change": "Create static helper class" }
  ],
  "total_candidates": 50,
  "scanned_so_far": 15
}
__PATTERNS_READY_END__

Continuing classification... scanning files 16-30.

__SCOUT_DISCOVERY__
{
  "manifest_chunk": [
    { "file": "src/App/Sections/FooDialog.xaml.cs", "pattern": "single-field-validation" },
    { "file": "src/App/Sections/BarDialog.xaml.cs", "pattern": "single-field-validation" }
  ],
  "scanned_so_far": 30,
  "total_candidates": 50
}
__SCOUT_DISCOVERY_END__

Scanning files 31-50...

__SCOUT_DISCOVERY__
{
  "manifest_chunk": [
    { "file": "src/App/Sections/BazDialog.xaml.cs", "pattern": "single-field-validation" }
  ],
  "scanned_so_far": 50,
  "total_candidates": 50
}
__SCOUT_DISCOVERY_END__

__SCOUT_COMPLETE__
{
  "total_classified": 18,
  "total_skipped": 32,
  "scanned_so_far": 50,
  "total_candidates": 50
}
__SCOUT_COMPLETE_END__

Output the signal blocks directly with no markdown fences around them.`,

    schema: {
      type: 'object',
      required: ['patterns'],
      properties: {
        patterns: { type: 'array', items: { type: 'object', required: ['id', 'description', 'transformation', 'exemplar_files', 'exemplar_diff', 'file_count'] } },
        shared_dependencies: { type: 'array' },
        total_candidates: { type: 'number' },
        scanned_so_far: { type: 'number' },
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
