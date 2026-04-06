/* ═══════════════════════════════════════════════════════════
   AI Agent Sandbox — Frontend
   3-column layout: sidebar (history + model) | chat | activity
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
const deleteChatBtn       = document.getElementById('deleteChatBtn');
const statusDot           = document.getElementById('statusDot');
const statusText          = document.getElementById('statusText');
const activityFeed        = document.getElementById('activityFeed');
const activityPlaceholder = document.getElementById('activityPlaceholder');
const clearActivityBtn    = document.getElementById('clearActivityBtn');
const statModel           = document.getElementById('statModel');
const statStatus          = document.getElementById('statStatus');
const statToolCalls       = document.getElementById('statToolCalls');
const statMessages        = document.getElementById('statMessages');
const providerTabs        = document.getElementById('providerTabs');
const modelListEl         = document.getElementById('modelList');

// ── Session state ─────────────────────────────────────────────────────────────
/*
  Session shape:
  {
    id:        string (uuid-ish),
    title:     string,
    model:     string (model-id),
    msgCount:  number,
    toolCount: number,
    turns:     [{ user: string, aiHtml: string }],   // for re-rendering on switch
    history:   [],  // LangChain messages sent to server (managed server-side per WS)
  }
  Note: the server keeps chat_history per WebSocket connection; we only track
  turn data client-side so we can re-render when switching sessions.
*/

let sessions      = [];
let activeId      = null;
let isProcessing  = false;

// Per-turn streaming state (reset each message)
let currentTurn     = null;
let currentAiMsgEl  = null;
let currentThinking = null;
let streamBuffer    = '';

// ── Model state ───────────────────────────────────────────────────────────────
function getSelectedModel() {
  const checked = document.querySelector('input[name="modelSelect"]:checked');
  return checked ? checked.value : 'gpt-4o-mini';
}

function setModelLabel(modelId) {
  activeModelLabel.textContent = shortModelName(modelId);
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

// When any radio changes
modelListEl.addEventListener('change', e => {
  if (e.target.name === 'modelSelect') {
    modelListEl.querySelectorAll('.sb-model-item').forEach(l => l.classList.remove('active'));
    e.target.closest('.sb-model-item').classList.add('active');
    setModelLabel(e.target.value);
    const sess = getActiveSession();
    if (sess) sess.model = e.target.value;
  }
});

// ── WebSocket ────────────────────────────────────────────────────────────────
let ws = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/chat`);

  ws.onopen = () => {
    setStatus('connected', 'Connected');
    setInputEnabled(true);
  };

  ws.onclose = () => {
    setStatus('error', 'Disconnected');
    setInputEnabled(false);
    setTimeout(connect, 3000);
  };

  ws.onerror = () => setStatus('error', 'Connection error');

  ws.onmessage = e => {
    try { handleEvent(JSON.parse(e.data)); }
    catch (err) { console.error('Parse error:', err); }
  };
}

// ── Event handler ─────────────────────────────────────────────────────────────
function handleEvent(evt) {
  switch (evt.type) {

    case 'message_start':
      startTurn();
      updateStat('statModel', shortModelName(evt.model));
      updateStat('statStatus', 'Processing…');
      addActivityCard('start', {
        title: `▶ ${shortModelName(evt.model)}`,
        expandedByDefault: false,
      });
      break;

    case 'tool_start': {
      const inputStr = typeof evt.input === 'object'
        ? JSON.stringify(evt.input, null, 2)
        : String(evt.input ?? '');
      addActivityCard('tool', {
        title: evt.tool,
        input: inputStr,
        badge: 'running',
        expandedByDefault: true,
      });
      const sess = getActiveSession();
      if (sess) {
        sess.toolCount = (sess.toolCount || 0) + 1;
        updateStat('statToolCalls', sess.toolCount);
      }
      break;
    }

    case 'tool_end':
      finalizeToolCard(evt.tool);
      addActivityCard('result', {
        title: `✓ ${evt.tool}`,
        output: evt.output,
        expandedByDefault: false,
      });
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
function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isProcessing || !ws || ws.readyState !== WebSocket.OPEN) return;

  // Ensure there's an active session
  if (!activeId) createSession();

  hideWelcome();
  addUserMessage(text);
  messageInput.value = '';
  resizeTextarea();
  isProcessing = true;
  setInputEnabled(false);

  ws.send(JSON.stringify({ message: text, model: getSelectedModel() }));
}

// ── Session management ────────────────────────────────────────────────────────
function createSession(switchTo = true) {
  const id = `sess-${Date.now()}`;
  const model = getSelectedModel();
  const sess = {
    id,
    title: 'New Chat',
    model,
    msgCount:  0,
    toolCount: 0,
    turns: [],
  };
  sessions.push(sess);
  renderHistoryItem(sess);
  if (switchTo) switchSession(id);
  return sess;
}

function renderHistoryItem(sess) {
  const item = document.createElement('div');
  item.className = 'sb-history-item';
  item.dataset.id = sess.id;
  item.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
    <span class="sb-history-item-title">${escapeHtml(sess.title)}</span>`;
  item.addEventListener('click', () => switchSession(sess.id));
  chatHistoryList.appendChild(item);
}

