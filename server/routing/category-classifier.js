/**
 * Task category classifier for routing template resolution.
 * Maps task descriptions and file lists to routing categories.
 */

'use strict';

const CATEGORIES = [
  'security', 'xaml_wpf', 'architectural', 'reasoning',
  'large_code_gen', 'documentation', 'simple_generation',
  'targeted_file_edit', 'plan_generation', 'default',
];

const CATEGORY_META = {
  security: {
    displayName: 'Security',
    description: 'Authentication, encryption, vulnerability scanning, OWASP',
    keywords: 'auth, encrypt, vulnerability, injection, xss, csrf',
  },
  xaml_wpf: {
    displayName: 'XAML / WPF',
    description: 'XAML files, WPF, UWP, MAUI, Avalonia',
    keywords: '.xaml files, WPF, MAUI, Avalonia',
  },
  architectural: {
    displayName: 'Architectural',
    description: 'System design, refactoring, migration strategy',
    keywords: 'architect, refactor, redesign, system design',
  },
  reasoning: {
    displayName: 'Reasoning',
    description: 'Complex analysis, debugging, root cause investigation',
    keywords: 'analyze, debug, root cause, deep analysis',
  },
  large_code_gen: {
    displayName: 'Large Code Gen',
    description: 'Implementing systems, building features, creating modules',
    keywords: 'implement system, build feature, create module',
  },
  documentation: {
    displayName: 'Documentation',
    description: 'Writing docs, READMEs, JSDoc, explanations',
    keywords: 'document, explain, summarize, readme, jsdoc',
  },
  simple_generation: {
    displayName: 'Simple Generation',
    description: 'Commit messages, boilerplate, scaffolding',
    keywords: 'commit message, boilerplate, scaffold, template',
  },
  targeted_file_edit: {
    displayName: 'Targeted File Edits',
    description: 'Fixing, updating, or modifying specific files',
    keywords: 'fix, update, modify + specific file reference',
  },
  plan_generation: {
    displayName: 'Plan Generation',
    description: 'Generating structured execution plans (markdown task lists) from a work item description. Pure text output — must route to text-gen providers, not action-agents.',
    keywords: 'execution plan, ## Task N:, plan generation, factory planning',
  },
  default: {
    displayName: 'Default (catch-all)',
    description: 'Everything that does not match another category',
    keywords: '',
  },
};

