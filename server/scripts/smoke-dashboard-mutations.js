const BASE_URL = process.env.TORQUE_DASHBOARD_BASE_URL || 'http://127.0.0.1:3456';
const TARGET_PROVIDER = process.env.TORQUE_DASHBOARD_SMOKE_PROVIDER || 'ollama';
const API_KEY = process.env.TORQUE_DASHBOARD_SMOKE_KEY || '';

function buildHeaders(includeAjax = true) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (includeAjax) {
    headers['X-Requested-With'] = 'XMLHttpRequest';
  }
  if (API_KEY) {
    headers['X-Torque-Key'] = API_KEY;
  }
  return headers;
}

async function requestJson(path, method = 'GET', body = undefined, includeAjax = true) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: buildHeaders(includeAjax),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  return { response, payload };
}

async function main() {
  const failures = [];
  const notes = [];

  const noAjax = await requestJson(`/api/providers/${encodeURIComponent(TARGET_PROVIDER)}/toggle`, 'POST', {
    enabled: false,
  }, false);
  if (noAjax.response.status !== 403) {
    failures.push(`Expected 403 without AJAX header, got ${noAjax.response.status}`);
  } else {
    notes.push('non-ajax mutation correctly rejected with 403');
  }

  const providerList = await requestJson('/api/providers', 'GET');
  if (providerList.response.status !== 200 || !Array.isArray(providerList.payload)) {
    failures.push(`GET /api/providers failed with status ${providerList.response.status}`);
  }

  const target = Array.isArray(providerList.payload)
    ? providerList.payload.find((row) => row.provider === TARGET_PROVIDER)
    : null;

  if (!target) {
    failures.push(`Provider "${TARGET_PROVIDER}" not found in dashboard provider list`);
  } else {
    const currentEnabled = Boolean(target.enabled);
    const toggledEnabled = !currentEnabled;

    const toggleOnce = await requestJson(`/api/providers/${encodeURIComponent(TARGET_PROVIDER)}/toggle`, 'POST', {
      enabled: toggledEnabled,
    }, true);
    if (toggleOnce.response.status !== 200) {
      failures.push(`Toggle to ${toggledEnabled} failed with status ${toggleOnce.response.status}`);
    } else {
      notes.push(`ajax mutation accepted for ${TARGET_PROVIDER} -> ${toggledEnabled}`);
    }

    const toggleBack = await requestJson(`/api/providers/${encodeURIComponent(TARGET_PROVIDER)}/toggle`, 'POST', {
      enabled: currentEnabled,
    }, true);
    if (toggleBack.response.status !== 200) {
      failures.push(`Toggle restore to ${currentEnabled} failed with status ${toggleBack.response.status}`);
    } else {
      notes.push(`provider ${TARGET_PROVIDER} restored to original enabled=${currentEnabled}`);
    }
  }

  for (const note of notes) {
    process.stdout.write(`[dashboard-smoke] ${note}\n`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`[dashboard-smoke] FAIL ${failure}\n`);
    }
    process.exit(1);
    return;
  }

  process.stdout.write('[dashboard-smoke] PASS mutation guard and ajax flow validated.\n');
  process.exit(0);
}

module.exports = { main };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[dashboard-smoke] FAIL ${error?.message || error}\n`);
    process.exit(1);
  });
}
