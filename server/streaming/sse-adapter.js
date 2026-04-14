'use strict';

function formatSseFrame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function streamToSse(iter, res, options = {}) {
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

  res.setHeader?.('Content-Type', 'text/event-stream');
  res.setHeader?.('Cache-Control', 'no-cache');
  res.setHeader?.('Connection', 'keep-alive');

  try {
    for await (const event of iter) {
      if (onEvent) {
        await onEvent(event);
      }

      res.write(formatSseFrame(event));
      if (event.type === 'done' || event.type === 'error') break;
    }
  } catch (err) {
    const errorEvent = {
      type: 'error',
      error: err?.message || String(err),
    };
    if (onEvent) {
      await onEvent(errorEvent);
    }
    res.write(formatSseFrame(errorEvent));
  } finally {
    res.end();
  }
}

module.exports = {
  formatSseFrame,
  streamToSse,
};
