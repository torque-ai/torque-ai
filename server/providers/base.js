/**
 * Base provider interface for TORQUE
 *
 * All providers implement: submit(task, model, options) -> { output, status, usage }
 */

const logger = require('../logger').child({ component: 'provider-base' });

class BaseProvider {
  constructor(config = {}) {
    this.name = config.name || 'unknown';
    this.enabled = config.enabled !== false;
    this.maxConcurrent = config.maxConcurrent || 3;
    this.activeTasks = 0;
  }

  /**
   * Submit a task to this provider
   * @param {string} task - Task description
   * @param {string} model - Model to use
   * @param {object} options - Additional options (working_directory, files, tuning, timeout)
   * @returns {Promise<{output: string, status: string, usage: {tokens: number, cost: number, duration_ms: number}}>}
   */
  async submit(task, model, _options = {}) {
    throw new Error(`${this.name}: submit() not implemented`);
  }

  /**
   * Check if this provider is available
   * @returns {Promise<{available: boolean, models: string[], error?: string}>}
   */
  async checkHealth() {
    throw new Error(`${this.name}: checkHealth() not implemented`);
  }

  /**
   * Get available models for this provider
   * @returns {Promise<string[]>}
   */
  async listModels() {
    return [];
  }

  /**
   * Discover available models with rich metadata.
   * Default calls checkHealth() which already queries /v1/models on cloud providers.
   * Override in subclasses for provider-specific discovery.
   * @returns {Promise<{models: Array<{model_name: string, sizeBytes?: number}>, provider: string}>}
   */
  async discoverModels() {
    try {
      const health = await this.checkHealth();
      const models = (health?.models || []).map(m =>
        typeof m === 'string' ? { model_name: m } : m
      );
      return { models, provider: this.name };
    } catch {
      return { models: [], provider: this.name };
    }
  }

  /**
   * Get default tuning parameters for a model.
   * Override in subclasses for provider-specific tuning.
   * @param {string} model - Model name
   * @returns {object} Tuning parameters (empty = use system defaults)
   */
  getDefaultTuning(_model) {
    return {};
  }

  /**
   * Get system prompt for a model.
   * Override in subclasses for provider-specific prompts.
   * @param {string} model - Model name
   * @param {string} format - Edit format ('hashline', 'raw', 'agentic')
   * @returns {string|null} System prompt, or null to use system default
   */
  getSystemPrompt(_model, _format) {
    return null;
  }

  /**
   * Check if provider can accept more tasks
   */
  hasCapacity() {
    return this.enabled && this.activeTasks < this.maxConcurrent;
  }

  getRetryAfterSeconds(response) {
    if (!response?.headers?.get) return null;
    const retryAfter = response.headers.get('Retry-After') || response.headers.get('retry-after');
    if (!retryAfter) return null;
    const parsed = Number.parseInt(retryAfter, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  /**
   * Best-effort reader cleanup after a streaming request settles.
   * A cancel failure only means the transport was already closed or errored, so we keep
   * the task result and emit a debug breadcrumb for diagnosis instead of surfacing noise.
   */
  async cancelStreamReaderForCleanup(reader, phase = 'stream cleanup') {
    if (!reader?.cancel) return;

    try {
      await reader.cancel();
    } catch (err) {
      logger.debug(`[${this.name}] Failed to cancel stream reader during ${phase}: ${err?.message || String(err)}`);
    }
  }
}

module.exports = BaseProvider;
