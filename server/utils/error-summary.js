'use strict';

/**
 * Heuristic error summarizer for failed task records.
 *
 * Codex (and other CLI providers) write the prompt back to stderr along
 * with reasoning summaries and every exec call's output, so a typical
 * `error_output` ends up being kilobytes-to-megabytes of mostly-prompt
 * with the actual failure signal — if any — buried near the end. This
 * module produces a 1-2 line TL;DR that surfaces the failure cause at
 * the top of task overviews, REST responses, and MCP get_result text.
 *
 * The summarizer is pure: no I/O, no DB access, deterministic. It runs
 * on-demand at fetch time (sub-millisecond on typical buffers) so we
 * don't need a schema migration to persist it.
 *
 * Detection order (highest signal wins):
 *
 *   1. Cancel reason — `[failed] <reason>` injected by the close handler
 *      when a task was cancelled out from under the runner (e.g.
 *      `pre_reclaim_before_create`, `worktree_reclaim`).
 *   2. Structured `[process-exit]` line — code/signal/duration/provider
 *      annotation added by execute-cli.js's close handler on any
 *      non-zero/abnormal exit. Distinguishes signal kill from app exit.
 *   3. Codex CLI errors — `[Retry N/N - Network error]`, rate-limit,
 *      context-length, sandbox-violation patterns.
 *   4. Generic last error keyword line — last line matching a broad
 *      error/failure regex.
 *   5. Banner-only output — codex echoed the prompt and a few exec
 *      calls but never actually produced work; surface "no progress
 *      after Nm" so the operator can route to a different provider.
 *   6. Fallback — exit code or duration-based summary.
 *
 * @param {object} task - the failed task row
 * @param {string|null} task.error_output
 * @param {string|null} task.output
 * @param {string|null} task.status
 * @param {number|null|undefined} task.exit_code
 * @param {string|null} task.provider
 * @param {string|null} task.model
 * @param {string|null} task.started_at
 * @param {string|null} task.completed_at
 * @returns {{summary: string, category: string, evidence: string|null}|null}
 *   null when the task has no failure signal to summarize (e.g.
 *   completed status, or no error_output and no exit code).
 */
