const fs = require('fs');
const os = require('os');
const path = require('path');

let testDir;

function tmpFile(relPath, content) {
  const abs = path.join(testDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `torque-widget-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe('smart-scan widget conventions', () => {
  let findConventionMatches;

  beforeEach(() => {
    ({ findConventionMatches } = require('../utils/smart-scan'));
  });

  it('maps widget source file to its widget.test.js', () => {
    const source = tmpFile('src/widget.js', '// widget module');
    const test = tmpFile('src/widget.test.js', '// widget test');

    const matches = findConventionMatches(source);
    expect(matches).toContain(test);
  });

  it('maps widget.test.js back to widget.js', () => {
    const source = tmpFile('src/widget.js', '// widget module');
    tmpFile('src/widget.test.js', '// widget test');

    const matches = findConventionMatches(path.join(testDir, 'src', 'widget.test.js'));
    expect(matches).toContain(source);
  });

  it('does not generate .test.test.js from widget.test.js', () => {
    const test = tmpFile('src/widget.test.js', '// widget test');

    const matches = findConventionMatches(test);
    expect(matches).toEqual([]);
  });
});

describe('smart-scan widget import parsing', () => {
  let parseImports, smartScan;

  beforeEach(() => {
    ({ parseImports, smartScan } = require('../utils/smart-scan'));
  });

  it('resolves extensionless imports for a widget module', () => {
    const widget = tmpFile('src/widget.tsx', 'export default function widget() {}');
    const app = tmpFile('src/app.tsx', "import widget from './widget';\n");

    const imports = parseImports(app);
    expect(imports).toContain(widget);
  });

  it('ignores non-relative widget import specifiers', () => {
    const app = tmpFile('src/app.js', "import { Widget } from 'some-widget-lib';\n");

    const imports = parseImports(app);
    expect(imports).toEqual([]);
  });

  it('adds convention reason for widget test when scanning', () => {
    const source = tmpFile('src/widget.js', '// widget module');
    const test = tmpFile('src/widget.test.js', '// widget test');

    const result = smartScan({ files: [source] });
    expect(result.contextFiles).toContain(test);
    expect(result.reasons.get(test)).toBe('convention:widget.test.js');
  });
});
