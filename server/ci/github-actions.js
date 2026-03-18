'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');

const CIProvider = require('./provider');

const GH_TIMEOUT_MS = 30000;
const MAX_FAILURE_LOG_BYTES = 2 * 1024 * 1024;

class GitHubActionsProvider extends CIProvider {
  constructor({ name = 'github-actions', repo } = {}) {
    super({ name, repo });
    this._prerequisiteResult = null;
  }

  async checkPrerequisites() {
    if (this._prerequisiteResult) {
      return this._prerequisiteResult;
    }

    try {
      await this._runGhCommand(
        'gh',
        ['auth', 'status', '--hostname', 'github.com'],
      );
      this._prerequisiteResult = { ready: true };
      return this._prerequisiteResult;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this._prerequisiteResult = { ready: false, error: 'gh not found' };
      } else {
        this._prerequisiteResult = {
          ready: false,
          error: (error && error.message) || 'gh check failed',
        };
      }

      return this._prerequisiteResult;
    }
  }

  async getRun(runId) {
    const { stdout } = await this._runGhCommand(
      'gh',
      [
        'run',
        'view',
        runId,
        '--json',
        'status,conclusion,headSha,headBranch,url,createdAt,updatedAt,jobs,databaseId',
      ],
    );

    let run;
    try {
      run = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`Failed to parse GitHub Actions run response: ${error.message}`);
    }
    return this._normalizeRun(run);
  }

  async getFailureLogs(runId) {
    const { stdout } = await this._runGhCommand(
      'gh',
      ['run', 'view', runId, '--log-failed'],
    );

    return typeof stdout === 'string'
      ? stdout.slice(0, MAX_FAILURE_LOG_BYTES)
      : '';
  }

  async listRuns(filters = {}) {
    const limit = filters.limit || 10;
    const { stdout } = await this._runGhCommand(
      'gh',
      [
        'run',
        'list',
        '--json',
        'databaseId,status,conclusion,headSha,headBranch,url,createdAt',
        '--limit',
        String(limit),
      ],
    );

    let runs;
    try {
      runs = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`Failed to parse GitHub Actions runs response: ${error.message}`);
    }
    if (!Array.isArray(runs)) {
      return [];
    }

    return runs
      .map((run) => this._normalizeRun(run))
      .filter((run) => {
        if (filters.branch && run.branch !== filters.branch) {
          return false;
        }
        if (filters.status && run.status !== filters.status) {
          return false;
        }
        return true;
      });
  }

  parseWebhookPayload(_headers = {}, body = null) {
    const payload = typeof body === 'string' ? JSON.parse(body) : body;
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid GitHub webhook payload');
    }

    const workflowRun = payload.workflow_run;
    if (!workflowRun || typeof workflowRun !== 'object') {
      throw new Error('Invalid GitHub webhook payload');
    }

    return this._normalizeRun({
      databaseId: workflowRun.id,
      status: workflowRun.status,
      conclusion: workflowRun.conclusion,
      headSha: workflowRun.head_sha,
      headBranch: workflowRun.head_branch,
      url: workflowRun.html_url || workflowRun.url,
      createdAt: workflowRun.created_at,
      updatedAt: workflowRun.updated_at,
      repository: payload.repository && payload.repository.full_name,
      raw: payload,
    });
  }

  async verifyWebhookSignature(headers, body, secret) {
    const headerValue = Object.entries(headers || {})
      .find(([name]) => name.toLowerCase() === 'x-hub-signature-256');

    if (!headerValue) {
      return false;
    }

    const signature = headerValue[1];
    if (typeof signature !== 'string') {
      return false;
    }

    const match = /^sha256=([a-fA-F0-9]{64})$/.exec(signature);
    if (!match) {
      return false;
    }

    const payloadText = typeof body === 'string' ? body : JSON.stringify(body);
    const actual = Buffer.from(match[1], 'hex');
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payloadText)
      .digest();

    if (actual.length !== expected.length) {
      return false;
    }

    return crypto.timingSafeEqual(actual, expected);
  }

  _normalizeRun(rawRun) {
    return {
      id: String(rawRun.databaseId || rawRun.id),
      status: this._normalizeRunStatus(rawRun.status, rawRun.conclusion),
      repository: rawRun.repository || this.repo,
      branch: rawRun.headBranch,
      sha: rawRun.headSha,
      url: rawRun.url,
      createdAt: rawRun.createdAt,
      updatedAt: rawRun.updatedAt,
      raw: typeof rawRun.raw === 'string' ? rawRun.raw : JSON.stringify(rawRun.raw || rawRun),
    };
  }

  _runGhCommand(...args) {
    return new Promise((resolve, reject) => {
      childProcess.execFile(...args, { timeout: GH_TIMEOUT_MS }, (error, stdout = '', stderr = '') => {
        if (error) {
          const commandError = error;
          commandError.stdout = stdout;
          commandError.stderr = stderr;
          reject(commandError);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  _normalizeRunStatus(status, conclusion) {
    const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : '';
    const normalizedConclusion = typeof conclusion === 'string' ? conclusion.toLowerCase() : '';

    if (normalizedStatus === 'queued' || normalizedStatus === 'waiting' || normalizedStatus === 'requested') {
      return 'queued';
    }

    if (normalizedStatus === 'in_progress' || normalizedStatus === 'running') {
      return 'running';
    }

    if (normalizedStatus === 'completed') {
      if (normalizedConclusion === 'success') {
        return 'success';
      }

      if (normalizedConclusion === 'failure' || normalizedConclusion === 'timed_out') {
        return 'failure';
      }

      if (normalizedConclusion === 'cancelled' || normalizedConclusion === 'canceled') {
        return 'cancelled';
      }

      return 'unknown';
    }

    if (normalizedConclusion === 'failure' || normalizedConclusion === 'timed_out') {
      return 'failure';
    }

    if (normalizedConclusion === 'success') {
      return 'success';
    }

    if (normalizedConclusion === 'cancelled' || normalizedConclusion === 'canceled') {
      return 'cancelled';
    }

    return 'unknown';
  }
}

module.exports = GitHubActionsProvider;
