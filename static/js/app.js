/* ═══════════════════════════════════════════════════════════
   AI Agent Sandbox — Frontend
   Sessions persisted in SQLite via REST API.
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl          = document.getElementById('messages');
const welcomeEl           = document.getElementById('welcome');
const messageInput        = document.getElementById('messageInput');
const sendBtn             = document.getElementById('sendBtn');
const activeModelLabel    = document.getElementById('activeModelLabel');
const chatHistoryList     = document.getElementById('chatHistoryList');
const newChatBtn          = document.getElementById('newChatBtn');
const newChatBtn2         = document.getElementById('newChatBtn2');
const deleteChatBtn       = document.getElementById('deleteChatBtn');
const statusDot           = document.getElementById('statusDot');
const statusText          = document.getElementById('statusText');
const activityFeed        = document.getElementById('activityFeed');
const activityPlaceholder = document.getElementById('activityPlaceholder');
const clearActivityBtn    = document.getElementById('clearActivityBtn');
const providerTabs        = document.getElementById('providerTabs');
const modelListEl         = document.getElementById('modelList');
const statModel           = document.getElementById('statModel');
const statStatus          = document.getElementById('statStatus');
const statToolCalls       = document.getElementById('statToolCalls');
const statMessages        = document.getElementById('statMessages');

// ── Session state ─────────────────────────────────────────────────────────────
/*
  In-memory session cache:
  {
    id:        string,
    title:     string,
    model:     string,
    msgCount:  number,
    toolCount: number,
    loaded:    boolean,   // true once messages fetched from DB
    turns:     [{ user: string, ai: string }],
  }
*/
let sessions     = [];   // ordered newest-first
let activeId     = null;
let isProcessing = false;

// Streaming turn state
let currentTurn     = null;
let currentAiMsgEl  = null;
let currentThinking = null;
let streamBuffer    = '';

// ── Model helpers ─────────────────────────────────────────────────────────────
function getSelectedModel() {
  const checked = document.querySelector('input[name="modelSelect"]:checked');
  return checked ? checked.value : 'gpt-4o-mini';
}

function setModelLabel(modelId) {
  activeModelLabel.textContent = shortModelName(modelId);
}

function selectModelInSidebar(modelId) {
  const radio = document.querySelector(`input[name="modelSelect"][value="${CSS.escape(modelId)}"]`);
  if (!radio) return;
  radio.checked = true;
  modelListEl.querySelectorAll('.sb-model-item').forEach(l => l.classList.remove('active'));
  radio.closest('.sb-model-item').classList.add('active');
  const group = radio.closest('.sb-model-group');
  if (group) {
    const prov = group.dataset.provider;
    providerTabs.querySelectorAll('.sb-tab').forEach(t => t.classList.toggle('active', t.dataset.provider === prov));
    modelListEl.querySelectorAll('.sb-model-group').forEach(g => {
      g.style.display = g.dataset.provider === prov ? 'flex' : 'none';
    });
  }
  setModelLabel(modelId);
}

// Provider tab switching
providerTabs.querySelectorAll('.sb-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    providerTabs.querySelectorAll('.sb-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    modelListEl.querySelectorAll('.sb-model-group').forEach(g => {
      g.style.display = g.dataset.provider === tab.dataset.provider ? 'flex' : 'none';
    });
  });
});

modelListEl.addEventListener('change', e => {
  if (e.target.name === 'modelSelect') {
    modelListEl.querySelectorAll('.sb-model-item').forEach(l => l.classList.remove('active'));
    e.target.closest('.sb-model-item').classList.add('active');
    setModelLabel(e.target.value);
    const sess = getActiveSession();
    if (sess) {
      sess.model = e.target.value;
      api('PATCH', `/api/sessions/${sess.id}`, { model: sess.model });
    }
  }
});

// ── REST API helpers ──────────────────────────────────────────────────────────
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) console.error(`API ${method} ${url} →`, res.status);
  return res.json().catch(() => ({}));
}

// ── Session management ────────────────────────────────────────────────────────
async function loadSessionsFromDB() {
  const rows = await api('GET', '/api/sessions');
  if (!Array.isArray(rows)) return;
  sessions = rows.map(r => ({
    id: r.id, title: r.title, model: r.model,
    msgCount: 0, toolCount: 0, loaded: false, turns: [],
  }));
  chatHistoryList.innerHTML = '';
  sessions.forEach(s => renderHistoryItem(s));

  if (sessions.length > 0) {
    switchSession(sessions[0].id);
  } else {
    showWelcome();
  }
}

