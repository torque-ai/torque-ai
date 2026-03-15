"use strict";

const AUDIT_CATEGORIES = {
  security: {
    label: "Security",
    subcategories: {
      "injection.sql": "Detect SQL or query-string injection risks from untrusted data and unsafe query construction.",
      "injection.command": "Detect shell, OS command, or template injection vectors introduced through unsanitized inputs.",
      "injection.xss": "Detect reflected/stored DOM injection points and unsafe HTML/JS rendering paths.",
      auth: "Review authentication checks, session handling, and authorization boundaries for bypasses and privilege escalation.",
      credentials: "Look for credential leakage, weak storage, and insecure handling of tokens, API keys, and secrets.",
      crypto: "Review cryptographic usage for weak algorithms, predictable randomness, or improper key lifecycle handling.",
      dependencies: "Check for unsafe dependency use, unsafe versions, and risky transitive package or supply chain risk.",
    },
    prompt_guidance:
      "Look for untrusted data entering trust boundaries without validation, escaping, or parameterization across queries, shells, HTML sinks, and auth-critical paths. Prioritize identifying concrete exploit surfaces and missing defensive controls that can be fixed in code.",
  },
  "error-handling": {
    label: "Error Handling",
    subcategories: {
      swallowed: "Detect swallowed errors where failures are ignored or hidden behind generic returns.",
      "missing-catch": "Find missing catch blocks around async/await, promise chains, and callback-style error pathways.",
      "silent-failures": "Detect logic that masks failures by returning defaults, partial data, or success signals without explicit error context.",
      "log-levels": "Review logging level selection so failures, warnings, and recoverable conditions are distinguishable.",
      "unhandled-rejections": "Find unhandled promise rejections, process-level error hooks, and rejected async flows without containment.",
    },
    prompt_guidance:
      "Inspect control flow for places where runtime failures can be swallowed, rerouted, or silently ignored. Prioritize error paths where system state changes without explicit error reporting or retry/recovery strategy.",
  },
  concurrency: {
    label: "Concurrency",
    subcategories: {
      "race-conditions": "Detect concurrent reads/writes that can produce ordering bugs or inconsistent outcomes.",
      "read-then-write": "Find non-atomic read-modify-write flows where intermediate state changes can be interleaved.",
      "shared-mutable": "Inspect mutable shared state in async or multi-thread contexts without isolation or locking strategy.",
      "missing-transactions": "Identify multi-step operations that require atomicity but are missing transaction boundaries.",
    },
    prompt_guidance:
      "Look for async scheduling, shared mutable structures, and parallel execution paths that can interleave unpredictably. Flag race windows, lost updates, and missing synchronization around state transitions.",
  },
  "api-surface": {
    label: "API Surface",
    subcategories: {
      "missing-validation": "Detect endpoints and handlers that accept unvalidated or weakly validated input.",
      "unprotected-endpoints": "Find routes or handlers without proper authentication/authorization checks.",
      "missing-rate-limiting": "Detect high-risk endpoints with no throttling, quota checks, or abuse controls.",
      "data-leakage": "Find responses that overexpose sensitive fields, internal metadata, or stack/debug details.",
    },
    prompt_guidance:
      "Inspect public interfaces, route handlers, and integration boundaries for strict input contracts, authorization enforcement, abuse resistance, and safe response shapes.",
  },
  "code-quality": {
    label: "Code Quality",
    subcategories: {
      "dead-code": "Identify unreachable, unused, or obsolete code paths and old branches.",
      duplication: "Detect repeated logic that should be extracted into shared helpers or utilities.",
      complexity: "Find overly complex functions, nested branching, or cyclomatic complexity that hurts maintainability.",
      oversized: "Find giant files/modules or methods that bundle too many responsibilities.",
      "unused-exports": "Detect symbols exported but never imported or used outside tests/mocks.",
    },
    prompt_guidance:
      "Assess maintainability patterns by checking for duplicated implementations, oversized abstractions, and dead logic. Prioritize refactor candidates that improve readability and testability.",
  },
  "data-integrity": {
    label: "Data Integrity",
    subcategories: {
      "missing-fk": "Detect missing foreign-key constraints, referential checks, or relationship integrity validation.",
      "schema-drift": "Find schema usage that bypasses current model contracts or assumes out-of-date assumptions.",
      "unvalidated-writes": "Detect writes that accept malformed, unsafe, or partially validated payloads.",
      "missing-migrations": "Flag schema changes made without migration paths, rollback planning, or version consistency checks.",
    },
    prompt_guidance:
      "Inspect write paths for missing validation, incomplete schema constraints, and unsafe evolution practices. Flag places where data invariants are enforced only by application convention instead of durable constraints.",
  },
  observability: {
    label: "Observability",
    subcategories: {
      "missing-logging": "Detect critical paths without structured logging for failures, retries, or state transitions.",
      "inconsistent-levels": "Find mixed logging semantics where the same signal appears with conflicting severity.",
      "missing-metrics": "Find services missing counters, gauges, or timings needed to detect degradations.",
      "no-health-checks": "Detect the absence of health/readiness probes on high-availability and dependency-dependent code.",
    },
    prompt_guidance:
      "Look for missing or inconsistent telemetry on important state transitions. Prioritize production-impactful paths without logs, metrics, or health signals for diagnosing incidents.",
  },
  config: {
    label: "Config",
    subcategories: {
      "hardcoded-values": "Find hardcoded environment-specific values that should be externalized or parameterized.",
      "missing-env-validation": "Detect unvalidated environment variable usage with unsafe assumptions and missing defaults.",
      "secrets-in-config": "Detect secrets embedded in config files, source literals, or public artifacts.",
      "default-credentials": "Find default usernames/passwords, keys, or tokens that remain in shipped configuration.",
    },
    prompt_guidance:
      "Audit configuration surfaces for secret exposure, missing validation, and accidental hardcoding. Prefer explicit schema checks and environment-safe fallbacks over silent default behavior.",
  },
  performance: {
    label: "Performance",
    subcategories: {
      "n-plus-one": "Detect N+1 query loops, repeated lookups, and redundant round trips in loops.",
      "unbounded-loops": "Find loops or recursion with unbounded growth tied to input size or untrusted counts.",
      "memory-leaks": "Find event-listener accumulation, cache overretention, and object retention after lifecycle completion.",
      "blocking-io": "Detect synchronous I/O operations or CPU-heavy work on request paths.",
      "missing-pagination": "Detect unpaged list endpoints or batch operations that can fetch unbounded datasets.",
      "large-payloads": "Identify large uncompressed payload handling, verbose serialization, or missing streaming/backpressure.",
    },
    prompt_guidance:
      "Scan hot paths for unnecessary I/O, repeated database calls, and memory or latency amplification patterns. Emphasize mitigations that reduce asymptotic cost and protect tail latency.",
  },
  testing: {
    label: "Testing",
    subcategories: {
      "missing-coverage": "Detect modules, files, or conditions with low or missing unit/integration coverage.",
      "brittle-tests": "Find tests that depend on implementation details or fragile timing assumptions.",
      "missing-edge-cases": "Detect boundary conditions, malformed payloads, and fault scenarios not covered by test suites.",
      isolation: "Find tests that share global state, mutate fixtures, or depend on run order.",
      "mocked-unverified": "Detect mocked behavior without assertions that verifies the expected external contract.",
    },
    prompt_guidance:
      "Focus on confidence gaps: missing boundaries, brittle assumptions, and incomplete negative-case coverage. Prioritize tests that validate user-visible behavior and fault handling, not just happy paths.",
  },
  documentation: {
    label: "Documentation",
    subcategories: {
      "missing-api-docs": "Detect public interfaces lacking API-level usage notes, examples, or contracts.",
      "outdated-comments": "Find stale comments that conflict with current behavior or implementation.",
      "misleading-names": "Find identifiers whose names imply behavior different from actual semantics.",
      "undocumented-side-effects": "Find hidden mutations, side effects, or background jobs not documented at the callsite level.",
    },
    prompt_guidance:
      "Review naming, docs, and comments for semantic accuracy. Flag misleading documentation and behavior gaps that would block safe maintainer decisions.",
  },
  architecture: {
    label: "Architecture",
    subcategories: {
      "circular-deps": "Detect dependency cycles that can create fragile initialization and load-order bugs.",
      "tight-coupling": "Find direct dependencies that prevent modular replacement and inhibit test boundaries.",
      "god-files": "Find files that combine multiple domains and break single-responsibility boundaries.",
      "layer-violations": "Find cross-layer data flow that bypasses intended boundaries or abstractions.",
      "missing-abstractions": "Detect repeated direct integrations where interface/adapter layers should isolate changing dependencies.",
    },
    prompt_guidance:
      "Inspect module boundaries and responsibilities for isolation, layering, and replaceability concerns. Highlight structural risks from cycles, god modules, or direct coupling across abstraction boundaries.",
  },
  compatibility: {
    label: "Compatibility",
    subcategories: {
      "deprecated-apis": "Find deprecated API usage that increases upgrade risk.",
      "platform-assumptions": "Detect platform-specific assumptions in paths expected to run across environments.",
      "missing-polyfills": "Find features used without compatibility shims where needed.",
      "version-pinning": "Detect brittle dependency pins that prevent security updates or patch adoption.",
    },
    prompt_guidance:
      "Assess platform and dependency assumptions across runtime and client environments. Look for brittle choices that block upgrades or introduce environment-specific breakage.",
  },
  accessibility: {
    label: "Accessibility",
    subcategories: {
      "missing-aria": "Detect UI elements rendered without required ARIA roles, labels, or descriptions.",
      "keyboard-nav": "Find interactive surfaces that cannot be reached or operated via keyboard-only workflows.",
      "color-contrast": "Detect UI color and contrast patterns that impede readability for visual accessibility.",
      "screen-reader": "Find markup and semantics that limit comprehension by screen reader technologies.",
    },
    prompt_guidance:
      "Evaluate interface output and interaction semantics for inclusive usability. Prioritize semantic roles, keyboard flows, and assistive-technology-readable content.",
  },
  i18n: {
    label: "Internationalization",
    subcategories: {
      "hardcoded-strings": "Detect user-facing text literals that bypass localization/message catalogs.",
      "locale-assumptions": "Find hardcoded locale assumptions and locale-insensitive formatting assumptions.",
      "date-formatting": "Find date, time, and locale formatting implemented without locale-aware APIs.",
      encoding: "Find inconsistent text encodings, decoding assumptions, or encoding-loss paths for user content.",
    },
    prompt_guidance:
      "Review user-facing output for localization correctness and locale-sensitive behavior. Flag hardcoded strings and formatting assumptions that block multi-locale deployments.",
  },
};

