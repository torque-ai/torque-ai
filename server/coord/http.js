'use strict';
const http = require('http');
const url = require('url');

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function lastLine(buffer) {
  if (!buffer) return '';
  const trimmed = buffer.endsWith('\n') ? buffer.slice(0, -1) : buffer;
  const idx = trimmed.lastIndexOf('\n');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function createServer({ state, results, config }) {
  const startedAt = Date.now();

  function handleHealth(_req, res) {
    sendJson(res, 200, {
      ok: true,
      protocol_version: config.protocol_version,
      uptime_ms: Date.now() - startedAt,
      active_count: state.listActive().length,
    });
  }

  async function handleAcquire(req, res) {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJson(res, 400, { error: 'invalid_json', detail: e.message }); }
    const { project, sha, suite, holder } = body || {};
    if (!project || !sha || !suite || !holder) {
      return sendJson(res, 400, { error: 'missing_fields' });
    }
    const result = state.acquire({ project, sha, suite, holder });
    if (result.acquired) return sendJson(res, 200, result);
    return sendJson(res, 202, result);
  }

  async function handleHeartbeat(req, res) {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJson(res, 400, { error: 'invalid_json', detail: e.message }); }
    const { lock_id, log_chunk } = body || {};
    if (!lock_id) return sendJson(res, 400, { error: 'missing_lock_id' });
    const out = state.heartbeat(lock_id, { log_chunk });
    if (!out.ok) return sendJson(res, 404, out);
    return sendJson(res, 200, out);
  }

  async function handleRelease(req, res) {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return sendJson(res, 400, { error: 'invalid_json', detail: e.message }); }
    const { lock_id, exit_code, suite_status, output_tail, package_lock_hashes } = body || {};
    if (!lock_id) return sendJson(res, 400, { error: 'missing_lock_id' });
    const out = state.release(lock_id, { exit_code, suite_status, output_tail, package_lock_hashes });
    if (!out.released) return sendJson(res, 404, out);
    if (results && typeof results.writeResult === 'function') {
      results.writeResult({
        project: out.lock.project,
        sha: out.lock.sha,
        suite: out.lock.suite,
        exit_code, suite_status, output_tail,
        package_lock_hashes,
        crashed: false,
      });
    }
    return sendJson(res, 200, { released: true });
  }

  function handleResults(_req, res, parts) {
    if (parts.length < 5) return sendJson(res, 400, { error: 'bad_path' });
    const project = parts[2];
    const sha = parts[3];
    const suite = parts[4];
    const hit = results.getResult({ project, sha, suite });
    if (!hit) return sendJson(res, 404, { hit: false });
    return sendJson(res, 200, hit);
  }

  function handleActive(_req, res) {
    sendJson(res, 200, { active: state.listActive() });
  }

  function handleWait(req, res, parts) {
    const lock_id = parts[2];
    if (!lock_id) return sendJson(res, 400, { error: 'missing_lock_id' });
    const lock = state.getLock(lock_id);
    if (!lock) return sendJson(res, 404, { error: 'unknown_lock' });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    function sendEvent(payload) {
      res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
    }

    sendEvent({
      type: 'progress',
      lock_id,
      elapsed_ms: Date.now() - Date.parse(lock.created_at),
      last_log_line: lastLine(lock.output_buffer),
    });

    const tick = setInterval(() => {
      const live = state.getLock(lock_id);
      if (!live) return;
      sendEvent({
        type: 'progress',
        lock_id,
        elapsed_ms: Date.now() - Date.parse(live.created_at),
        last_log_line: lastLine(live.output_buffer),
      });
    }, 5000);
    if (typeof tick.unref === 'function') tick.unref();

    const unsubscribe = state.subscribe(lock_id, (event) => {
      sendEvent(event);
      clearInterval(tick);
      res.end();
    });

    req.on('close', () => {
      clearInterval(tick);
      unsubscribe();
    });
  }

  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const parts = parsed.pathname.split('/'); // ['', 'health'] etc.

    if (req.method === 'GET' && parts[1] === 'health') return handleHealth(req, res);
    if (req.method === 'POST' && parts[1] === 'acquire') return handleAcquire(req, res);
    if (req.method === 'POST' && parts[1] === 'heartbeat') return handleHeartbeat(req, res);
    if (req.method === 'POST' && parts[1] === 'release') return handleRelease(req, res);
    if (req.method === 'GET' && parts[1] === 'results') return handleResults(req, res, parts);
    if (req.method === 'GET' && parts[1] === 'active') return handleActive(req, res);
    if (req.method === 'GET' && parts[1] === 'wait') return handleWait(req, res, parts);
    sendJson(res, 404, { error: 'unknown_route', path: parsed.pathname });
  });

  return server;
}

module.exports = { createServer };
