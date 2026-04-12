'use strict';

const fs = require('fs');
const path = require('path');

const JSX_FILE_RE = /\.(jsx|tsx)$/i;
const TEST_FILE_RE = /(^|[\\/])__tests__([\\/]|$)|\.(test|spec)\.(jsx|tsx)$/i;
const EMPTY_STATE_RE = /(no\s+\w+\s+yet|welcome to|get started|nothing here|empty)/i;
const LOADING_STATE_RE = /(animate-pulse|<Skeleton|isLoading|loading\s*\?|Spinner)/i;
const ERROR_BOUNDARY_RE = /(ErrorBoundary|componentDidCatch|getDerivedStateFromError)/i;
const TOAST_NOTIFICATION_RE = /(toast|notify|<Toast|<Notification|<Snackbar)/i;
const ARIA_ATTR_RE = /aria-[a-z]+=/g;
const SEMANTIC_HTML_RE = /(<main|<nav|<header|<footer|<button|<section|<article|role=)/g;

function normalizeRelative(projectPath, filePath) {
  return path.relative(projectPath, filePath).split(path.sep).join('/');
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function ratio(part, total) {
  return total > 0 ? part / total : 0;
}

function walkUiFiles(dirPath) {
  const files = [];
  if (!fs.existsSync(dirPath)) return files;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkUiFiles(fullPath));
      continue;
    }
    if (entry.isFile() && JSX_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function analyzeViewContent(content) {
  return {
    emptyState: EMPTY_STATE_RE.test(content),
    loadingState: LOADING_STATE_RE.test(content),
    errorBoundary: ERROR_BOUNDARY_RE.test(content),
    toastNotification: TOAST_NOTIFICATION_RE.test(content),
    ariaAttrs: (content.match(ARIA_ATTR_RE) || []).length,
    semanticHtml: (content.match(SEMANTIC_HTML_RE) || []).length,
  };
}

function score(projectPath, scanReport, findingsDir) {
  void scanReport;
  void findingsDir;

  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    return {
      score: 50,
      details: { source: 'code_signal_analysis', reason: 'no_project_path' },
      findings: [
        {
          severity: 'low',
          title: 'No project path was provided for dashboard UI signal analysis',
          file: null,
        },
      ],
    };
  }

  try {
    const viewsDir = path.join(projectPath, 'dashboard', 'src', 'views');
    const componentsDir = path.join(projectPath, 'dashboard', 'src', 'components');
    const hasViewsDir = fs.existsSync(viewsDir);
    const hasComponentsDir = fs.existsSync(componentsDir);

    if (!hasViewsDir && !hasComponentsDir) {
      return {
        score: 50,
        details: { source: 'code_signal_analysis', reason: 'no_dashboard_dir' },
        findings: [
          {
            severity: 'low',
            title: 'No dashboard/src views or components directory found',
            file: null,
          },
        ],
      };
    }

    const viewFiles = walkUiFiles(viewsDir);
    const componentFiles = walkUiFiles(componentsDir);
    const viewSignals = [];

    for (const filePath of viewFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      viewSignals.push({
        file: normalizeRelative(projectPath, filePath),
        ...analyzeViewContent(content),
      });
    }

    for (const filePath of componentFiles) {
      fs.readFileSync(filePath, 'utf8');
    }

    const totalViews = viewSignals.length;
    const emptyStateCount = viewSignals.filter(view => view.emptyState).length;
    const loadingStateCount = viewSignals.filter(view => view.loadingState).length;
    const errorBoundaryCount = viewSignals.filter(view => view.errorBoundary).length;
    const toastCount = viewSignals.filter(view => view.toastNotification).length;
    const errorHandlingCount = viewSignals.filter(
      view => view.errorBoundary || view.toastNotification
    ).length;
    const totalAria = viewSignals.reduce((sum, view) => sum + view.ariaAttrs, 0);
    const totalSemantic = viewSignals.reduce((sum, view) => sum + view.semanticHtml, 0);

    const emptyStateCoverage = ratio(emptyStateCount, totalViews);
    const loadingStateCoverage = ratio(loadingStateCount, totalViews);
    const errorBoundaryCoverage = ratio(errorBoundaryCount, totalViews);
    const toastCoverage = ratio(toastCount, totalViews);
    const errorHandlingCoverage = ratio(errorHandlingCount, totalViews);
    const avgAria = totalViews > 0 ? totalAria / totalViews : 0;
    const avgSemantic = totalViews > 0 ? totalSemantic / totalViews : 0;

    let computedScore = 30;
    computedScore += 20 * emptyStateCoverage;
    computedScore += 15 * loadingStateCoverage;
    computedScore += 15 * errorHandlingCoverage;
    if (avgAria >= 2) computedScore += 10;
    else if (avgAria >= 1) computedScore += 5;
    if (avgSemantic >= 3) computedScore += 10;
    else if (avgSemantic >= 1) computedScore += 5;

    const findings = [];
    const categoryCoverage = [
      {
        key: 'loading_state',
        label: 'loading state',
        coverage: loadingStateCoverage,
      },
      {
        key: 'error_boundary',
        label: 'error boundary',
        coverage: errorBoundaryCoverage,
      },
      {
        key: 'toast_notification',
        label: 'toast notification',
        coverage: toastCoverage,
      },
      {
        key: 'empty_state',
        label: 'empty state',
        coverage: emptyStateCoverage,
      },
    ].sort((left, right) => left.coverage - right.coverage);

    if (categoryCoverage[0] && categoryCoverage[0].coverage < 0.4) {
      findings.push({
        severity: 'medium',
        title: `Dashboard view coverage is weak for ${categoryCoverage[0].label} signals`,
        file: null,
      });
    }

    if (totalViews >= 3) {
      for (const view of viewSignals) {
        if (!view.emptyState && findings.length < 5) {
          findings.push({
            severity: 'low',
            title: `View ${path.basename(view.file)} has no empty-state handling`,
            file: view.file,
          });
        }
      }
    }

    return {
      score: clampScore(computedScore),
      details: {
        source: 'code_signal_analysis',
        viewsScanned: totalViews,
        componentsScanned: componentFiles.length,
        coverage: {
          emptyState: emptyStateCoverage,
          loadingState: loadingStateCoverage,
          errorBoundary: errorBoundaryCoverage,
          toastNotification: toastCoverage,
        },
        errorHandlingCoverage,
        avgAria,
        avgSemantic,
      },
      findings: findings.slice(0, 5),
    };
  } catch (err) {
    return {
      score: 50,
      details: {
        source: 'code_signal_analysis',
        reason: 'scan_error',
        error: err.message,
      },
      findings: [],
    };
  }
}

module.exports = { score };