function switchSession(id) {
  if (activeId === id) return;

  // Save current messages DOM into old session's turns (already done per-message)
  activeId = id;

  // Highlight sidebar item
  chatHistoryList.querySelectorAll('.sb-history-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  // Re-render messages from stored turns
  const sess = getSession(id);
  messagesEl.innerHTML = '';

  if (sess.turns.length === 0) {
    // Fresh session — show welcome
    const w = welcomeEl.cloneNode(true);
    w.style.display = '';
    messagesEl.appendChild(w);
  } else {
    sess.turns.forEach(t => {
      const turn = document.createElement('div');
      turn.className = 'turn';
      turn.innerHTML = t.html;
      messagesEl.appendChild(turn);
    });
    scrollBottom();
  }

  // Restore stats
  updateStat('statToolCalls', sess.toolCount || 0);
  updateStat('statMessages',  sess.msgCount  || 0);
  updateStat('statStatus',    'Idle');
  updateStat('statModel', '—');

  // Restore model selection
  const radio = document.querySelector(`input[name="modelSelect"][value="${CSS.escape(sess.model)}"]`);
  if (radio) {
    radio.checked = true;
    modelListEl.querySelectorAll('.sb-model-item').forEach(l => l.classList.remove('active'));
    radio.closest('.sb-model-item').classList.add('active');
    // Switch to right provider tab
    const group = radio.closest('.sb-model-group');
    if (group) {
      const prov = group.dataset.provider;
      providerTabs.querySelectorAll('.sb-tab').forEach(t => t.classList.toggle('active', t.dataset.provider === prov));
      modelListEl.querySelectorAll('.sb-model-group').forEach(g => {
        g.style.display = g.dataset.provider === prov ? 'flex' : 'none';
      });
    }
  }
  setModelLabel(sess.model);
}

function deleteActiveSession() {
  if (!activeId) return;
  const idx = sessions.findIndex(s => s.id === activeId);
  if (idx === -1) return;

  // Remove sidebar item
  chatHistoryList.querySelector(`.sb-history-item[data-id="${activeId}"]`)?.remove();
  sessions.splice(idx, 1);
  activeId = null;

  // Switch to next session or create fresh
  if (sessions.length > 0) {
    switchSession(sessions[Math.min(idx, sessions.length - 1)].id);
  } else {
    // Reset chat area
    messagesEl.innerHTML = '';
    const w = welcomeEl.cloneNode(true);
    w.style.display = '';
    messagesEl.appendChild(w);
    clearActivity();
    resetStats();
  }
}

function getSession(id) { return sessions.find(s => s.id === id); }
function getActiveSession() { return getSession(activeId); }

// ── Turn management ───────────────────────────────────────────────────────────
function startTurn() {
  removeThinking();

  currentTurn = document.createElement('div');
  currentTurn.className = 'turn';

  const label = document.createElement('div');
  label.className = 'ai-label';
  label.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
    </svg>
    ${escapeHtml(shortModelName(getSelectedModel()))}`;
  currentTurn.appendChild(label);

  currentThinking = document.createElement('div');
  currentThinking.className = 'thinking-indicator';
  currentThinking.innerHTML = `<span>Thinking</span>
    <div class="thinking-dots"><span></span><span></span><span></span></div>`;
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
    if (finalOutput && finalOutput.trim() !== streamBuffer.trim()) {
      currentAiMsgEl.textContent = finalOutput;
    }
  } else if (finalOutput && currentTurn) {
    const bubble = document.createElement('div');
    bubble.className = 'ai-msg';
    bubble.textContent = finalOutput;
    currentTurn.appendChild(bubble);
  }

  // Persist turn HTML in session
  const sess = getActiveSession();
  if (sess && currentTurn) {
    sess.turns[sess.turns.length - 1].html += currentTurn.querySelector('.ai-label')?.outerHTML || '';
    sess.turns[sess.turns.length - 1].html += currentAiMsgEl?.outerHTML
      || (finalOutput ? `<div class="ai-msg">${escapeHtml(finalOutput)}</div>` : '');
    sess.msgCount = (sess.msgCount || 0) + 1;
    updateStat('statMessages', sess.msgCount);
    updateStat('statStatus', 'Idle');
  }

  currentTurn    = null;
  currentAiMsgEl = null;
  streamBuffer   = '';
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
  const labelHtml = `<div class="user-label">You</div>`;
  const msgHtml   = `<div class="user-msg">${escapeHtml(text)}</div>`;
  turn.innerHTML  = labelHtml + msgHtml;
  messagesEl.appendChild(turn);
  scrollBottom();

  // Store turn skeleton (ai part filled in finishTurn)
  const sess = getActiveSession();
  if (sess) {
    // Update title to first message if still default
    if (sess.title === 'New Chat') {
      sess.title = text.slice(0, 36) + (text.length > 36 ? '…' : '');
      const el = chatHistoryList.querySelector(`.sb-history-item[data-id="${sess.id}"] .sb-history-item-title`);
      if (el) el.textContent = sess.title;
    }
    sess.turns.push({ html: labelHtml + msgHtml });
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
  currentTurn = null;
  currentAiMsgEl = null;
  scrollBottom();
}

// ── Activity panel ────────────────────────────────────────────────────────────
function addActivityCard(type, { title, input, output, badge, expandedByDefault }) {
  if (activityPlaceholder) activityPlaceholder.style.display = 'none';

  const card = document.createElement('div');
  card.className = `activity-card card-${type}`;

  const badgeHtml = badge ? `<span class="status-badge badge-${badge}">${badge}</span>` : '';
  let bodyContent = '';
  if (input  !== undefined) bodyContent += `<div class="card-section-label">Input</div><div class="card-code">${escapeHtml(toStr(input))}</div>`;
  if (output !== undefined) bodyContent += `<div class="card-section-label">Output</div><div class="card-code">${escapeHtml(toStr(output))}</div>`;

  const chevron = bodyContent
    ? `<svg class="card-chevron ${expandedByDefault ? 'open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>`
    : '';

  const iconSvg = type === 'tool'
    ? `<svg class="card-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`
    : '';

  card.innerHTML = `
    <div class="card-header">${iconSvg}<span>${escapeHtml(title)}</span>${badgeHtml}${chevron}</div>
    ${bodyContent ? `<div class="card-body ${expandedByDefault ? 'open' : ''}">${bodyContent}</div>` : ''}`;

  const header = card.querySelector('.card-header');
  const body   = card.querySelector('.card-body');
  const chev   = card.querySelector('.card-chevron');
  if (header && body) {
    header.addEventListener('click', () => {
      const open = body.classList.toggle('open');
      chev?.classList.toggle('open', open);
    });
  }

  activityFeed.appendChild(card);
  activityFeed.scrollTop = activityFeed.scrollHeight;
}

function finalizeToolCard(toolName) {
  const cards = activityFeed.querySelectorAll('.activity-card.card-tool');
  for (let i = cards.length - 1; i >= 0; i--) {
    const badge = cards[i].querySelector('.status-badge.badge-running');
    if (badge) { badge.textContent = 'done'; badge.className = 'status-badge badge-done'; break; }
  }
}

function clearActivity() {
  activityFeed.innerHTML = '';
  if (activityPlaceholder) {
    activityFeed.appendChild(activityPlaceholder);
    activityPlaceholder.style.display = 'flex';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(cls, text) {
  statusDot.className = `status-dot ${cls}`;
  statusText.textContent = text;
}

function setInputEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendBtn.disabled      = !enabled;
  if (enabled) messageInput.focus();
}

function hideWelcome() {
  const w = messagesEl.querySelector('.welcome');
  if (w) w.style.display = 'none';
}

function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function updateStat(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function resetStats() {
  updateStat('statModel',     '—');
  updateStat('statStatus',    'Idle');
  updateStat('statToolCalls', 0);
  updateStat('statMessages',  0);
}

function shortModelName(modelId) {
  if (!modelId) return '—';
  const map = {
    'claude-opus-4-6':               '🟣 Opus 4.6',
    'claude-sonnet-4-6':             '🟣 Sonnet 4.6',
    'claude-haiku-4-5-20251001':     '🟣 Haiku 4.5',
    'claude-3-5-sonnet-20241022':    '🟣 3.5 Sonnet',
    'claude-3-5-haiku-20241022':     '🟣 3.5 Haiku',
    'claude-3-opus-20240229':        '🟣 3 Opus',
    'gpt-4o':                        '🟢 GPT-4o',
    'gpt-4o-mini':                   '🟢 GPT-4o Mini',
    'gpt-4-turbo':                   '🟢 GPT-4 Turbo',
    'o3-mini':                       '🟢 o3 Mini',
    'o1-mini':                       '🟢 o1 Mini',
    'gemini-2.0-flash':              '🔵 Gemini 2.0 Flash',
    'gemini-2.0-flash-lite':         '🔵 Flash Lite',
    'gemini-2.5-pro-preview-03-25':  '🔵 Gemini 2.5 Pro',
    'gemini-1.5-pro':                '🔵 Gemini 1.5 Pro',
    'gemini-1.5-flash':              '🔵 Gemini 1.5 Flash',
  };
  return map[modelId] || modelId;
}

function toStr(val) {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(toStr).join('\n');
  if (val !== null && typeof val === 'object') {
    // Content-block list: [{type:"text", text:"..."}]
    if ('text' in val) return val.text;
    return JSON.stringify(val, null, 2);
  }
  return String(val ?? '');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function resizeTextarea() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
}

// ── Event listeners ───────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);

messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

messageInput.addEventListener('input', resizeTextarea);

function startNewChat() {
  if (isProcessing) return;
  createSession(true);
  clearActivity();
  resetStats();
  messageInput.focus();
}

newChatBtn.addEventListener('click', startNewChat);
document.getElementById('newChatBtn2').addEventListener('click', startNewChat);

deleteChatBtn.addEventListener('click', () => {
  if (isProcessing) return;
  deleteActiveSession();
  clearActivity();
  resetStats();
});

clearActivityBtn.addEventListener('click', clearActivity);


// ── Init ──────────────────────────────────────────────────────────────────────
setStatus('connecting', 'Connecting…');
setModelLabel(getSelectedModel());
createSession(true);   // start with one empty session
connect();