function summarizeTaskError(task) {
  if (!task || typeof task !== 'object') return null;

  const status = (task.status || '').toLowerCase();
  if (status === 'completed' || status === 'shipped') return null;

  const errorOutput = typeof task.error_output === 'string' ? task.error_output : '';
  const output = typeof task.output === 'string' ? task.output : '';
  const exitCode = task.exit_code;
  const provider = task.provider || null;
  const durationMs = computeDurationMs(task.started_at, task.completed_at);
  const durationStr = formatDuration(durationMs);

  const trimmed = errorOutput.trim();

  // 1. Cancel reason injected by close handler / cancel path.
  const cancelMatch = findCancelReason(trimmed);
  if (cancelMatch) {
    return {
      summary: `Cancelled by ${cancelMatch.scope}: ${cancelMatch.reason}${durationStr ? ` (after ${durationStr})` : ''}`,
      category: 'cancelled',
      evidence: cancelMatch.line,
    };
  }

  // 2. Structured [process-exit] line.
  const exitInfo = parseStructuredExitLine(trimmed);
  if (exitInfo) {
    if (exitInfo.signal && exitInfo.signal !== 'none') {
      return {
        summary: `Killed by ${exitInfo.signal}${exitInfo.durationStr ? ` after ${exitInfo.durationStr}` : ''}${exitInfo.provider ? ` (${exitInfo.provider})` : ''}`,
        category: 'signal_kill',
        evidence: exitInfo.line,
      };
    }
    if (exitInfo.code !== null && exitInfo.code !== '0') {
      // Try to find a more specific cause before falling back to bare exit code.
      const codexErr = detectCodexError(trimmed);
      if (codexErr) {
        return {
          summary: `${codexErr.summary}${exitInfo.durationStr ? ` (after ${exitInfo.durationStr})` : ''}`,
          category: codexErr.category,
          evidence: codexErr.line,
        };
      }
      const lastErr = findLastErrorLine(trimmed);
      if (lastErr) {
        return {
          summary: `${exitInfo.provider || provider || 'Provider'} exited with code ${exitInfo.code}${exitInfo.durationStr ? ` after ${exitInfo.durationStr}` : ''}: ${truncate(lastErr, 200)}`,
          category: 'nonzero_exit',
          evidence: lastErr,
        };
      }
      return {
        summary: `${exitInfo.provider || provider || 'Provider'} exited with code ${exitInfo.code}${exitInfo.durationStr ? ` after ${exitInfo.durationStr}` : ''}, no diagnostic output`,
        category: 'nonzero_exit_silent',
        evidence: exitInfo.line,
      };
    }
  }

  // 3. Codex CLI specific errors (when no structured exit line was present).
  const codexErr = detectCodexError(trimmed);
  if (codexErr) {
    return {
      summary: codexErr.summary + (durationStr ? ` (after ${durationStr})` : ''),
      category: codexErr.category,
      evidence: codexErr.line,
    };
  }

  // 4. Generic last error keyword line.
  const lastErr = findLastErrorLine(trimmed);
  if (lastErr) {
    return {
      summary: `${provider ? `${provider} ` : ''}error: ${truncate(lastErr, 220)}`,
      category: 'generic_error_line',
      evidence: lastErr,
    };
  }

  // 5. Banner-only output (codex started, did some exec calls, never produced real work).
  if (isCodexBannerOnly(trimmed)) {
    return {
      summary: `${provider || 'Codex'} produced no work output${durationStr ? ` after ${durationStr}` : ''} — likely silent crash, network drop, or sandbox kill before any tool call completed`,
      category: 'banner_only',
      evidence: null,
    };
  }

  // 6. Fallback.
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return {
      summary: `${provider || 'Provider'} exited with code ${exitCode}${durationStr ? ` after ${durationStr}` : ''}, no parseable diagnostic`,
      category: 'unknown_nonzero_exit',
      evidence: null,
    };
  }
  if (status === 'failed' || status === 'cancelled') {
    return {
      summary: `${status === 'cancelled' ? 'Cancelled' : 'Failed'}${durationStr ? ` after ${durationStr}` : ''}, no diagnostic output captured${output ? '' : ' (stdout and stderr both empty)'}`,
      category: 'unknown',
      evidence: null,
    };
  }
  return null;
}

// ---- helpers ---------------------------------------------------------------

function computeDurationMs(startedAt, completedAt) {
  if (!startedAt) return null;
  const startTs = Date.parse(startedAt);
  const endTs = completedAt ? Date.parse(completedAt) : NaN;
  if (!Number.isFinite(startTs)) return null;
  if (!Number.isFinite(endTs)) return null;
  return Math.max(0, endTs - startTs);
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec === 0 ? `${min}m` : `${min}m${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr}h` : `${hr}h${remMin}m`;
}

function truncate(text, maxLen) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + '…';
}

// Walk from the end of `text` and collect up to `count` lines, in original
// (top-down) order. Avoids splitting the full string when error_output is
// multi-megabyte but only the tail is interesting. The summarizer only ever
// inspects the last 50–200 lines of error_output so a full-text split is
// pure overhead.
function tailLines(text, count) {
  if (!text) return [];
  const collected = [];
  let end = text.length;
  while (collected.length < count && end > 0) {
    const idx = text.lastIndexOf('\n', end - 1);
    const line = text.slice(idx + 1, end);
    // Strip trailing \r so this matches text.split(/\r?\n/).
    collected.push(line.endsWith('\r') ? line.slice(0, -1) : line);
    if (idx < 0) break;
    end = idx;
  }
  return collected.reverse();
}

