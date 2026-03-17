'use strict';

const CATEGORIES = [
  'security', 'xaml_wpf', 'architectural', 'reasoning',
  'large_code_gen', 'documentation', 'simple_generation',
  'targeted_file_edit', 'default',
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
  default: {
    displayName: 'Default (catch-all)',
    description: 'Everything that does not match another category',
    keywords: '',
  },
};

const SECURITY_RE = /\b(security|vulnerab|audit|penetrat|auth|encrypt|credential|secret|injection|xss|csrf|owasp)\b/i;
const XAML_KEYWORD_RE = /\b(xaml|wpf|uwp|maui|avalonia)\b/i;
const ARCHITECTURAL_RE = /\b(architect|refactor.*multi|redesign|migration strategy|system design)\b/i;
const REASONING_RE = /\b(reason|analyze|debug complex|root cause|review.*entire|explain.*architecture|deep.*analysis)\b/i;
const LARGE_CODE_RE = /\b(implement.*system|build.*feature|create.*module|complex.*generation|multi.*file.*refactor)\b/i;
const DOCS_RE = /\b(document|explain|summarize|describe|comment|readme|changelog|jsdoc|docstring)\b/i;
const SIMPLE_GEN_RE = /\b(commit message|boilerplate|scaffold|template|stub)\b/i;

const FILE_REF_RE = /[\w\-./\\]+\.\w{1,5}\b/;

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
const SPECIFIC_TARGET_RE = /\b(the\s+\w+\s+(function|method|class|variable|property|getter|setter|constructor))\b/i;
const STRUCTURAL_TARGET_RE = /\b(add|insert|append)\b.{0,30}\b(import|export|field|property|method|function|getter|setter|constructor|decorator|attribute|type|param|return)\b/i;

function hasXamlFile(files) {
  return Array.isArray(files) && files.some(f => /\.xaml$/i.test(f));
}

function isTargetedFileEdit(desc) {
  if (!FILE_REF_RE.test(desc)) return false;

  // Structural edits (fix/update/remove/add test/add logging) — file reference is sufficient
  if (STRUCTURAL_EDIT_PATTERNS.some(p => p.test(desc))) return true;
  if (STRUCTURAL_TARGET_RE.test(desc)) return true;

  // Annotation edits (jsdoc/comment/docstring) — require a specific code element reference
  // to distinguish "Add JSDoc to the getUser function in file.ts" (targeted)
  // from "Add JSDoc comments to utils.js" (documentation)
  if (ANNOTATION_EDIT_PATTERNS.some(p => p.test(desc)) && SPECIFIC_TARGET_RE.test(desc)) return true;

  return false;
}

function classify(taskDescription, files) {
  const desc = taskDescription || '';
  if (!desc) return 'default';

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