async function createSession(switchTo = true) {
  const id    = `sess-${Date.now()}`;
  const model = getSelectedModel();
  const sess  = { id, title: 'New Chat', model, msgCount: 0, toolCount: 0, loaded: true, turns: [] };
  sessions.unshift(sess);
  await api('POST', '/api/sessions', { id, title: 'New Chat', model });
  prependHistoryItem(sess);
  if (switchTo) switchSession(id);
  return sess;
}

async function switchSession(id) {
  if (activeId === id) return;
  activeId = id;

  chatHistoryList.querySelectorAll('.sb-history-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  const sess = getSession(id);
  clearActivity();
  resetStats();
  messagesEl.innerHTML = '';

  if (!sess.loaded) {
    // Fetch messages from DB
    const rows = await api('GET', `/api/sessions/${id}/messages`);
    if (Array.isArray(rows)) {
      // Group into turns: consecutive user+ai pairs
      sess.turns = [];
      let pending = null;
      for (const m of rows) {
        if (m.role === 'user') {
          if (pending) sess.turns.push(pending);
          pending = { user: m.content, ai: '' };
        } else if (m.role === 'ai' && pending) {
          pending.ai = m.content;
        }
      }
      if (pending) sess.turns.push(pending);
      sess.msgCount = sess.turns.filter(t => t.ai).length;
    }
    sess.loaded = true;
  }

  if (sess.turns.length === 0) {
    showWelcome();
  } else {
    sess.turns.forEach(t => {
      const turn = document.createElement('div');
      turn.className = 'turn';
      turn.innerHTML =
        `<div class="user-label">You</div>` +
        `<div class="user-msg">${escapeHtml(t.user)}</div>` +
        (t.ai
          ? `<div class="ai-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>${escapeHtml(shortModelName(sess.model))}</div>` +
            `<div class="ai-msg">${escapeHtml(t.ai)}</div>`
          : '');
      messagesEl.appendChild(turn);
    });
    scrollBottom();
  }

  updateStat('statMessages',  sess.msgCount);
  updateStat('statToolCalls', sess.toolCount);
  selectModelInSidebar(sess.model);
}

async function deleteActiveSession() {
  if (!activeId) return;
  await api('DELETE', `/api/sessions/${activeId}`);
  const idx = sessions.findIndex(s => s.id === activeId);
  chatHistoryList.querySelector(`.sb-history-item[data-id="${activeId}"]`)?.remove();
  sessions.splice(idx, 1);
  activeId = null;

  if (sessions.length > 0) {
    switchSession(sessions[0].id);
  } else {
    messagesEl.innerHTML = '';
    showWelcome();
    clearActivity();
    resetStats();
  }
}

function getSession(id)   { return sessions.find(s => s.id === id); }
function getActiveSession() { return getSession(activeId); }

// ── Sidebar rendering ─────────────────────────────────────────────────────────
function renderHistoryItem(sess) {
  const item = _makeHistoryItem(sess);
  chatHistoryList.appendChild(item);
}

function prependHistoryItem(sess) {
  const item = _makeHistoryItem(sess);
  chatHistoryList.prepend(item);
}

function _makeHistoryItem(sess) {
  const item = document.createElement('div');
  item.className = 'sb-history-item';
  item.dataset.id = sess.id;
  item.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
    <span class="sb-history-item-title">${escapeHtml(sess.title)}</span>`;
  item.addEventListener('click', () => switchSession(sess.id));
  return item;
}

function updateHistoryItemTitle(id, title) {
  const el = chatHistoryList.querySelector(`.sb-history-item[data-id="${id}"] .sb-history-item-title`);
  if (el) el.textContent = title;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/chat`);
  ws.onopen  = () => { setStatus('connected', 'Connected'); setInputEnabled(true); };
  ws.onclose = () => { setStatus('error', 'Disconnected'); setInputEnabled(false); setTimeout(connect, 3000); };
  ws.onerror = () => setStatus('error', 'Connection error');
  ws.onmessage = e => { try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
}

// ── Event handler ─────────────────────────────────────────────────────────────
function handleEvent(evt) {
  switch (evt.type) {
    case 'message_start':
      startTurn();
      updateStat('statModel', shortModelName(evt.model));
      updateStat('statStatus', 'Processing…');
      addActivityCard('start', { title: `▶ ${shortModelName(evt.model)}`, expandedByDefault: false });
      break;

    case 'tool_start': {
      const inputStr = typeof evt.input === 'object' ? JSON.stringify(evt.input, null, 2) : String(evt.input ?? '');
      addToolCard(evt.tool, inputStr);
      const sess = getActiveSession();
      if (sess) { sess.toolCount = (sess.toolCount || 0) + 1; updateStat('statToolCalls', sess.toolCount); }
      break;
    }

    case 'tool_end':
      finalizeToolCard(evt.tool, evt.output);
      break;

    case 'token':
      appendToken(evt.token);
      break;

    case 'done':
      finishTurn(evt.output);
      break;

    case 'error':
      showError(evt.message);
      updateStat('statStatus', 'Error');
      addActivityCard('error', { title: '✕ Error', output: evt.message, expandedByDefault: true });
      setInputEnabled(true);
      isProcessing = false;
      break;
  }
}

// ── Send ──────────────────────────────────────────────────────────────────────
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isProcessing || !ws || ws.readyState !== WebSocket.OPEN) return;

  if (!activeId) await createSession();
  hideWelcome();
  addUserMessage(text);
  messageInput.value = '';
  resizeTextarea();
  isProcessing = true;
  setInputEnabled(false);

  ws.send(JSON.stringify({ message: text, model: getSelectedModel(), session_id: activeId }));
}