// Plan generation has very strong signals — the factory's prompt explicitly
// says "You are generating an execution plan" and requires "## Task N:" grammar.
// Must match before any file-reference or documentation pattern, since plan
// prompts mention file paths and writing markdown.
const PLAN_GENERATION_RE = /\b(generating an execution plan|execution plan for (a )?(single )?(factory )?work item|generate.*execution plan|## Task N:|auto-generated from work_item|Architect for a software factory|prioritize work items based on project health)\b/i;

// Bare `auth` removed — matches `auth.js` in filenames, wrongly routing
// "Write unit tests for auth.js" to security instead of targeted_file_edit.
// Real auth-security contexts match other keywords (injection, vulnerab, credential, encrypt, owasp).
const SECURITY_RE = /\b(security|vulnerab|audit|penetrat|encrypt|credential|secret|injection|xss|csrf|owasp)\b/i;
const XAML_KEYWORD_RE = /\b(xaml|wpf|uwp|maui|avalonia)\b/i;
const ARCHITECTURAL_RE = /\b(architect|refactor.*multi|redesign|migration strategy|system design)\b/i;
const REASONING_RE = /\b(reasoning|reasoned|analyze|debug complex|root cause|review.*entire|explain.*architecture|deep.*analysis)\b/i;
const LARGE_CODE_RE = /\b(implement.*system|build.*feature|create.*module|complex.*generation|multi.*file.*refactor)\b/i;
const DOCS_RE = /\b(document|explain|summarize|comment|readme|changelog|jsdoc|docstring)\b/i;
const SIMPLE_GEN_RE = /\b(commit message|boilerplate|scaffold|template|stub)\b/i;

const FILE_REF_RE = /(?:[\w-]+[/\\][\w\-.]+\.\w{1,5}|[\w-]+\.(?:js|ts|jsx|tsx|cs|py|java|go|rs|json|yaml|yml|xml|md|txt|css|html|sh|rb|php|c|h|cpp|hpp))\b/i;

// Structural edit patterns — file reference alone is sufficient
const STRUCTURAL_EDIT_PATTERNS = [
  /\b(fix|update|change|modify|replace|rename|move)\b.{0,40}\b(in|at|on|to)\b/i,
  /\b(remove|delete)\b.{0,30}\b(unused|dead|deprecated|obsolete|import|line|method|function|comment)\b/i,
  /\b(add|write|create)\b.{0,20}\b(test|spec)\b.{0,20}\b(for|to|in)\b/i,
  /\badd\b.{0,15}\b(logging|log statement|console\.log)\b/i,
  /\b(add|update)\b.{0,20}\b(error handling|validation|null check|type guard)\b/i,
];

// Annotation patterns — require a specific code element (function, class, method name) to
// distinguish targeted edits from general documentation tasks
const ANNOTATION_EDIT_PATTERNS = [
  /\b(add|insert|append)\b.{0,30}\b(jsdoc|comment|docstring|annotation)\b/i,
  /\bjsdoc\b|\bdocstring\b|\bxml doc\b|\btsdoc\b/i,
];

// Detects references to specific code elements (function/method/class names, etc.)
// Matches: "the getUser function", "the Account class", "the Account entity class",
//          "the class declaration", "above the class"
const SPECIFIC_TARGET_RE = /\b(the\s+\w+(\s+\w+)?\s+(function|method|class|variable|property|getter|setter|constructor|declaration|definition|interface|struct|enum)|(above|before|after|below)\s+the\s+(class|function|method|interface|struct|enum|namespace))\b/i;
const STRUCTURAL_TARGET_RE = /\b(add|insert|append)\b.{0,30}\b(import|export|field|property|method|function|getter|setter|constructor|decorator|attribute|type|param|return)\b/i;

// Explicit deep file path with edit verb — must contain a directory separator to distinguish
// "in src/foo/Bar.cs" (targeted) from "to utils.js" (documentation)
const EXPLICIT_FILE_PATH_RE = /\b(in|to|at|on)\s+[\w\-./\\]*[/\\][\w\-./\\]+\.\w{1,5}\b/i;

function hasXamlFile(files) {
  return Array.isArray(files) && files.some(f => /\.xaml$/i.test(f));
}

function isTargetedFileEdit(desc) {
  if (!FILE_REF_RE.test(desc)) return false;

  // Structural edits (fix/update/remove/add test/add logging) — file reference is sufficient
  if (STRUCTURAL_EDIT_PATTERNS.some(p => p.test(desc))) return true;
  if (STRUCTURAL_TARGET_RE.test(desc)) return true;

  // Annotation edits (jsdoc/comment/docstring) — require either a specific code element
  // reference OR an explicit file path to distinguish targeted edits from general documentation.
  // "Add JSDoc to the getUser function in file.ts" → targeted (specific target)
  // "Add XML doc comment above the class declaration in src/Account.cs" → targeted (specific target + file path)
  // "Add JSDoc comments to utils.js" → documentation (no specific target, short path)
  if (ANNOTATION_EDIT_PATTERNS.some(p => p.test(desc))) {
    if (SPECIFIC_TARGET_RE.test(desc)) return true;
    if (EXPLICIT_FILE_PATH_RE.test(desc)) return true;
  }

  return false;
}

function classify(taskDescription, files) {
  const desc = taskDescription || '';
  if (!desc) return 'default';

  // Plan generation must win over every other pattern: the prompt mentions
  // security-like words ("auth"), file paths, and markdown docs, which would
  // otherwise drag it into the wrong categories.
  if (PLAN_GENERATION_RE.test(desc)) return 'plan_generation';

  if (SECURITY_RE.test(desc)) return 'security';
  if (XAML_KEYWORD_RE.test(desc) || hasXamlFile(files)) return 'xaml_wpf';
  if (ARCHITECTURAL_RE.test(desc)) return 'architectural';
  if (REASONING_RE.test(desc)) return 'reasoning';
  if (LARGE_CODE_RE.test(desc)) return 'large_code_gen';
  if (isTargetedFileEdit(desc)) return 'targeted_file_edit';
  if (DOCS_RE.test(desc)) return 'documentation';
  if (SIMPLE_GEN_RE.test(desc)) return 'simple_generation';

  return 'default';
}

function getCategories() {
  return CATEGORIES.map(key => ({
    key,
    ...CATEGORY_META[key],
  }));
}

module.exports = { classify, getCategories, CATEGORIES };
