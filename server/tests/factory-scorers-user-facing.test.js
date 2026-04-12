'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { score } = require('../factory/scorers/user-facing');

describe('user-facing scorer', () => {
  let tempDir;

  function writeFile(relativePath, content) {
    const filePath = path.join(tempDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-test-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('high-score path: views with rich UX signals', () => {
    const richView = `
      export default function View() {
        return (
          <main aria-label="x">
            <section>
              <article>
                <header>No items yet</header>
                <button onClick={() => toast('Saved')}>Open</button>
                <div className="animate-pulse">Loading</div>
                <ErrorBoundary />
              </article>
            </section>
          </main>
        );
      }
    `;

    writeFile('dashboard/src/views/Home.jsx', richView);
    writeFile('dashboard/src/views/Profile.jsx', richView);
    writeFile('dashboard/src/views/Tasks.jsx', richView);

    const result = score(tempDir, {}, null);

    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.details.source).toBe('code_signal_analysis');
    expect(result.details.viewsScanned).toBe(3);
    expect(result.details.coverage).toBeDefined();
  });

  test('low-score path: views with no signals', () => {
    writeFile('dashboard/src/views/Home.jsx', 'export default function Home() { return <div>Home</div>; }');
    writeFile('dashboard/src/views/Profile.jsx', 'export default function Profile() { return <div>Profile</div>; }');
    writeFile('dashboard/src/views/Tasks.jsx', 'export default function Tasks() { return <div>Tasks</div>; }');

    const result = score(tempDir, {}, null);

    expect(result.score).toBeLessThanOrEqual(55);
    expect(result.findings.some((finding) => /empty-state handling/i.test(finding.title))).toBe(true);
  });

  test('edge case: missing projectPath', () => {
    const nullResult = score(null, {}, null);
    const emptyResult = score('', {}, null);

    for (const result of [nullResult, emptyResult]) {
      expect(result.score).toBe(50);
      expect(result.details.reason).toBe('no_project_path');
    }
  });

  test('edge case: no dashboard dir', () => {
    const result = score(tempDir, {}, null);

    expect(result.score).toBe(50);
    expect(result.details.reason).toBe('no_dashboard_dir');
  });

  test('clamp: score stays in [0,100]', () => {
    const repeatedSignals = Array.from({ length: 10 }, () => `
      <main aria-label="x">
        <section>
          <article>
            <button>No items yet</button>
            <div className="animate-pulse">Loading</div>
            <ErrorBoundary />
            {toast('Saved')}
          </article>
        </section>
      </main>
    `).join('\n');

    writeFile(
      'dashboard/src/views/Rich.jsx',
      `export default function Rich() { return <>${repeatedSignals}</>; }`,
    );

    const result = score(tempDir, {}, null);

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