// ── Turn management ───────────────────────────────────────────────────────────
function startTurn() {
  removeThinking();
  currentTurn = document.createElement('div');
  currentTurn.className = 'turn';

  const label = document.createElement('div');
  label.className = 'ai-label';
  label.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>${escapeHtml(shortModelName(getSelectedModel()))}`;
  currentTurn.appendChild(label);

  currentThinking = document.createElement('div');
  currentThinking.className = 'thinking-indicator';
  currentThinking.innerHTML = `<span>Thinking</span><div class="thinking-dots"><span></span><span></span><span></span></div>`;
  currentTurn.appendChild(currentThinking);

  messagesEl.appendChild(currentTurn);
  scrollBottom();
  currentAiMsgEl = null;
  streamBuffer   = '';
}

function appendToken(token) {
  if (!currentTurn) return;
  if (currentThinking) { currentThinking.remove(); currentThinking = null; }
  if (!currentAiMsgEl) {
    currentAiMsgEl = document.createElement('div');
    currentAiMsgEl.className = 'ai-msg';
    currentAiMsgEl.innerHTML = '<span class="streaming-cursor"></span>';
    currentTurn.appendChild(currentAiMsgEl);
  }
  streamBuffer += token;
  const cursor = currentAiMsgEl.querySelector('.streaming-cursor');
  if (cursor) cursor.before(document.createTextNode(token));
  else currentAiMsgEl.appendChild(document.createTextNode(token));
  scrollBottom();
}

function finishTurn(finalOutput) {
  removeThinking();
  isProcessing = false;
  setInputEnabled(true);
  messageInput.focus();

  if (currentAiMsgEl) {
    const cursor = currentAiMsgEl.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();
    if (finalOutput && finalOutput.trim() !== streamBuffer.trim()) currentAiMsgEl.textContent = finalOutput;
  } else if (finalOutput && currentTurn) {
    const bubble = document.createElement('div');
    bubble.className = 'ai-msg';
    bubble.textContent = finalOutput;
    currentTurn.appendChild(bubble);
  }

  // Update in-memory session turns
  const sess = getActiveSession();
  if (sess) {
    const last = sess.turns[sess.turns.length - 1];
    if (last && last.ai === '') last.ai = finalOutput || streamBuffer;
    sess.msgCount = (sess.msgCount || 0) + 1;
    updateStat('statMessages', sess.msgCount);
    updateStat('statStatus', 'Idle');
  }

  currentTurn = null; currentAiMsgEl = null; streamBuffer = '';
  scrollBottom();
}

function removeThinking() {
  if (currentThinking) { currentThinking.remove(); currentThinking = null; }
}

// ── Messages ──────────────────────────────────────────────────────────────────
function addUserMessage(text) {
  hideWelcome();
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `<div class="user-label">You</div><div class="user-msg">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(turn);
  scrollBottom();

  const sess = getActiveSession();
  if (sess) {
    if (sess.title === 'New Chat') {
      const title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
      sess.title = title;
      updateHistoryItemTitle(sess.id, title);
      api('PATCH', `/api/sessions/${sess.id}`, { title });
    }
    sess.turns.push({ user: text, ai: '' });
  }
}

