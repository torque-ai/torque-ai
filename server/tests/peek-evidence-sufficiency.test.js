'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const emailPeek = require('../db/email-peek');
const taskMetadata = require('../db/task-metadata');
const { WPF_FIXTURE } = require('../contracts/peek-fixtures');
const handlers = require('../handlers/peek-handlers');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHttpRequestMock(queue) {
  return (url, options, cb) => {
    const next = queue.shift() || {};
    const req = new EventEmitter();
    req.destroy = vi.fn();
    req.write = vi.fn();
    req.end = vi.fn((chunk) => {
      if (chunk !== undefined) {
        req.write(chunk);
      }

      process.nextTick(() => {
        if (next.timeout) {
          req.emit('timeout');
          return;
        }

        if (next.error) {
          req.emit('error', new Error(next.error));
          return;
        }

        const res = new EventEmitter();
        res.statusCode = next.statusCode ?? 200;
        cb(res);

        if (next.body !== undefined) {
          const payload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
          res.emit('data', Buffer.from(payload));
        }

        res.emit('end');
      });
    });

    return req;
  };
}

describe('peek evidence sufficiency', () => {
  let tempDir;
  let requestQueue;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-peek-evidence-'));
    requestQueue = [];

    vi.spyOn(emailPeek, 'getDefaultPeekHost').mockReturnValue({
      name: 'omen',
      url: 'http://omen:9876',
    });
    vi.spyOn(taskMetadata, 'getArtifactConfig').mockReturnValue({
      storage_path: tempDir,
    });
    vi.spyOn(taskMetadata, 'storeArtifact').mockImplementation((artifact) => ({
      ...artifact,
      created_at: '2026-03-10T00:00:00.000Z',
      expires_at: '2026-04-09T00:00:00.000Z',
    }));
    vi.spyOn(http, 'request').mockImplementation(createHttpRequestMock(requestQueue));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns sufficient: true for a complete bundle', () => {
    expect(handlers.classifyEvidenceSufficiency(clone(WPF_FIXTURE))).toEqual({ sufficient: true });
  });

  it('returns sufficient: false with capture_data in missing when capture data is absent', () => {
    const bundle = clone(WPF_FIXTURE);
    bundle.capture_data = null;

    expect(handlers.classifyEvidenceSufficiency(bundle)).toEqual(expect.objectContaining({
      sufficient: false,
      confidence: 'low',
      missing: expect.arrayContaining(['capture_data']),
    }));
  });

  it('returns sufficient: false with visual_tree in missing when the visual tree is absent', () => {
    const bundle = clone(WPF_FIXTURE);
    bundle.visual_tree = null;

    expect(handlers.classifyEvidenceSufficiency(bundle)).toEqual(expect.objectContaining({
      sufficient: false,
      confidence: 'low',
      missing: expect.arrayContaining(['visual_tree']),
    }));
  });

  it('returns sufficient: false when metadata is null', () => {
    const bundle = clone(WPF_FIXTURE);
    bundle.metadata = null;

    expect(handlers.classifyEvidenceSufficiency(bundle)).toEqual(expect.objectContaining({
      sufficient: false,
      confidence: 'low',
      missing: expect.arrayContaining(['metadata']),
    }));
  });

  it('persists insufficient bundles instead of dropping them', async () => {
    const bundle = clone(WPF_FIXTURE);
    bundle.visual_tree = null;
    bundle.artifacts.persisted = false;
    bundle.artifacts.bundle_path = null;
    bundle.artifacts.artifact_report_path = null;

    requestQueue.push({
      body: {
        success: true,
        screenshot: bundle.capture_data.image_base64,
        bundle,
        format: 'png',
      },
    });

    const result = await handlers.handlePeekDiagnose({
      process: 'Taskmgr',
      format: 'png',
      annotate: false,
    });

    expect(result.isError).toBeFalsy();
    expect(result.evidence_state).toBe('insufficient');
    expect(result.peek_bundle_artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'bundle_json',
        path: expect.any(String),
      }),
    ]));

    const bundleRef = result.peek_bundle_artifacts.find((ref) => ref.kind === 'bundle_json');
    expect(bundleRef).toBeTruthy();
    expect(fs.existsSync(bundleRef.path)).toBe(true);

    const persistedBundle = JSON.parse(fs.readFileSync(bundleRef.path, 'utf8'));
    expect(persistedBundle.evidence_state).toBe('insufficient');
    expect(persistedBundle.evidence_sufficiency).toEqual(expect.objectContaining({
      sufficient: false,
      confidence: 'low',
      missing: expect.arrayContaining(['visual_tree']),
    }));
    expect(persistedBundle.missing_evidence_fields).toEqual(expect.arrayContaining(['visual_tree']));
    expect(persistedBundle.artifacts).toEqual(expect.objectContaining({
      persisted: true,
      bundle_path: bundleRef.path,
    }));
  });

  it('includes evidence_state in the diagnose response', async () => {
    const bundle = clone(WPF_FIXTURE);

    requestQueue.push({
      body: {
        success: true,
        screenshot: bundle.capture_data.image_base64,
        bundle,
        format: 'png',
      },
    });

    const result = await handlers.handlePeekDiagnose({
      process: 'Taskmgr',
      format: 'png',
      annotate: false,
    });

    expect(result.isError).toBeFalsy();
    expect(result.evidence_state).toBe('complete');
    expect(result.evidence_sufficiency).toEqual({ sufficient: true });
    expect(result.missing_evidence_fields).toEqual([]);
  });
});