const CORE_CATEGORIES = [
  "security",
  "error-handling",
  "code-quality",
  "architecture",
  "performance",
  "concurrency",
];

const CONDITIONAL_CATEGORIES = {
  accessibility: [".jsx", ".tsx", ".html", ".vue", ".svelte", ".xaml"],
  i18n: [".jsx", ".tsx", ".html", ".vue", ".svelte"],
};

function getAllCategories() {
  return Object.keys(AUDIT_CATEGORIES);
}

function getCategory(categoryName) {
  const category = AUDIT_CATEGORIES[categoryName];
  if (!category) {
    return null;
  }
  return {
    label: category.label,
    prompt_guidance: category.prompt_guidance,
    subcategories: { ...category.subcategories },
  };
}

function getSubcategories(categoryName) {
  const category = AUDIT_CATEGORIES[categoryName];
  if (!category || !category.subcategories) {
    return [];
  }
  return Object.keys(category.subcategories);
}

function getCoreCategories() {
  return [...CORE_CATEGORIES];
}

function normalizeSelectionArray(selections) {
  if (!Array.isArray(selections)) {
    if (typeof selections === "string") {
      return [selections];
    }
    return [];
  }
  return selections;
}

function filterCategories(selections) {
  const normalizedSelections = normalizeSelectionArray(selections);
  const selectedCategories = new Set();
  const selectedSubcategories = new Map();
  const availableCategories = AUDIT_CATEGORIES;

  for (const selection of normalizedSelections) {
    if (typeof selection !== "string") {
      continue;
    }
    const trimmed = selection.trim();
    if (!trimmed) {
      continue;
    }

    if (availableCategories[trimmed]) {
      selectedCategories.add(trimmed);
      continue;
    }

    const parts = trimmed.split(".");
    if (parts.length < 2) {
      continue;
    }
    const categoryName = parts[0];
    const subcategoryName = parts.slice(1).join(".");
    const category = availableCategories[categoryName];
    if (!category || !category.subcategories) {
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(category.subcategories, subcategoryName)) {
      continue;
    }

    if (selectedCategories.has(categoryName)) {
      continue;
    }

    const active = selectedSubcategories.get(categoryName) || new Set();
    active.add(subcategoryName);
    selectedSubcategories.set(categoryName, active);
  }

  if (!selectedCategories.size && !selectedSubcategories.size) {
    return {};
  }

  const result = {};
  for (const categoryName of selectedCategories) {
    result[categoryName] = getCategory(categoryName);
  }

  for (const [categoryName, subcategories] of selectedSubcategories.entries()) {
    if (selectedCategories.has(categoryName)) {
      continue;
    }
    const category = availableCategories[categoryName];
    const pickedSubcategories = {};
    for (const subcategoryName of subcategories) {
      pickedSubcategories[subcategoryName] = category.subcategories[subcategoryName];
    }
    result[categoryName] = {
      label: category.label,
      prompt_guidance: category.prompt_guidance,
      subcategories: pickedSubcategories,
    };
  }

  return result;
}