// Cancel reason: the close handler / cancel path injects lines like:
//   `[failed] pre_reclaim_before_create`
//   `[failed] stalled_no_progress`
//   `[Worktree] Merge failed: <details>`
//   `Task requeued for reclaim cleanup retry (attempt 2/2)`
// Returns { reason, scope, line } or null.
function findCancelReason(text) {
  if (!text) return null;
  const lines = tailLines(text, 50);
  // Walk backward — cancel reasons are appended at finalization time.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let m = line.match(/^\[failed\]\s+(.+)$/);
    if (m) {
      return {
        reason: humanizeReason(m[1].trim()),
        scope: 'factory',
        line,
      };
    }
    m = line.match(/^\[Worktree\]\s+Merge failed:\s+(.+)$/i);
    if (m) {
      return {
        reason: `merge failed — ${truncate(m[1], 160)}`,
        scope: 'worktree',
        line,
      };
    }
    m = line.match(/Task requeued for reclaim cleanup retry/i);
    if (m) {
      return {
        reason: 'requeued for reclaim cleanup retry',
        scope: 'factory',
        line,
      };
    }
    m = line.match(/Task could not be reclaimed for worktree ownership cleanup/i);
    if (m) {
      return {
        reason: 'unrecoverable: worktree ownership cleanup exceeded retries',
        scope: 'factory',
        line,
      };
    }
    m = line.match(/^Internal error:\s+(.+)$/);
    if (m) {
      return {
        reason: `close-handler internal error — ${truncate(m[1], 160)}`,
        scope: 'runner',
        line,
      };
    }
  }
  return null;
}

function humanizeReason(rawReason) {
  // Convert snake_case sentinel reasons to human form.
  return rawReason
    .replace(/_/g, ' ')
    .replace(/\bpre reclaim before create\b/i, 'pre-reclaim cancelled by factory before EXECUTE create')
    .replace(/\bworktree reclaim\b/i, 'worktree reclaim')
    .replace(/\bstalled no progress\b/i, 'stalled with no progress')
    .replace(/\btimeout\b/i, 'timeout');
}

// Parses the [process-exit] sentinel line.
//   Legacy: `[process-exit] terminated by signal SIGKILL`
//   Structured: `[process-exit] code=1 signal=none duration_ms=135000 provider=codex model=gpt-5.5`
function parseStructuredExitLine(text) {
  if (!text) return null;
  // The structured exit line is one of the last lines emitted before close,
  // so 50 tail lines is plenty even on noisy buffers.
  const lines = tailLines(text, 50);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith('[process-exit]')) continue;
    const legacy = line.match(/^\[process-exit\]\s+terminated by signal\s+(SIG[A-Z]+|\d+)/);
    if (legacy) {
      return { code: null, signal: legacy[1], durationMs: null, durationStr: '', provider: null, model: null, line };
    }
    const codeMatch = line.match(/\bcode=(-?\d+|null|none)\b/);
    const signalMatch = line.match(/\bsignal=(SIG[A-Z]+|\d+|none|null)\b/);
    const durationMatch = line.match(/\bduration_ms=(\d+)\b/);
    const providerMatch = line.match(/\bprovider=([A-Za-z0-9_.-]+)/);
    const modelMatch = line.match(/\bmodel=([A-Za-z0-9_.:/-]+)/);
    if (!codeMatch && !signalMatch && !durationMatch) continue;
    const codeRaw = codeMatch ? codeMatch[1] : null;
    const signalRaw = signalMatch ? signalMatch[1] : null;
    const durationMs = durationMatch ? Number(durationMatch[1]) : null;
    return {
      code: codeRaw === 'null' || codeRaw === 'none' ? null : codeRaw,
      signal: signalRaw === 'null' || signalRaw === 'none' ? null : signalRaw,
      durationMs,
      durationStr: durationMs != null ? formatDuration(durationMs) : '',
      provider: providerMatch ? providerMatch[1] : null,
      model: modelMatch ? modelMatch[1] : null,
      line,
    };
  }
  return null;
}

