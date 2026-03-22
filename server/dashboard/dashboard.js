'use strict';

(function () {
  const API_HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  const POLL_INTERVAL = 30000;
  let activeFilter = '';
  let ws = null;
  let reconnectTimer = null;
  let pollTimer = null;

  // ---- DOM refs ----
  const $ = function (id) { return document.getElementById(id); };
  const runningCount = $('runningCount');
  const queuedCount = $('queuedCount');
  const completedCount = $('completedCount');
  const failedCount = $('failedCount');
  const sseSubscribersCount = $('sseSubscribersCount');
  const pendingEventsCount = $('pendingEventsCount');
  const tasksTableBody = $('tasksTableBody');
  const providersGrid = $('providersGrid');
  const hostsGrid = $('hostsGrid');
  const formatsGrid = $('formatsGrid');
  const eventHistoryBody = $('eventHistoryBody');
  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const outputModal = $('outputModal');
  const outputModalClose = $('outputModalClose');
  const outputTaskId = $('outputTaskId');
  const outputContent = $('outputContent');
  const agentsTableBody = $('agentsTableBody');
  const agentsRefreshButton = $('agentsRefreshButton');
  const agentRegisterForm = $('agentRegisterForm');
  const agentRegisterMessage = $('agentRegisterMessage');
  const notificationToggle = $('notificationToggle');
  const notificationPrefsBtn = $('notificationPrefsBtn');
  const prefsModal = $('prefsModal');
  const prefsModalClose = $('prefsModalClose');

  // ---- Safe DOM helpers ----
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'className') node.className = attrs[k];
        else if (k === 'title') node.title = attrs[k];
        else if (k === 'colSpan') node.colSpan = attrs[k];
        else if (k === 'onclick') node.addEventListener('click', attrs[k]);
        else if (k === 'type') node.type = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (typeof children === 'string') {
      node.textContent = children;
    } else if (Array.isArray(children)) {
      children.forEach(function (c) { if (c) node.appendChild(c); });
    } else if (children instanceof Node) {
      node.appendChild(children);
    }
    return node;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function shortId(id) {
    return id ? id.slice(0, 8) + '...' : '-';
  }

  function fmtDate(iso) {
    if (!iso) return '-';
    try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) { return r.json(); });
  }

  function postAction(taskId, action) {
    return fetch('/api/tasks/' + encodeURIComponent(taskId) + '/' + action, {
      method: 'POST', headers: API_HEADERS, body: '{}'
    });
  }

  function statusBadgeEl(status) {
    return el('span', { className: 'status-badge status-' + (status || 'unknown') }, status || 'unknown');
  }

  function emptyRow(colspan, text) {
    return el('tr', { className: 'empty-state' }, [el('td', { colSpan: colspan }, text)]);
  }

  // ---- Stats ----
  function loadStats() {
    fetchJson('/api/stats/overview').then(function (data) {
      if (data.running !== undefined) runningCount.textContent = data.running;
      if (data.queued !== undefined) queuedCount.textContent = data.queued;
      if (data.completed !== undefined) completedCount.textContent = data.completed;
      if (data.failed !== undefined) failedCount.textContent = data.failed;
      if (data.sse_subscribers !== undefined) sseSubscribersCount.textContent = data.sse_subscribers;
      if (data.pending_events !== undefined) pendingEventsCount.textContent = data.pending_events;
    }).catch(function () { /* silent */ });
  }

  // ---- Tasks ----
  function buildTaskRow(t) {
    var actions = [];

    if (t.status === 'failed' || t.status === 'cancelled') {
      actions.push(el('button', {
        className: 'action-button small',
        type: 'button',
        onclick: function () { postAction(t.id, 'retry').then(loadTasks); }
      }, 'Retry'));
    }
    if (t.status === 'running' || t.status === 'queued') {
      actions.push(el('button', {
        className: 'action-button small danger',
        type: 'button',
        onclick: function () { postAction(t.id, 'cancel').then(loadTasks); }
      }, 'Cancel'));
    }
    actions.push(el('button', {
      className: 'action-button small',
      type: 'button',
      onclick: function () { viewOutput(t.id); }
    }, 'Output'));
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
      actions.push(el('button', {
        className: 'action-button small danger',
        type: 'button',
        onclick: function () { postAction(t.id, 'remove').then(loadTasks); }
      }, 'Remove'));
    }

    var actionsCell = el('td', { className: 'task-actions' }, actions);

    return el('tr', null, [
      el('td', { title: t.id }, shortId(t.id)),
      el('td', null, [statusBadgeEl(t.status)]),
      el('td', null, t.provider || '-'),
      el('td', null, (t.description || '').slice(0, 80)),
      el('td', null, fmtDate(t.created_at)),
      actionsCell
    ]);
  }

  function loadTasks() {
    var url = '/api/tasks?limit=50';
    if (activeFilter) url += '&status=' + encodeURIComponent(activeFilter);
    fetchJson(url).then(function (data) {
      var tasks = data.tasks || data || [];
      clearNode(tasksTableBody);
      if (!tasks.length) {
        tasksTableBody.appendChild(emptyRow(6, 'No tasks'));
        return;
      }
      tasks.forEach(function (t) {
        tasksTableBody.appendChild(buildTaskRow(t));
      });
    }).catch(function () { /* silent */ });
  }

  // ---- Providers ----
  var PROVIDER_GROUPS = {
    'Local (Ollama)': ['ollama', 'hashline-ollama'],
    'Cloud (Subscription CLI)': ['codex', 'claude-cli'],
    'Cloud (API — Bring Your Own Key)': []  // everything else
  };

  function getProviderGroup(name) {
    if (PROVIDER_GROUPS['Local (Ollama)'].indexOf(name) !== -1) return 'Local (Ollama)';
    if (PROVIDER_GROUPS['Cloud (Subscription CLI)'].indexOf(name) !== -1) return 'Cloud (Subscription CLI)';
    return 'Cloud (API — Bring Your Own Key)';
  }

  function renderProviderRow(p) {
    var s = p.stats || {};
    var total = s.total_tasks || 0;
    var rate = s.success_rate || 0;
    var avg = s.avg_duration_seconds ? s.avg_duration_seconds.toFixed(1) + 's' : '-';

    var nameEl = el('div', { className: 'provider-row-name' });
    nameEl.textContent = p.name || p.provider || 'unknown';
    if (p.enabled === false || p.enabled === 0) {
      nameEl.appendChild(document.createTextNode(' '));
      nameEl.appendChild(el('span', { className: 'host-disabled-badge' }, 'disabled'));
    }

    var barFillClass = 'provider-row-bar-fill';
    if (rate < 50) barFillClass += ' rate-error';
    else if (rate < 80) barFillClass += ' rate-warning';

    var barFill = el('div', { className: barFillClass });
    barFill.style.width = (total > 0 ? rate : 0) + '%';

    var stats = el('div', { className: 'provider-row-stats' }, [
      el('span', null, total + ' tasks'),
      el('span', null, rate + '%'),
      el('span', null, avg)
    ]);

    return el('div', { className: 'provider-row' }, [
      nameEl,
      el('div', { className: 'provider-row-bar' }, [barFill]),
      stats
    ]);
  }

  function loadProviders() {
    fetchJson('/api/providers').then(function (providers) {
      clearNode(providersGrid);
      if (!Array.isArray(providers) || !providers.length) {
        providersGrid.appendChild(el('div', { className: 'provider-row' }, [
          el('div', { className: 'provider-row-name' }, 'No providers')
        ]));
        return;
      }

      var groups = { 'Local (Ollama)': [], 'Cloud (Subscription CLI)': [], 'Cloud (API — Bring Your Own Key)': [] };
      providers.forEach(function (p) {
        var name = p.provider || p.name || '';
        var group = getProviderGroup(name);
        groups[group].push(p);
      });

      ['Local (Ollama)', 'Cloud (Subscription CLI)', 'Cloud (API — Bring Your Own Key)'].forEach(function (groupName) {
        var groupProviders = groups[groupName];
        if (!groupProviders.length) return;

        var header = el('div', { className: 'provider-group-header' }, groupName);
        providersGrid.appendChild(header);

        groupProviders.forEach(function (p) {
          providersGrid.appendChild(renderProviderRow(p));
        });
      });
    }).catch(function () { /* silent */ });
  }

  // ---- Hosts ----
  function loadHosts() {
    fetchJson('/api/hosts').then(function (hosts) {
      clearNode(hostsGrid);
      if (!Array.isArray(hosts) || !hosts.length) {
        hostsGrid.appendChild(el('div', { className: 'card host-card' }, [
          el('div', { className: 'card-label' }, 'No hosts')
        ]));
        return;
      }
      hosts.forEach(function (h) {
        var statusClass = 'card host-card';
        if (h.status === 'healthy') statusClass += ' host-healthy';
        else if (h.status === 'down') statusClass += ' host-down';

        var meta = 'Status: ' + (h.status || 'unknown') +
          ' | Running: ' + (h.running_tasks || 0) +
          ' | Models: ' + (h.model_count || (h.models ? h.models.length : 0));

        hostsGrid.appendChild(el('div', { className: statusClass }, [
          el('div', { className: 'card-label' }, h.name || h.id || 'unknown'),
          el('div', { className: 'host-meta' }, h.url || ''),
          el('div', { className: 'host-meta' }, meta)
        ]));
      });
    }).catch(function () { /* silent */ });
  }

  // ---- Format Success ----
  function loadFormats() {
    fetchJson('/api/stats/format-success').then(function (formats) {
      clearNode(formatsGrid);
      if (!Array.isArray(formats) || !formats.length) {
        formatsGrid.appendChild(el('div', { className: 'card format-card' }, [
          el('div', { className: 'card-label' }, 'No format data')
        ]));
        return;
      }
      formats.forEach(function (f) {
        var rate = f.total > 0 ? Math.round((f.succeeded / f.total) * 100) : 0;
        formatsGrid.appendChild(el('div', { className: 'card format-card' }, [
          el('div', { className: 'card-label' }, f.format || 'unknown'),
          el('div', { className: 'provider-stats' }, [
            el('span', null, rate + '% (' + (f.succeeded || 0) + '/' + (f.total || 0) + ')')
          ])
        ]));
      });
    }).catch(function () { /* silent */ });
  }

  // ---- Notification Metrics ----
  function loadNotificationMetrics() {
    fetchJson('/api/stats/notifications').then(function (data) {
      if ($('metricsDelivered')) $('metricsDelivered').textContent = data.delivered || 0;
      if ($('metricsDeduplicated')) $('metricsDeduplicated').textContent = data.deduplicated || 0;
      if ($('metricsAcknowledged')) $('metricsAcknowledged').textContent = data.acknowledged || 0;
      if ($('metricsErrors')) $('metricsErrors').textContent = data.errors || 0;
    }).catch(function () { /* silent */ });
  }

  // ---- Event History ----
  function loadEventHistory() {
    fetchJson('/api/stats/event-history').then(function (events) {
      clearNode(eventHistoryBody);
      if (!Array.isArray(events) || !events.length) {
        eventHistoryBody.appendChild(emptyRow(6, 'No events'));
        return;
      }
      events.slice(0, 50).forEach(function (e) {
        eventHistoryBody.appendChild(el('tr', null, [
          el('td', { title: e.task_id || '' }, shortId(e.task_id || '')),
          el('td', null, e.event || e.event_type || '-'),
          el('td', null, [statusBadgeEl(e.status)]),
          el('td', null, e.duration ? e.duration + 's' : '-'),
          el('td', null, e.project || '-'),
          el('td', null, fmtDate(e.timestamp || e.created_at))
        ]));
      });
    }).catch(function () { /* silent */ });
  }

  // ---- Agents ----
  function loadAgents() {
    fetchJson('/api/agents').then(function (agents) {
      clearNode(agentsTableBody);
      if (!Array.isArray(agents) || !agents.length) {
        agentsTableBody.appendChild(emptyRow(7, 'No agents registered'));
        return;
      }
      agents.forEach(function (a) {
        agentsTableBody.appendChild(el('tr', null, [
          el('td', null, a.id),
          el('td', null, a.name || '-'),
          el('td', null, (a.host || '?') + ':' + (a.port || '?')),
          el('td', null, [statusBadgeEl(a.status || 'unknown')]),
          el('td', null, fmtDate(a.last_health_check)),
          el('td', null, (a.enabled !== false && a.enabled !== 0) ? 'Yes' : 'No'),
          el('td', null, [el('button', {
            className: 'action-button small danger',
            type: 'button',
            onclick: function () {
              if (!confirm('Delete agent ' + a.id + '?')) return;
              fetch('/api/agents/' + encodeURIComponent(a.id), { method: 'DELETE', headers: API_HEADERS })
                .then(loadAgents);
            }
          }, 'Delete')])
        ]));
      });
    }).catch(function () { /* silent */ });
  }

  // ---- Output Modal ----
  function viewOutput(id) {
    fetchJson('/api/tasks/' + encodeURIComponent(id)).then(function (task) {
      outputTaskId.textContent = shortId(id);
      outputContent.textContent = task.output || task.error_output || '(no output)';
      outputModal.style.display = 'flex';
    }).catch(function () {
      outputTaskId.textContent = shortId(id);
      outputContent.textContent = '(failed to load output)';
      outputModal.style.display = 'flex';
    });
  }

  if (outputModalClose) {
    outputModalClose.addEventListener('click', function () { outputModal.style.display = 'none'; });
  }
  if (outputModal) {
    outputModal.addEventListener('click', function (e) {
      if (e.target === outputModal) outputModal.style.display = 'none';
    });
  }

  // ---- Notification Prefs Modal ----
  if (notificationPrefsBtn && prefsModal) {
    notificationPrefsBtn.addEventListener('click', function () {
      prefsModal.style.display = prefsModal.style.display === 'flex' ? 'none' : 'flex';
    });
  }
  if (prefsModalClose && prefsModal) {
    prefsModalClose.addEventListener('click', function () { prefsModal.style.display = 'none'; });
    prefsModal.addEventListener('click', function (e) {
      if (e.target === prefsModal) prefsModal.style.display = 'none';
    });
  }

  // ---- Desktop Notifications ----
  var desktopNotifs = false;
  if (notificationToggle) {
    notificationToggle.addEventListener('click', function () {
      if (!desktopNotifs && 'Notification' in window) {
        Notification.requestPermission().then(function (p) {
          desktopNotifs = p === 'granted';
          notificationToggle.textContent = 'Notifications: ' + (desktopNotifs ? 'On' : 'Off');
        });
      } else {
        desktopNotifs = !desktopNotifs;
        notificationToggle.textContent = 'Notifications: ' + (desktopNotifs ? 'On' : 'Off');
      }
    });
  }

  // ---- Agent Registration ----
  if (agentRegisterForm) {
    agentRegisterForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(agentRegisterForm);
      var payload = {
        id: fd.get('id'), name: fd.get('name'), host: fd.get('host'),
        port: parseInt(fd.get('port'), 10) || 3460, secret: fd.get('secret')
      };
      fetch('/api/agents', { method: 'POST', headers: API_HEADERS, body: JSON.stringify(payload) })
        .then(function (r) { return r.json(); })
        .then(function () {
          agentRegisterMessage.textContent = 'Agent registered';
          agentRegisterForm.reset();
          loadAgents();
          setTimeout(function () { agentRegisterMessage.textContent = ''; }, 3000);
        })
        .catch(function (err) { agentRegisterMessage.textContent = 'Error: ' + err.message; });
    });
  }

  if (agentsRefreshButton) {
    agentsRefreshButton.addEventListener('click', loadAgents);
  }

  // ---- WebSocket ----
  function connectWs() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host);

    ws.onopen = function () {
      statusDot.className = 'status-dot connected';
      statusText.textContent = 'Connected';
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.event === 'stats:updated' && msg.data) {
          if (msg.data.running !== undefined) runningCount.textContent = msg.data.running;
          if (msg.data.queued !== undefined) queuedCount.textContent = msg.data.queued;
          if (msg.data.completed !== undefined) completedCount.textContent = msg.data.completed;
          if (msg.data.failed !== undefined) failedCount.textContent = msg.data.failed;
        }
        if (msg.event === 'task:created' || msg.event === 'tasks:batch-updated' || msg.event === 'task:deleted') {
          loadTasks();
        }
        if (msg.event === 'task:event') {
          loadEventHistory();
        }
      } catch (_) { /* ignore */ }
    };

    ws.onclose = function () {
      statusDot.className = 'status-dot disconnected';
      statusText.textContent = 'Disconnected';
      scheduleReconnect();
    };

    ws.onerror = function () {
      statusDot.className = 'status-dot disconnected';
      statusText.textContent = 'Error';
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connectWs();
    }, 3000);
  }

  // ---- Filters ----
  var filterBtns = document.querySelectorAll('.filter-btn');
  for (var i = 0; i < filterBtns.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        for (var j = 0; j < filterBtns.length; j++) filterBtns[j].classList.remove('active');
        btn.classList.add('active');
        activeFilter = btn.getAttribute('data-status') || '';
        loadTasks();
      });
    })(filterBtns[i]);
  }

  // ---- Init ----
  function loadAll() {
    loadStats();
    loadTasks();
    loadProviders();
    loadHosts();
    loadFormats();
    loadNotificationMetrics();
    loadEventHistory();
    loadAgents();
  }

  loadAll();
  connectWs();

  // Fallback polling when WebSocket is disconnected
  pollTimer = setInterval(function () {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      loadAll();
    }
  }, POLL_INTERVAL);
})();
