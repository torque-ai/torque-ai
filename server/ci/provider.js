/**
 * @typedef {Object} CIEvent
 * @property {string} id - Provider-specific identifier for the CI run.
 * @property {string} status - Canonical run status (queued|running|success|failure|cancelled|unknown).
 * @property {string} repository - Repository identifier that owns the CI event.
 * @property {string} [branch] - Optional source branch for the run.
 * @property {string} [sha] - Optional commit SHA associated with the run.
 * @property {string} [url] - Optional link to the CI run in the provider UI.
 * @property {string} [raw] - Optional serialized provider payload.
 */

/**
 * @typedef {Object} StructuredFailure
 * @property {string} reason - Top-level reason classification for the failure.
 * @property {string} message - Human-readable failure message.
 * @property {Array<{ step: string, output: string }>} [steps] - Optional step-level context for structured failures.
 * @property {object} [metadata] - Optional provider-specific metadata.
 */

/**
 * Base class for CI providers used by TORQUE integrations.
 */
class CIProvider {
  /**
   * @param {{name: string, repo: string}} config
   * @param {string} config.name
   * @param {string} config.repo
   */
  constructor({ name, repo } = {}) {
    if (!name) {
      throw new Error('CIProvider: name is required');
    }

    if (!repo) {
      throw new Error('CIProvider: repo is required');
    }

    this.name = name;
    this.repo = repo;
  }

  /**
   * Verify the provider is ready for operations.
   * @param {object} [options]
   * @returns {Promise<{ready: boolean, error?: string}>}
   */
  async checkPrerequisites(_options = {}) {
    return {
      ready: false,
      error: 'not implemented',
    };
  }

  /**
   * Watch a CI run until completion.
   * @param {string} runId
   * @param {object} [options]
   * @returns {Promise<CIEvent>}
   */
  async watchRun(runId, options = {}) {
    const pollIntervalMs = options.pollIntervalMs || 15000;
    const timeoutMs = options.timeoutMs || 30 * 60 * 1000;
    const startTime = Date.now();
    const TERMINAL_STATUSES = new Set(['success', 'failure', 'cancelled', 'timed_out']);

    while (true) {
      const run = await this.getRun(runId);
      if (run && TERMINAL_STATUSES.has(run.status)) {
        return run;
      }
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error(`watchRun timed out after ${Math.round(timeoutMs / 1000)}s waiting for run ${runId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * Get a single CI run by id.
   * @param {string} runId
   * @returns {Promise<CIEvent>}
   */
  async getRun(runId) {
    if (!runId || typeof runId !== 'string' || runId.trim() === '') {
      throw new Error('runId is required');
    }
    throw new Error(`${this.name}: getRun() not implemented`);
  }

  /**
   * Get CI failures for a run.
   * @param {string} runId
   * @returns {Promise<StructuredFailure[]>}
   */
  async getFailureLogs(runId) {
    if (!runId || typeof runId !== 'string' || runId.trim() === '') {
      throw new Error('runId is required');
    }
    throw new Error(`${this.name}: getFailureLogs() not implemented`);
  }

  /**
   * List CI runs for a repository.
   * @param {object} [filters]
   * @returns {Promise<CIEvent[]>}
   */
  async listRuns(_filters = {}) {
    if (this.repo == null || this.repo === '') {
      throw new Error('repo is not configured');
    }
    throw new Error(`${this.name}: listRuns() not implemented`);
  }

  /**
   * Parse provider-specific webhook payload to a normalized CI event.
   * @param {Record<string, string|undefined>} headers
   * @param {string|object} body
   * @returns {CIEvent}
   */
  parseWebhookPayload(_headers = {}, _body = null) {
    throw new Error(`${this.name}: parseWebhookPayload() not implemented`);
  }

  /**
   * Verify a webhook signature.
   * @param {Record<string, string|undefined>} _headers
   * @param {string|object} _body
   * @param {string} _secret
   * @returns {Promise<boolean>}
   */
  async verifyWebhookSignature(_headers = {}, _body = null, _secret = '') {
    return false;
  }
}

module.exports = CIProvider;