// Detects codex-CLI-specific failure shapes.
function detectCodexError(text) {
  if (!text) return null;
  // Network-error retry (codex CLI prefix).
  let m = text.match(/\[Retry\s+(\d+)\/(\d+)\s*-\s*([^\]]+)\]/);
  if (m) {
    return {
      summary: `Codex network/transport error (retry ${m[1]}/${m[2]} - ${m[3].trim()})`,
      category: 'codex_network',
      line: m[0],
    };
  }
  // Rate limit / quota.
  m = text.match(/(?:rate[_ ]?limit(?:_exceeded|ed)?|429\b|quota|too many requests|usage limit)[^\n]{0,200}/i);
  if (m) {
    return {
      summary: `Provider rate-limited or over quota: ${truncate(m[0], 180)}`,
      category: 'rate_limit',
      line: m[0],
    };
  }
  // Context length.
  m = text.match(/(?:context[_ ]?length(?:_exceeded)?|exceeds maximum context|maximum context length|context window)[^\n]{0,200}/i);
  if (m) {
    return {
      summary: `Prompt exceeded the model context window: ${truncate(m[0], 180)}`,
      category: 'context_length',
      line: m[0],
    };
  }
  // Sandbox / workspace-write violations.
  m = text.match(/(?:sandbox(?:[-_]?write)?|workspace[-_ ]?write)[^\n]{0,200}(?:denied|blocked|violation|refused)/i);
  if (m) {
    return {
      summary: `Sandbox blocked an operation: ${truncate(m[0], 180)}`,
      category: 'sandbox_block',
      line: m[0],
    };
  }
  // Codex auth / login.
  m = text.match(/(?:not (?:authenticated|logged[_ ]?in)|please (?:log in|authenticate)|authentication (?:required|failed)|invalid api key)[^\n]{0,200}/i);
  if (m) {
    return {
      summary: `Codex authentication problem: ${truncate(m[0], 180)}`,
      category: 'auth',
      line: m[0],
    };
  }
  // ENOENT / EACCES / spawn errors that codex surfaces.
  m = text.match(/\b(ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH)\b[^\n]{0,200}/i);
  if (m) {
    return {
      summary: `System error ${m[1].toUpperCase()}: ${truncate(m[0], 180)}`,
      category: 'system_error',
      line: m[0],
    };
  }
  return null;
}

// Last line that looks like an error message. Walks backward to favor
// the final error over earlier transient ones.
function findLastErrorLine(text) {
  if (!text) return null;
  const lines = tailLines(text, 200);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] && lines[i].trim();
    if (!line) continue;
    // Skip codex-banner-noise lines.
    if (/^(workdir|model|provider|approval|sandbox|reasoning(?:\s+(effort|summaries))?|session id|user|codex|exec|--+|\[Codex\])/i.test(line)) continue;
    if (/^\s*"[A-Z]:\\/.test(line)) continue;  // PowerShell command echo
    if (/\b(error|failed|failure|panic|fatal|exception|traceback|cannot|unable|aborted|denied|refused|unauthorized|forbidden|crash)\b/i.test(line)) {
      return line;
    }
  }
  return null;
}

// True when the captured stderr is just the codex banner + a few exec
// echos and no real model output / no error keyword. Mirrors the
// `isCodexStartupBannerOnlyOutput` logic in fallback-retry.js but
// returns boolean for any banner-shaped output (not just "exactly the
// banner"); we already ruled out cancel/exit/codex/error patterns above.
function isCodexBannerOnly(text) {
  if (!text) return false;
  // Strip ANSI escape sequences that codex sometimes emits.
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/\[[0-9;]*m/g, '').trim();
  if (!/\bOpenAI Codex\b/i.test(stripped)) return false;
  // If there's a model/tool message body after the prompt, it's not banner-only.
  const bodyMatch = stripped.match(/\bcodex\b\s*\n([\s\S]*)$/i);
  if (!bodyMatch) return true;
  const body = bodyMatch[1].trim();
  // Body contains only exec/succeeded/elapsed lines or is short → banner-shaped.
  if (body.length < 200) return true;
  const nonExecLines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(exec|succeeded|tokens used|elapsed|reasoning summary|user)/i.test(l));
  return nonExecLines.length < 3;
}

module.exports = {
  summarizeTaskError,
  // exposed for tests
  _internals: {
    findCancelReason,
    parseStructuredExitLine,
    detectCodexError,
    findLastErrorLine,
    isCodexBannerOnly,
    formatDuration,
    truncate,
  },
};
