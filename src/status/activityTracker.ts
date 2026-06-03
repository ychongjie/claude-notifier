// 展示态跟踪器：纯旁路观察 hook 事件流，维护每会话的实时运行状态。
// 与 SessionManager 的安全控制状态机（IDLE/WAITING_USER…）**完全解耦**——
// 只读 hook、只写自己的 map，绝不触发注入/推送/锁屏门控/轮询。
// 给桌面控件（Übersicht / 未来的置顶窗口）当数据源用。
import type { IncomingHook } from '../hooks/hookTypes.js';
import { describeToolUse } from '../options/transcript.js';

export type ActivityStatus =
  | 'thinking' // 已收到输入 / 工具刚跑完，Claude 正在生成
  | 'running' // 正在执行某个工具
  | 'waiting_input' // 自然停，等用户输入
  | 'waiting_permission'; // 等工具授权

export interface SessionActivity {
  sessionId: string;
  status: ActivityStatus;
  /** running 时的工具名（Bash/Edit/…）。 */
  currentTool?: string;
  /** running 时的简述（命令 / 文件路径等，已截断）。 */
  toolDetail?: string;
  cwd?: string;
  pane?: string;
  /** 首次见到该会话的时刻（ms）。 */
  startedAt: number;
  /** 最近一次事件时刻（ms），用于排序与陈旧清理。 */
  lastActivityAt: number;
  /** 进入当前 status 的时刻（ms），用于展示"运行/等待了多久"。 */
  statusSince: number;
}

type Listener = () => void;

/** 超过这个时长无任何事件的会话视为已死，从列表剔除——兜底未发 SessionEnd 的情况（如直接关终端/kill）。 */
const STALE_MS = 12 * 60 * 60 * 1000;

export class ActivityTracker {
  private readonly map = new Map<string, SessionActivity>();
  private readonly listeners = new Set<Listener>();

  /** 订阅状态变化（供 SSE 广播）。返回取消订阅函数。 */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 监听器异常不影响跟踪 */
      }
    }
  }

  private upsert(h: IncomingHook): SessionActivity {
    let a = this.map.get(h.sessionId);
    const t = Date.now();
    if (!a) {
      a = { sessionId: h.sessionId, status: 'thinking', startedAt: t, lastActivityAt: t, statusSince: t };
      this.map.set(h.sessionId, a);
    }
    if (h.pane) a.pane = h.pane;
    if (h.cwd) a.cwd = h.cwd;
    a.lastActivityAt = t;
    return a;
  }

  private setStatus(a: SessionActivity, status: ActivityStatus): void {
    if (a.status !== status) {
      a.status = status;
      a.statusSince = Date.now();
    }
    if (status !== 'running') {
      a.currentTool = undefined;
      a.toolDetail = undefined;
    }
  }

  /** 旁路观察一个 hook 事件，更新展示态。会触发订阅者（广播）。 */
  observe(h: IncomingHook): void {
    switch (h.event) {
      case 'SessionStart': {
        const a = this.upsert(h);
        this.setStatus(a, 'waiting_input'); // 会话刚起，等第一条输入
        break;
      }
      case 'SessionEnd': {
        // 会话结束 → 从列表移除（顺带解决"session 永不清理"的历史问题）。
        if (this.map.delete(h.sessionId)) this.emit();
        return;
      }
      case 'UserPromptSubmit': {
        const a = this.upsert(h);
        this.setStatus(a, 'thinking');
        break;
      }
      case 'PreToolUse': {
        const a = this.upsert(h);
        this.setStatus(a, 'running');
        if (h.toolName) {
          a.currentTool = h.toolName;
          a.toolDetail = describeToolUse({ name: h.toolName, input: h.toolInput ?? {} });
        }
        break;
      }
      case 'PostToolUse': {
        const a = this.upsert(h);
        this.setStatus(a, 'thinking'); // 工具跑完，回到生成中（下个 PreToolUse 或 Stop 再翻）
        break;
      }
      case 'Stop': {
        const a = this.upsert(h);
        this.setStatus(a, 'waiting_input');
        break;
      }
      case 'Notification': {
        const a = this.upsert(h);
        this.setStatus(a, h.notificationType === 'permission_prompt' ? 'waiting_permission' : 'waiting_input');
        break;
      }
      default:
        return; // 未知事件不影响展示态
    }
    this.emit();
  }

  /** 按 sessionId 取记录（供"点击切回会话"解析 pane）。 */
  get(sessionId: string): SessionActivity | undefined {
    return this.map.get(sessionId);
  }

  /** 快照：先剔除陈旧会话，再按最近活动倒序，最新的在最前。 */
  snapshot(): SessionActivity[] {
    const cutoff = Date.now() - STALE_MS;
    for (const [id, a] of this.map) {
      if (a.lastActivityAt < cutoff) this.map.delete(id);
    }
    return [...this.map.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }
}
