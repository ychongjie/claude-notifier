// Claude Code 会话实时面板 —— Übersicht 挂件
//
// 数据源：claude-notifier daemon 的 GET /status（ActivityTracker 快照）。
//
// 安装：
//   1. brew install --cask ubersicht   （若未装）
//   2. 把本文件软链到 Übersicht 的 widgets 目录：
//        ln -s "$(pwd)/ubersicht/claude-sessions.jsx" \
//          ~/"Library/Application Support/Übersicht/widgets/claude-sessions.jsx"
//   3. 打开 Übersicht；右键挂件 → 选择竖屏显示器（Display）把它指派过去。
//
// 调位置：改下面 className 里的 top/right/width/maxHeight。

export const refreshFrequency = 2000; // 2s 拉一次

// 点击卡片 → 让 daemon 切到该会话的 tmux pane 并激活终端。
// 直接 fetch（daemon 已开 CORS；无自定义头的 GET 是 simple request，不触发预检）。
const switchTo = (sessionId) =>
  fetch(`http://127.0.0.1:8787/switch?session=${encodeURIComponent(sessionId)}`).catch(() => {});

// --noproxy '*'：用户机器常设 http_proxy，localhost 也会被代理拦。--max-time 1：daemon 没起别卡住。
export const command = "curl -s --noproxy '*' --max-time 1 http://127.0.0.1:8787/status";

export const className = `
  top: 24px;
  right: 24px;
  width: 320px;
  max-height: 90vh;
  overflow: hidden;
  font-family: -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
  color: #e6edf3;
  -webkit-font-smoothing: antialiased;
`;

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
// 末级目录名；重名时补一层父级(test/safeline-3 vs gitlab/safeline-3)区分。
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
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

const fmtDur = (since) => {
  if (!since) return '';
  const m = Math.max(0, Math.floor((Date.now() - since) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
};

const fmtTok = (n) => {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
};

const wrap = { background: 'rgba(13,17,23,0.82)', borderRadius: 12, padding: '12px 14px', border: '1px solid rgba(240,246,252,0.08)' };
const header = { fontSize: 12, fontWeight: 600, letterSpacing: 0.4, color: '#8b949e', textTransform: 'uppercase', marginBottom: 10 };
const card = { display: 'flex', alignItems: 'flex-start', gap: 9, padding: '8px 0', borderTop: '1px solid rgba(240,246,252,0.06)' };
const dotStyle = (c) => ({ width: 9, height: 9, borderRadius: '50%', background: c, marginTop: 4, flex: '0 0 auto', boxShadow: `0 0 6px ${c}` });
const titleRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 };
const name = { fontSize: 13.5, fontWeight: 600, color: '#e6edf3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const age = { fontSize: 11, color: '#6e7681', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' };
const sub = { fontSize: 11.5, color: '#8b949e', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const detail = { fontSize: 11, color: '#7d8590', marginTop: 2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const meta_ = { fontSize: 10.5, color: '#6e7681', marginTop: 3, fontVariantNumeric: 'tabular-nums' };

export const render = ({ output }) => {
  let data;
  try {
    data = JSON.parse(output);
  } catch (e) {
    return (
      <div style={wrap}>
        <div style={header}>Claude Sessions</div>
        <div style={{ fontSize: 12, color: '#8b949e' }}>daemon 未运行（端口 8787）</div>
      </div>
    );
  }
  const sessions = data.sessions || [];
  // 统计重名的末级目录,用于决定哪些要补父级。
  const counts = {};
  sessions.forEach((s) => {
    const b = baseName(s.cwd);
    if (b) counts[b] = (counts[b] || 0) + 1;
  });
  const collisions = new Set(Object.keys(counts).filter((b) => counts[b] > 1));
  return (
    <div style={wrap}>
      <div style={header}>
        Claude Sessions · {sessions.length}
        {data.onlyWhenLocked ? '' : ' · 全程推送'}
      </div>
      {sessions.length === 0 ? (
        <div style={{ fontSize: 12, color: '#6e7681', paddingTop: 4 }}>暂无活跃会话</div>
      ) : (
        sessions.map((s) => {
          const meta = STATUS[s.status] || { dot: '#6e7681', label: s.status };
          const dir = dirLabel(s, collisions);
          const title = s.tmuxSession || dir || (s.sessionId ? s.sessionId.slice(0, 8) : '—');
          // 标题已是 tmux session 名时,目录另起一行;否则目录已在标题里,不再重复。
          const showDir = dir && s.tmuxSession;
          return (
            <div
              key={s.sessionId}
              style={{ ...card, cursor: s.pane ? 'pointer' : 'default' }}
              title={s.pane ? '点击切回该会话' : '不在 tmux 里，无法切回'}
              onClick={() => s.pane && switchTo(s.sessionId)}
            >
              <div style={dotStyle(meta.dot)} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={titleRow}>
                  <div style={name}>{title}</div>
                  <div style={age}>{fmtAge(s.statusSince)}</div>
                </div>
                {showDir ? <div style={sub}>{dir}</div> : null}
                <div style={sub}>
                  {meta.label}
                  {s.pane ? ` · ${s.pane}` : ''}
                </div>
                {s.toolDetail ? <div style={detail}>{s.toolDetail}</div> : null}
                <div style={meta_}>
                  共 {fmtDur(s.firstTs || s.startedAt)} · ↑{fmtTok(s.tokensIn)} ↓{fmtTok(s.tokensOut)}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};
