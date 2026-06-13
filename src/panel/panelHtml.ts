// 置顶浮层(左缘抽屉里的 WKWebView)用的自包含 HTML 页面。
// 数据走 daemon 的 /events SSE(展示态变化即推),断线退回轮询 /status。
// 渲染逻辑与 ubersicht/claude-sessions.jsx 对齐(状态点 / 会话名 / 主题三行 / 时长+token),
// 点击卡片 → POST /switch 切回该会话的 tmux pane。
// daemon 在 GET /panel 直接吐这段字符串,无需打包、无文件路径解析。
export const PANEL_HTML = String.raw`<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claude Sessions</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
    color: #e6edf3;
    background: #0d1117;
    -webkit-font-smoothing: antialiased;
    overflow-y: auto;
    overflow-x: hidden;
  }
  body::-webkit-scrollbar { width: 8px; }
  body::-webkit-scrollbar-thumb { background: rgba(240,246,252,0.12); border-radius: 4px; }
  .wrap { padding: 14px 16px; }
  .header {
    font-size: 14px; font-weight: 600; letter-spacing: 0.4px; color: #8b949e;
    text-transform: uppercase; margin-bottom: 10px;
  }
  .empty { font-size: 14px; color: #6e7681; padding-top: 4px; }
  .card {
    display: flex; align-items: flex-start; gap: 9px;
    padding: 10px 0; border-top: 1px solid rgba(240,246,252,0.06);
  }
  .switchBtn {
    flex: 0 0 auto; font-size: 12px; font-weight: 600; color: #fff;
    background: #2f81f7; border: none; border-radius: 6px; padding: 4px 11px;
    cursor: pointer; -webkit-app-region: no-drag;
  }
  .switchBtn:hover { background: #4493f8; }
  .switchBtn:active { background: #1f6feb; }
  .dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 4px; flex: 0 0 auto; }
  .body { min-width: 0; flex: 1; }
  .titleRow { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .name { font-size: 15.5px; font-weight: 600; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .age { font-size: 13px; color: #6e7681; flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .sub { font-size: 13.5px; color: #8b949e; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .detail { font-size: 13px; color: #7d8590; margin-top: 2px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .topic { font-size: 13.5px; color: #bc8cff; margin-top: 4px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .prompt { font-size: 13px; color: #8b949e; margin-top: 3px; line-height: 1.35;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .plabel { color: #6e7681; font-weight: 600; }
  .meta { font-size: 12.5px; color: #6e7681; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .offline { font-size: 14px; color: #8b949e; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header" id="hdr">Claude Sessions</div>
  <div id="list"></div>
</div>
<script>
const STATUS = {
  running: { dot: '#3fb950', label: '运行中' },
  thinking: { dot: '#58a6ff', label: '思考中' },
  waiting_input: { dot: '#d29922', label: '等待输入' },
  waiting_background: { dot: '#39c5cf', label: '等后台结果' },
  waiting_permission: { dot: '#f85149', label: '等待授权' },
};
const baseName = (cwd) => {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
};
const dirLabel = (s, collisions) => {
  if (!s.cwd) return '';
  const b = baseName(s.cwd);
  if (collisions.has(b)) {
    const parts = s.cwd.split('/').filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join('/');
  }
  return b;
};
const fmtAge = (since) => {
  if (!since) return '';
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
};
const fmtDur = (since) => {
  if (!since) return '';
  const m = Math.max(0, Math.floor((Date.now() - since) / 60000));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
};
const fmtTok = (n) => {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const switchTo = (sessionId) =>
  fetch('/switch?session=' + encodeURIComponent(sessionId)).catch(() => {});

function render(data) {
  const list = document.getElementById('list');
  const hdr = document.getElementById('hdr');
  const sessions = (data && data.sessions) || [];
  hdr.textContent = 'Claude Sessions · ' + sessions.length + (data && data.onlyWhenLocked ? '' : ' · 全程推送');
  const counts = {};
  sessions.forEach((s) => { const b = baseName(s.cwd); if (b) counts[b] = (counts[b] || 0) + 1; });
  const collisions = new Set(Object.keys(counts).filter((b) => counts[b] > 1));
  list.textContent = '';
  if (sessions.length === 0) {
    list.appendChild(el('div', 'empty', '暂无活跃会话'));
    return;
  }
  for (const s of sessions) {
    const meta = STATUS[s.status] || { dot: '#6e7681', label: s.status };
    const dir = dirLabel(s, collisions);
    const title = s.tmuxSession || dir || (s.sessionId ? s.sessionId.slice(0, 8) : '—');
    const showDir = dir && s.tmuxSession;
    const card = el('div', 'card');
    const dot = el('div', 'dot');
    dot.style.background = meta.dot;
    dot.style.boxShadow = '0 0 6px ' + meta.dot;
    card.appendChild(dot);
    const body = el('div', 'body');
    const tr = el('div', 'titleRow');
    tr.appendChild(el('div', 'name', title));
    tr.appendChild(el('div', 'age', fmtAge(s.statusSince)));
    if (s.pane) {
      const btn = el('button', 'switchBtn', '切回 →');
      btn.title = '切回该会话的终端';
      btn.onclick = (e) => { e.stopPropagation(); switchTo(s.sessionId); };
      tr.appendChild(btn);
    }
    body.appendChild(tr);
    if (showDir) body.appendChild(el('div', 'sub', dir));
    body.appendChild(el('div', 'sub', meta.label + (s.pane ? ' · ' + s.pane : '')));
    if (s.toolDetail) body.appendChild(el('div', 'detail', s.toolDetail));
    if (s.aiTitle) body.appendChild(el('div', 'topic', '◆ ' + s.aiTitle));
    if (s.firstPrompt) {
      const p = el('div', 'prompt');
      p.appendChild(el('span', 'plabel', '初始 '));
      p.appendChild(document.createTextNode(s.firstPrompt));
      body.appendChild(p);
    }
    if (s.lastPrompt && s.lastPrompt !== s.firstPrompt) {
      const p = el('div', 'prompt');
      p.appendChild(el('span', 'plabel', '当前 '));
      p.appendChild(document.createTextNode(s.lastPrompt));
      body.appendChild(p);
    }
    body.appendChild(el('div', 'meta',
      '共 ' + fmtDur(s.firstTs || s.startedAt) + ' · ↑' + fmtTok(s.tokensIn) + ' ↓' + fmtTok(s.tokensOut)));
    card.appendChild(body);
    list.appendChild(card);
  }
}

// 每秒重算一次相对时间(age/时长)即使无新数据。
let last = null;
setInterval(() => { if (last) render(last); }, 1000);

// 优先 SSE,断线退回轮询。
function connect() {
  try {
    const es = new EventSource('/events');
    es.onmessage = (e) => { try { last = JSON.parse(e.data); render(last); } catch {} };
    es.onerror = () => { es.close(); setTimeout(poll, 1500); };
  } catch { poll(); }
}
function poll() {
  fetch('/status').then((r) => r.json()).then((d) => { last = d; render(d); }).catch(() => {
    document.getElementById('hdr').textContent = 'Claude Sessions';
    if (!last) document.getElementById('list').innerHTML = '<div class="offline">daemon 未运行(端口 8787)</div>';
  }).finally(() => setTimeout(connect, 2000));
}
connect();
</script>
</body>
</html>`;
