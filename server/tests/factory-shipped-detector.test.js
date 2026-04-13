'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createShippedDetector } = require('../factory/shipped-detector');

const FILE_REFERENCES = [
  'server/factory/alpha.js',
  'server/factory/beta.ts',
  'server/db/schema.sql',
  'dashboard/src/components/telemetry.tsx',
  'dashboard/src/styles/panel.css',
  'docs/superpowers/factory-plan.md',
  'docs/telemetry/summary.json',
  'scripts/factory/reconcile.js',
  'tests/factory/shipped-detector.js',
  'server/routes/intake.html',
];

function createPlanContent(title, fileReferences) {
  return [
    `# ${title}`,
    '',
    '## Task 1: ship it',
    ...fileReferences.map((filePath) => `- [ ] Update ${filePath}`),
  ].join('\n');
}

function writeRepoFiles(repoRoot, fileReferences) {
  for (const relativePath of fileReferences) {
    const absolutePath = path.join(repoRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, '// exists\n');
  }
}

describe('factory shipped detector', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-shipped-detector-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('marks a plan as shipped with high confidence when files exist and commit subjects strongly overlap', () => {
    writeRepoFiles(repoRoot, FILE_REFERENCES);
    const detector = createShippedDetector({
      repoRoot,
      runGitLog: vi.fn().mockReturnValue([
        'feat(factory): queue scheduler telemetry pipeline',
        'fix(queue): scheduler rollout cleanup',
      ]),
    });

    const result = detector.detectShipped({
      title: 'Queue Scheduler Telemetry Rollout Plan',
      content: createPlanContent('Queue Scheduler Telemetry Rollout Plan', FILE_REFERENCES),
    });

    expect(result.shipped).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.signals.file_existence_ratio).toBe(1);
    expect(result.signals.git_match_score).toBeCloseTo(0.75, 5);
    expect(result.signals.commit_keyword_hit).toBe(true);
  });

  it('stays open with low confidence when few referenced files exist and git finds nothing relevant', () => {
    writeRepoFiles(repoRoot, FILE_REFERENCES.slice(0, 2));
    const detector = createShippedDetector({
      repoRoot,
      runGitLog: vi.fn().mockReturnValue([]),
    });

    const result = detector.detectShipped({
      title: 'Planner Cache Hydration Plan',
      content: createPlanContent('Planner Cache Hydration Plan', FILE_REFERENCES),
    });

    expect(result.shipped).toBe(false);
    expect(result.confidence).toBe('low');
    expect(result.signals.file_existence_ratio).toBe(0.2);
    expect(result.signals.git_match_score).toBe(0);
  });

  it('does not mark a plan shipped on file existence alone without git corroboration', () => {
    writeRepoFiles(repoRoot, FILE_REFERENCES.slice(0, 9));
    const detector = createShippedDetector({
      repoRoot,
      runGitLog: vi.fn().mockReturnValue([]),
    });

    const result = detector.detectShipped({
      title: 'Routing Snapshot Refresh Plan',
      content: createPlanContent('Routing Snapshot Refresh Plan', FILE_REFERENCES),
    });

    expect(result.shipped).toBe(false);
    expect(result.confidence).toBe('low');
    expect(result.signals.file_existence_ratio).toBe(0.9);
  });

  it('returns a null file existence ratio when the plan references no files', () => {
    const detector = createShippedDetector({
      repoRoot,
      runGitLog: vi.fn().mockReturnValue([]),
    });

    const result = detector.detectShipped({
      title: 'Alert Queue Governance Plan',
      content: '# Alert Queue Governance Plan\n\n## Task 1: audit\n- [ ] Decide next step\n',
    });

    expect(result.shipped).toBe(false);
    expect(result.confidence).toBe('low');
    expect(result.signals.file_existence_ratio).toBeNull();
  });

  it('filters title stopwords before building the git grep pattern', () => {
    writeRepoFiles(repoRoot, FILE_REFERENCES.slice(0, 1));
    const runGitLog = vi.fn().mockReturnValue([]);
    const detector = createShippedDetector({ repoRoot, runGitLog });

    const result = detector.detectShipped({
      title: 'Phase 11 Implementation Plan for Queue Scheduler',
      content: createPlanContent('Phase 11 Implementation Plan for Queue Scheduler', FILE_REFERENCES.slice(0, 1)),
    });

    expect(runGitLog).toHaveBeenCalledWith({ grep: 'queue|scheduler', limit: 50 });
    expect(result.signals.title_tokens).toEqual(['queue', 'scheduler']);
    expect(result.shipped).toBe(false);
  });
});
