// Shared by the dashboard and the phone page.
const CONFIG = window.SENTINEL_CONFIG || {};
const WS_URL = CONFIG.wsUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const pct = (x) => `${Math.round((x || 0) * 100)}%`;

/** Tiny DOM builder: h('div', {class: 'x', onclick: f}, 'text', childNode). Text is never parsed as HTML. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid);
  return el;
}

function store(key, value) {
  try { if (value === undefined) return sessionStorage.getItem(key) ?? localStorage.getItem(key); localStorage.setItem(key, value); } catch { /* private mode */ }
  return value ?? null;
}

/** WebSocket that reconnects and replays the hello message. */
function connect({ hello, onMessage, onStatus }) {
  let ws, delay = 500, closed = false, pingTimer;
  const api = {
    send(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; },
    buffered() { return ws ? ws.bufferedAmount : 0; },
    close() { closed = true; ws && ws.close(); },
  };
  (function open() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { delay = 500; onStatus(true); api.send(hello()); pingTimer = setInterval(() => api.send({ action: 'ping' }), 60000); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = () => { clearInterval(pingTimer); onStatus(false); if (!closed) setTimeout(open, delay = Math.min(delay * 2, 8000)); };
    ws.onerror = () => ws.close();
  })();
  return api;
}