function showError(msg) {
  removeThinking();
  const container = currentTurn || (() => {
    const t = document.createElement('div');
    t.className = 'turn';
    messagesEl.appendChild(t);
    return t;
  })();
  const errEl = document.createElement('div');
  errEl.className = 'error-msg';
  errEl.textContent = `Error: ${msg}`;
  container.appendChild(errEl);
  currentTurn = null; currentAiMsgEl = null;
  scrollBottom();
}

// ── Activity panel ────────────────────────────────────────────────────────────
function addActivityCard(type, { title, input, output, badge, expandedByDefault }) {
  if (activityPlaceholder) activityPlaceholder.style.display = 'none';
  const card = document.createElement('div');
  card.className = `activity-card card-${type}`;

  const badgeHtml  = badge ? `<span class="status-badge badge-${badge}">${badge}</span>` : '';
  let bodyContent  = '';
  if (input  !== undefined) bodyContent += `<div class="card-section-label">Input</div><div class="card-code">${escapeHtml(toStr(input))}</div>`;
  if (output !== undefined) bodyContent += `<div class="card-section-label">Output</div><div class="card-code">${escapeHtml(toStr(output))}</div>`;
  const chevron = bodyContent
    ? `<svg class="card-chevron ${expandedByDefault ? 'open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>`
    : '';

  card.innerHTML = `
    <div class="card-header"><span>${escapeHtml(title)}</span>${badgeHtml}${chevron}</div>
    ${bodyContent ? `<div class="card-body ${expandedByDefault ? 'open' : ''}">${bodyContent}</div>` : ''}`;

  const header = card.querySelector('.card-header');
  const body   = card.querySelector('.card-body');
  const chev   = card.querySelector('.card-chevron');
  if (header && body) header.addEventListener('click', () => { const o = body.classList.toggle('open'); chev?.classList.toggle('open', o); });

  activityFeed.appendChild(card);
  activityFeed.scrollTop = activityFeed.scrollHeight;
}

function addToolCard(toolName, inputStr) {
  if (activityPlaceholder) activityPlaceholder.style.display = 'none';
  const card = document.createElement('div');
  card.className = 'activity-card card-tool';
  card.dataset.tool = toolName;

  const iconSvg = `<svg class="card-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`;
  card.innerHTML = `
    <div class="card-header">
      ${iconSvg}<span>${escapeHtml(toolName)}</span>
      <span class="status-badge badge-running">running</span>
      <svg class="card-chevron open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </div>
    <div class="card-body open">
      <div class="card-section-label">Input</div>
      <div class="card-code">${escapeHtml(inputStr)}</div>
      <div class="card-output-placeholder" style="color:var(--text-dim);font-size:11px;padding:4px 0">Waiting for output…</div>
    </div>`;

  const header = card.querySelector('.card-header');
  const body   = card.querySelector('.card-body');
  const chev   = card.querySelector('.card-chevron');
  header.addEventListener('click', () => { const o = body.classList.toggle('open'); chev.classList.toggle('open', o); });
  activityFeed.appendChild(card);
  activityFeed.scrollTop = activityFeed.scrollHeight;
}

function finalizeToolCard(toolName, output) {
  const cards = activityFeed.querySelectorAll(`.activity-card.card-tool[data-tool="${CSS.escape(toolName)}"]`);
  for (let i = cards.length - 1; i >= 0; i--) {
    const badge = cards[i].querySelector('.status-badge.badge-running');
    if (!badge) continue;
    badge.textContent = 'done';
    badge.className = 'status-badge badge-done';
    const body = cards[i].querySelector('.card-body');
    cards[i].querySelector('.card-output-placeholder')?.remove();
    const label = document.createElement('div'); label.className = 'card-section-label'; label.textContent = 'Output';
    const code  = document.createElement('div'); code.className  = 'card-code';           code.textContent  = toStr(output);
    body.appendChild(label); body.appendChild(code);
    activityFeed.scrollTop = activityFeed.scrollHeight;
    break;
  }
}

