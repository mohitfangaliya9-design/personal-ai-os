/**
 * app.js
 * -----------------------------------------------------------------------
 * Frontend-only dashboard logic for the Personal AI OS.
 *
 * No AI/planning/database/execution logic lives here — this file only
 * talks to the existing backend endpoints and renders the result safely.
 *
 * Preserved behavior:
 *   GET  /health
 *   GET  /api/agents
 *   GET  /api/tasks
 *   POST /api/tasks  { request }
 *
 * Preserved DOM IDs:
 *   #health #agents #tasks #run #request #output #refresh
 * -----------------------------------------------------------------------
 */

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------------
// HTML escaping (kept, used for anything derived from server/user data)
// ---------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[c]));
}

// ---------------------------------------------------------------------
// API helper
// -----------------------------------------------------------------------
// - Never throws raw network errors straight into the UI; always returns
//   a user-friendly message.
// - Handles non-JSON / empty response bodies without crashing.
// - Never surfaces secrets/tokens/DATABASE_URL/stack traces: only ever
//   shows a plain string message.

async function api(url, opts) {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
      ...opts,
    });
  } catch (networkError) {
    throw new Error('Network error: could not reach the server.');
  }

  let body = null;
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON response body — treat as opaque, do not surface raw text
      // (could contain server internals we don't want to display).
      body = null;
    }
  }

  if (!response.ok) {
    const serverMessage =
      body && typeof body === 'object' && typeof body.error === 'string' && body.error.trim()
        ? body.error
        : null;
    throw new Error(serverMessage || `Request failed (HTTP ${response.status})`);
  }

  return body;
}

// ---------------------------------------------------------------------
// Response validation helpers
// ---------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

// ---------------------------------------------------------------------
// Rendering (textContent/createElement — no innerHTML with untrusted data)
// ---------------------------------------------------------------------

function renderList(container, items, emptyMessage, buildItem) {
  container.textContent = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = emptyMessage;
    container.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    fragment.appendChild(buildItem(item));
  }
  container.appendChild(fragment);
}

function buildAgentItem(agent) {
  const div = document.createElement('div');
  div.className = 'item';

  const name = document.createElement('b');
  name.textContent = safeText(agent?.name, 'Unnamed agent');

  const role = document.createElement('small');
  role.textContent = safeText(agent?.role, 'unknown role');

  div.appendChild(name);
  div.appendChild(document.createElement('br'));
  div.appendChild(role);
  return div;
}

function buildTaskItem(task) {
  const div = document.createElement('div');
  div.className = 'item';

  const status = document.createElement('b');
  status.textContent = safeText(task?.status, 'UNKNOWN');

  const request = document.createElement('small');
  request.textContent = safeText(task?.request, '(no request text)');

  div.appendChild(status);
  div.appendChild(document.createElement('br'));
  div.appendChild(request);
  return div;
}

// ---------------------------------------------------------------------
// Refresh
// -----------------------------------------------------------------------
// Each section is fetched independently so one failure doesn't block the
// others. A monotonically increasing token guards against a slower,
// older refresh() call overwriting the UI after a newer one has already
// completed (race condition guard).

let refreshToken = 0;

async function refresh() {
  const token = ++refreshToken;
  const isStale = () => token !== refreshToken;

  // Health
  try {
    const h = await api('/health');
    if (isStale()) return;
    const status = safeText(h?.status, 'unknown');
    $('#health').textContent = `System ${status}`;
    const db = safeText(h?.database, 'unknown');
    const ai = safeText(h?.ai, 'unknown');
    const mcp = safeText(h?.mcp, 'unknown');
    $('#health').title = `DB: ${db} · AI: ${ai} · MCP: ${mcp}`;
  } catch (e) {
    if (isStale()) return;
    $('#health').textContent = 'Offline';
    $('#health').title = e.message;
  }

  // Agents
  try {
    const a = await api('/api/agents');
    if (isStale()) return;
    renderList($('#agents'), asArray(a), 'No agents yet.', buildAgentItem);
  } catch (e) {
    if (isStale()) return;
    $('#agents').textContent = e.message;
  }

  // Tasks
  try {
    const t = await api('/api/tasks');
    if (isStale()) return;
    renderList($('#tasks'), asArray(t).slice(0, 8), 'No tasks yet.', buildTaskItem);
  } catch (e) {
    if (isStale()) return;
    $('#tasks').textContent = e.message;
  }
}

// ---------------------------------------------------------------------
// Task submission
// -----------------------------------------------------------------------
// Guards against duplicate submissions (button disabled while running),
// always restores button state, clears input only on success, and
// refreshes the dashboard after a successful submission.

let submitting = false;

async function submitTask() {
  if (submitting) return;

  const input = $('#request');
  const request = input.value.trim();
  if (!request) return;

  const out = $('#output');
  const runButton = $('#run');

  submitting = true;
  runButton.disabled = true;
  const originalLabel = runButton.textContent;
  runButton.textContent = 'Running…';

  out.style.display = 'block';
  out.textContent = 'Planning…';

  try {
    const result = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ request }),
    });

    out.textContent = JSON.stringify(result, null, 2);
    input.value = '';
    await refresh();
  } catch (e) {
    out.textContent = `Error: ${e.message}`;
  } finally {
    submitting = false;
    runButton.disabled = false;
    runButton.textContent = originalLabel;
  }
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

$('#run').addEventListener('click', submitTask);
$('#refresh').addEventListener('click', refresh);

// Enter submits (without interfering with normal input editing);
// Shift+Enter (in case of a future textarea) still inserts a newline.
$('#request').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitTask();
  }
});

refresh();
