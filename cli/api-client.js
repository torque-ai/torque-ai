const BASE_URL = process.env.TORQUE_API_URL || 'http://127.0.0.1:3457';

class ApiError extends Error {
  constructor(message, { status = null, body = '', path = '', method = 'GET' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.path = path;
    this.method = method;
  }
}

function normalizeNetworkError(err, method, path) {
  const code = err?.cause?.code || err?.code;

  if (code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message || '')) {
    return new ApiError(
      `Unable to reach TORQUE API at ${BASE_URL}. Is the server running?`,
      { path, method },
    );
  }

  return new ApiError(
    `Request failed for ${method} ${path}: ${err?.message || String(err)}`,
    { path, method },
  );
}

async function parseResponseBody(res) {
  const text = await res.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(method, path, body) {
  const url = `${BASE_URL}${path}`;

  try {
    const init = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    const payload = await parseResponseBody(res);

    if (!res.ok) {
      const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
      throw new ApiError(`API error ${res.status}: ${rawBody}`, {
        status: res.status,
        body: rawBody,
        path,
        method,
      });
    }

    return payload;
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    throw normalizeNetworkError(err, method, path);
  }
}

async function apiGet(path) {
  return request('GET', path);
}

async function apiPost(path, body) {
  return request('POST', path, body);
}

async function apiDelete(path) {
  return request('DELETE', path);
}

module.exports = { apiGet, apiPost, apiDelete, BASE_URL, ApiError };