function normalizeExtensions(fileExtensions) {
  if (!fileExtensions) {
    return [];
  }

  const list = Array.isArray(fileExtensions) ? fileExtensions : [fileExtensions];
  const normalized = new Set();
  for (const extension of list) {
    if (typeof extension !== "string") {
      continue;
    }
    const trimmed = extension.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    normalized.add(trimmed.startsWith(".") ? trimmed : `.${trimmed}`);
  }
  return Array.from(normalized);
}

function getRelevantCategories(fileExtensions) {
  const detectedExtensions = normalizeExtensions(fileExtensions);
  const result = {};
  const conditional = CONDITIONAL_CATEGORIES;

  const isRelevantConditionalCategory = (categoryName) => {
    const matchingExtensions = conditional[categoryName];
    if (!matchingExtensions) {
      return false;
    }
    for (const extension of detectedExtensions) {
      if (matchingExtensions.includes(extension)) {
        return true;
      }
    }
    return false;
  };

  for (const categoryName of Object.keys(AUDIT_CATEGORIES)) {
    if (CONDITIONAL_CATEGORIES[categoryName] && !isRelevantConditionalCategory(categoryName)) {
      continue;
    }
    result[categoryName] = getCategory(categoryName);
  }

  return result;
}

module.exports = {
  AUDIT_CATEGORIES,
  CORE_CATEGORIES,
  CONDITIONAL_CATEGORIES,
  getAllCategories,
  getCategory,
  getSubcategories,
  getCoreCategories,
  filterCategories,
  getRelevantCategories,
};