function clearActivity() {
  activityFeed.innerHTML = '';
  if (activityPlaceholder) { activityFeed.appendChild(activityPlaceholder); activityPlaceholder.style.display = 'flex'; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showWelcome() {
  messagesEl.innerHTML = '';
  const w = welcomeEl.cloneNode(true);
  w.style.display = '';
  messagesEl.appendChild(w);
}

function hideWelcome() {
  const w = messagesEl.querySelector('.welcome');
  if (w) w.style.display = 'none';
}

function setStatus(cls, text) { statusDot.className = `status-dot ${cls}`; statusText.textContent = text; }
function setInputEnabled(on)  { messageInput.disabled = !on; sendBtn.disabled = !on; if (on) messageInput.focus(); }
function scrollBottom()       { messagesEl.scrollTop = messagesEl.scrollHeight; }
function updateStat(id, val)  { const el = document.getElementById(id); if (el) el.textContent = val; }

function resetStats() {
  updateStat('statModel', '—'); updateStat('statStatus', 'Idle');
  updateStat('statToolCalls', 0); updateStat('statMessages', 0);
}

function toStr(val) {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(toStr).join('\n');
  if (val !== null && typeof val === 'object') return 'text' in val ? val.text : JSON.stringify(val, null, 2);
  return String(val ?? '');
}

function shortModelName(modelId) {
  if (!modelId) return '—';
  const map = {
    'claude-opus-4-6':'🟣 Opus 4.6','claude-sonnet-4-6':'🟣 Sonnet 4.6',
    'claude-haiku-4-5-20251001':'🟣 Haiku 4.5','claude-3-5-sonnet-20241022':'🟣 3.5 Sonnet',
    'claude-3-5-haiku-20241022':'🟣 3.5 Haiku','claude-3-opus-20240229':'🟣 3 Opus',
    'gpt-4o':'🟢 GPT-4o','gpt-4o-mini':'🟢 GPT-4o Mini','gpt-4-turbo':'🟢 GPT-4 Turbo',
    'o3-mini':'🟢 o3 Mini','o1-mini':'🟢 o1 Mini',
    'gemini-2.0-flash':'🔵 Gemini 2.0 Flash','gemini-2.0-flash-lite':'🔵 Flash Lite',
    'gemini-2.5-pro-preview-03-25':'🔵 Gemini 2.5 Pro',
    'gemini-1.5-pro':'🔵 Gemini 1.5 Pro','gemini-1.5-flash':'🔵 Gemini 1.5 Flash',
  };
  return map[modelId] || modelId;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function resizeTextarea() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
}

// ── Event listeners ───────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
messageInput.addEventListener('input', resizeTextarea);

function startNewChat() {
  if (isProcessing) return;
  createSession(true).then(() => { clearActivity(); resetStats(); messageInput.focus(); });
}

newChatBtn.addEventListener('click', startNewChat);
newChatBtn2.addEventListener('click', startNewChat);

deleteChatBtn.addEventListener('click', () => { if (!isProcessing) deleteActiveSession(); });
clearActivityBtn.addEventListener('click', clearActivity);

// ── Init ──────────────────────────────────────────────────────────────────────
setStatus('connecting', 'Connecting…');
setModelLabel(getSelectedModel());
connect();
loadSessionsFromDB();   // populate sidebar from SQLite


/* ═══════════════════════════════════════════════════════════════════════════════
   MCP PLAYGROUND
   ═══════════════════════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────────────────────
let mcpServers     = [];    // [{id, name, transport, config_json, created_at}, ...]
let activeMcpId    = null;
let mcpTools       = [];    // [{name, description, inputSchema}, ...]
let mcpResources   = [];    // [{uri, name, description, mimeType}, ...]

// ── Page tab switching ────────────────────────────────────────────────────────
document.getElementById('pageTabs').addEventListener('click', e => {
  const btn = e.target.closest('.page-tab');
  if (!btn) return;
  const view = btn.dataset.view;
  document.querySelectorAll('.page-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === view));
  document.getElementById('viewChat').style.display = view === 'chat' ? '' : 'none';
  document.getElementById('viewMcp').style.display  = view === 'mcp'  ? '' : 'none';
  if (view === 'mcp' && mcpServers.length === 0) loadMcpServers();
});

// ── Load servers from DB ──────────────────────────────────────────────────────
async function loadMcpServers() {
  const rows = await api('GET', '/api/mcp-servers');
  if (!Array.isArray(rows)) return;
  mcpServers = rows;
  renderMcpServerList();
  if (mcpServers.length > 0 && !activeMcpId) {
    // Don't auto-connect, just show the server detail
    selectMcpServer(mcpServers[0].id);
  }
}

// ── Render server list ────────────────────────────────────────────────────────
function renderMcpServerList() {
  const list = document.getElementById('mcpServerList');
  list.innerHTML = '';
  mcpServers.forEach(s => {
    const item = document.createElement('div');
    item.className = 'mcp-server-item' + (s.id === activeMcpId ? ' active' : '');
    item.dataset.id = s.id;
    item.innerHTML =
      `<span class="mcp-server-item-name">${escapeHtml(s.name)}</span>` +
      `<span class="mcp-transport-pill">${escapeHtml(s.transport)}</span>`;
    item.addEventListener('click', () => selectMcpServer(s.id));
    list.appendChild(item);
  });
}

// ── Select a server ───────────────────────────────────────────────────────────
function selectMcpServer(id) {
  activeMcpId  = id;
  mcpTools     = [];
  mcpResources = [];
  renderMcpServerList();

  const server = mcpServers.find(s => s.id === id);
  if (!server) return;

  _mcpShowPanel('detail');
  document.getElementById('mcpDetailName').textContent      = server.name;
  document.getElementById('mcpDetailTransport').textContent = server.transport;
  setMcpStatus('idle', 'Not connected');
  document.getElementById('mcpResultTabs').style.display    = 'none';
  document.getElementById('mcpToolsContent').style.display     = 'none';
  document.getElementById('mcpResourcesContent').style.display = 'none';
  document.getElementById('mcpToolsList').innerHTML     = '';
  document.getElementById('mcpResourcesList').innerHTML = '';
}

// ── Show/hide the three centre-panel states ───────────────────────────────────
function _mcpShowPanel(which) {
  document.getElementById('mcpEmptyState').style.display   = which === 'empty'  ? '' : 'none';
  document.getElementById('mcpAddForm').style.display      = which === 'form'   ? '' : 'none';
  document.getElementById('mcpServerDetail').style.display = which === 'detail' ? '' : 'none';
}

// ── Add server button ─────────────────────────────────────────────────────────
document.getElementById('mcpAddServerBtn').addEventListener('click', () => {
  activeMcpId = null;
  renderMcpServerList();
  _mcpShowPanel('form');
  document.getElementById('mcpServerName').value  = '';
  document.getElementById('mcpConfigJson').value  = '';
  document.getElementById('mcpBearerToken').value = '';
  _mcpSetTransportTab('stdio');
});

// Transport tab switching (updates textarea placeholder)
document.getElementById('mcpTransportTabs').addEventListener('click', e => {
  const btn = e.target.closest('.mcp-transport-tab');
  if (!btn) return;
  _mcpSetTransportTab(btn.dataset.transport);
});

function _mcpSetTransportTab(transport) {
  document.querySelectorAll('.mcp-transport-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.transport === transport));
  const placeholders = {
    stdio:           '{"command": "npx", "args": ["-y", "@my/mcp-server"]}',
    sse:             '{"url": "http://localhost:8001/sse"}',
    streamable_http: '{"url": "http://localhost:8001/mcp"}',
  };
  document.getElementById('mcpConfigJson').placeholder = placeholders[transport] || '';
}

// Cancel add
document.getElementById('mcpCancelAddBtn').addEventListener('click', () => {
  if (activeMcpId) {
    selectMcpServer(activeMcpId);
  } else if (mcpServers.length > 0) {
    selectMcpServer(mcpServers[0].id);
  } else {
    _mcpShowPanel('empty');
  }
});

// Save server
document.getElementById('mcpSaveServerBtn').addEventListener('click', async () => {
  const name      = document.getElementById('mcpServerName').value.trim();
  const configRaw = document.getElementById('mcpConfigJson').value.trim();
  const token     = document.getElementById('mcpBearerToken').value.trim();
  const transport = document.querySelector('.mcp-transport-tab.active')?.dataset.transport || 'stdio';

  if (!name)      { alert('Please enter a server name.'); return; }
  if (!configRaw) { alert('Please enter a config JSON.'); return; }

  let config;
  try { config = JSON.parse(configRaw); }
  catch { alert('Config must be valid JSON.'); return; }

  const result = await api('POST', '/api/mcp-servers', {
    name, transport, config, bearer_token: token || null,
  });
  if (result.error) { alert('Error: ' + result.error); return; }

  await loadMcpServers();
  // Auto-select the newly saved server
  selectMcpServer(result.id);
});

// ── Connect button ────────────────────────────────────────────────────────────
document.getElementById('mcpConnectBtn').addEventListener('click', async () => {
  if (!activeMcpId) return;
  const btn = document.getElementById('mcpConnectBtn');
  btn.disabled = true;
  setMcpStatus('connecting', 'Connecting…');

  try {
    const result = await api('POST', `/api/mcp-servers/${activeMcpId}/connect`);
    if (result.error) throw new Error(result.error);

    mcpTools     = result.tools     || [];
    mcpResources = result.resources || [];

    setMcpStatus('connected',
      `Connected · ${mcpTools.length} tool${mcpTools.length !== 1 ? 's' : ''}` +
      `, ${mcpResources.length} resource${mcpResources.length !== 1 ? 's' : ''}`);

    document.getElementById('mcpResultTabs').style.display = '';
    document.getElementById('mcpToolCount').textContent     = mcpTools.length;
    document.getElementById('mcpResourceCount').textContent = mcpResources.length;

    renderMcpTools();
    renderMcpResources();
    _mcpShowResultTab('tools');

  } catch (err) {
    setMcpStatus('error', 'Error: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── Delete button ─────────────────────────────────────────────────────────────
document.getElementById('mcpDeleteServerBtn').addEventListener('click', async () => {
  if (!activeMcpId) return;
  const name = mcpServers.find(s => s.id === activeMcpId)?.name || 'this server';
  if (!confirm(`Delete "${name}"?`)) return;
  await api('DELETE', `/api/mcp-servers/${activeMcpId}`);
  activeMcpId  = null;
  mcpTools     = [];
  mcpResources = [];
  await loadMcpServers();
  if (mcpServers.length === 0) _mcpShowPanel('empty');
});

// ── Tab switching (Tools / Resources) ─────────────────────────────────────────
document.getElementById('mcpResultTabs').addEventListener('click', e => {
  const btn = e.target.closest('.mcp-result-tab');
  if (!btn) return;
  _mcpShowResultTab(btn.dataset.tab);
});

function _mcpShowResultTab(tab) {
  document.querySelectorAll('.mcp-result-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('mcpToolsContent').style.display     = tab === 'tools'     ? '' : 'none';
  document.getElementById('mcpResourcesContent').style.display = tab === 'resources' ? '' : 'none';
}

// ── Render tools list ─────────────────────────────────────────────────────────
function renderMcpTools() {
  const list = document.getElementById('mcpToolsList');
  list.innerHTML = '';

  if (mcpTools.length === 0) {
    list.innerHTML = '<p class="mcp-empty-msg">No tools available on this server</p>';
    return;
  }

  mcpTools.forEach(tool => {
    const card = document.createElement('div');
    card.className = 'mcp-tool-card';

    const schema   = tool.inputSchema || {};
    const props    = schema.properties || {};
    const required = schema.required   || [];

    const paramHtml = Object.entries(props).map(([pName, pSchema]) => {
      const isReq = required.includes(pName);
      return `<div class="mcp-param-row">
        <label class="mcp-param-label">
          ${escapeHtml(pName)}${isReq ? ' <span class="mcp-required">*</span>' : ''}
          <span class="mcp-param-type">${escapeHtml(pSchema.type || 'any')}</span>
        </label>
        <input class="mcp-input mcp-param-input"
               data-param="${escapeHtml(pName)}"
               placeholder="${escapeHtml(pSchema.description || '')}" />
      </div>`;
    }).join('');

    card.innerHTML = `
      <div class="mcp-tool-header">
        <span class="mcp-tool-name">${escapeHtml(tool.name)}</span>
        <svg class="mcp-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>
      <div class="mcp-tool-body" style="display:none">
        ${tool.description ? `<p class="mcp-tool-desc">${escapeHtml(tool.description)}</p>` : ''}
        ${paramHtml}
        <div class="mcp-tool-actions">
          <button class="mcp-btn mcp-btn--primary mcp-run-btn">Run Tool</button>
        </div>
        <div class="mcp-response-area" style="display:none">
          <div class="mcp-response-label">Response</div>
          <pre class="mcp-response-output"></pre>
        </div>
      </div>`;

    // Toggle expand/collapse
    card.querySelector('.mcp-tool-header').addEventListener('click', () => {
      const body = card.querySelector('.mcp-tool-body');
      const chev = card.querySelector('.mcp-chevron');
      const open = body.style.display === 'none';
      body.style.display    = open ? '' : 'none';
      chev.style.transform  = open ? 'rotate(180deg)' : '';
    });

    // Run tool
    card.querySelector('.mcp-run-btn').addEventListener('click', async ev => {
      ev.stopPropagation();
      const btn         = card.querySelector('.mcp-run-btn');
      const responseArea = card.querySelector('.mcp-response-area');
      const responseOut  = card.querySelector('.mcp-response-output');
      btn.disabled      = true;
      btn.textContent   = 'Running…';
      responseArea.style.display = '';
      responseOut.className      = 'mcp-response-output';
      responseOut.textContent    = 'Waiting…';

      const args = {};
      card.querySelectorAll('.mcp-param-input').forEach(inp => {
        const val = inp.value.trim();
        if (val !== '') {
          try        { args[inp.dataset.param] = JSON.parse(val); }
          catch (_)  { args[inp.dataset.param] = val; }
        }
      });

      try {
        const result = await api(
          'POST',
          `/api/mcp-servers/${activeMcpId}/tools/${encodeURIComponent(tool.name)}/call`,
          { arguments: args }
        );
        if (result.error) throw new Error(result.error);

        const text = (result.content || [])
          .map(c => c.text !== undefined ? c.text : JSON.stringify(c))
          .join('\n');
        responseOut.textContent = text || '(empty response)';
        if (result.isError) responseOut.classList.add('mcp-response--error');

      } catch (err) {
        responseOut.textContent = 'Error: ' + err.message;
        responseOut.classList.add('mcp-response--error');
      } finally {
        btn.disabled    = false;
        btn.textContent = 'Run Tool';
      }
    });

    list.appendChild(card);
  });
}

// ── Render resources list ─────────────────────────────────────────────────────
function renderMcpResources() {
  const list = document.getElementById('mcpResourcesList');
  list.innerHTML = '';

  if (mcpResources.length === 0) {
    list.innerHTML = '<p class="mcp-empty-msg">No resources available on this server</p>';
    return;
  }

  mcpResources.forEach(resource => {
    const card = document.createElement('div');
    card.className = 'mcp-resource-card';
    card.innerHTML = `
      <div class="mcp-resource-header">
        <div class="mcp-resource-meta">
          <span class="mcp-resource-uri">${escapeHtml(resource.uri)}</span>
          ${resource.mimeType
            ? `<span class="mcp-resource-mime">${escapeHtml(resource.mimeType)}</span>`
            : ''}
          ${resource.description
            ? `<p class="mcp-resource-desc">${escapeHtml(resource.description)}</p>`
            : ''}
        </div>
        <button class="mcp-btn mcp-btn--secondary mcp-read-btn">Read</button>
      </div>
      <div class="mcp-response-area" style="display:none">
        <div class="mcp-response-label">Content</div>
        <pre class="mcp-response-output"></pre>
      </div>`;

    card.querySelector('.mcp-read-btn').addEventListener('click', async () => {
      const btn          = card.querySelector('.mcp-read-btn');
      const responseArea = card.querySelector('.mcp-response-area');
      const responseOut  = card.querySelector('.mcp-response-output');
      btn.disabled      = true;
      btn.textContent   = 'Reading…';
      responseArea.style.display = '';
      responseOut.className      = 'mcp-response-output';
      responseOut.textContent    = 'Waiting…';

      try {
        const result = await api(
          'POST',
          `/api/mcp-servers/${activeMcpId}/resources/read`,
          { uri: resource.uri }
        );
        if (result.error) throw new Error(result.error);

        const text = (result.contents || [])
          .map(c => c.text !== undefined ? c.text : `[blob: ${c.uri}]`)
          .join('\n---\n');
        responseOut.textContent = text || '(empty content)';

      } catch (err) {
        responseOut.textContent = 'Error: ' + err.message;
        responseOut.classList.add('mcp-response--error');
      } finally {
        btn.disabled    = false;
        btn.textContent = 'Read';
      }
    });

    list.appendChild(card);
  });
}

// ── Status helper ─────────────────────────────────────────────────────────────
function setMcpStatus(state, text) {
  const dot = document.getElementById('mcpStatusDot');
  const txt = document.getElementById('mcpStatusText');
  if (dot) dot.className = `mcp-status-dot mcp-status-dot--${state}`;
  if (txt) txt.textContent = text;
}
