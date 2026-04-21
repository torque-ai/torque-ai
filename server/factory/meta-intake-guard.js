// Meta-intake guard: rejects work items whose titles describe intake/backlog
// management rather than real code changes. A title like 'Create intake for
// X' or 'Add backlog entry' has no code surface and drives Codex into a
// retry storm (zero diff across every attempt). Catching these at ingest
// keeps the factory loop from wasting cycles on non-actionable work.

const META_TITLE_REGEX = /^(create|file|add|open)\s+(intake|work\s+item|backlog\s+entry|ticket|issue)\b/i;

function isMetaTitle(title) {
  if (typeof title !== 'string') return false;
  return META_TITLE_REGEX.test(title.trim());
}

// guardIntakeItem: inspect a proposed intake item. Returns one of:
//   { ok: true, item }                — item is fine, caller should create it
//   { ok: false, reason, title }      — item was rejected as meta, caller should skip
//   { ok: true, item, regenerated }   — retry produced a clean title; caller uses item
//
// retryRegenerator (optional): () => newTitle | Promise<newTitle>. If provided
// and the original title is meta, the guard calls it ONCE to regenerate.
// If the regenerated title is still meta (or empty/non-string), the item is rejected.
async function guardIntakeItem({ title, retryRegenerator } = {}) {
  const originalTitle = typeof title === 'string' ? title.trim() : '';
  if (!isMetaTitle(originalTitle)) {
    return { ok: true, item: { title: originalTitle } };
  }

  if (typeof retryRegenerator === 'function') {
    let regenerated;
    try {
      regenerated = await retryRegenerator();
    } catch (_err) {
      regenerated = null;
    }
    const regenTitle = typeof regenerated === 'string' ? regenerated.trim() : '';
    if (regenTitle && !isMetaTitle(regenTitle)) {
      return { ok: true, item: { title: regenTitle }, regenerated: true };
    }
  }

  return {
    ok: false,
    reason: 'meta_task_no_code_output',
    title: originalTitle,
  };
}

module.exports = { isMetaTitle, guardIntakeItem };
