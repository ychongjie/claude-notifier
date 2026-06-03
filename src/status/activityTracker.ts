// 展示态跟踪器：纯旁路观察 hook 事件流，维护每会话的实时运行状态。
// 与 SessionManager 的安全控制状态机（IDLE/WAITING_USER…）**完全解耦**——
// 只读 hook、只写自己的 map，绝不触发注入/推送/锁屏门控/轮询。
// 给桌面控件（Übersicht / 未来的置顶窗口）当数据源用。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';
import type { IncomingHook } from '../hooks/hookTypes.js';
import { describeToolUse } from '../options/transcript.js';

export type ActivityStatus =
  | 'thinking' // 已收到输入 / 工具刚跑完，Claude 正在生成
  | 'running' // 正在执行某个工具
  | 'waiting_input' // 自然停，等用户输入
  | 'waiting_background' // 自然停，但有后台 shell 还在跑（等后台结果，不是真的等你）
  | 'waiting_permission'; // 等工具授权

export interface SessionActivity {
  sessionId: string;
  status: ActivityStatus;
  /** running 时的工具名（Bash/Edit/…）。 */
  currentTool?: string;
  /** running 时的简述（命令 / 文件路径等，已截断）。 */
  toolDetail?: string;
  /** 启动目录：优先取 tmux pane 的 current_path（稳定，不随 Claude cd 漂移），无 pane 时退回 hook cwd。 */
  cwd?: string;
  pane?: string;
  /** 所属 tmux session 名（由 reaper 周期性从 pane 同步）。 */
  tmuxSession?: string;
  /** transcript 路径（来自 hook），用于增量统计 token / 起始时刻。 */
  transcriptPath?: string;
  /** 累计输入 token（含缓存：input+cacheCreate+cacheRead），daemon 增量解析 transcript 得到。 */
  tokensIn?: number;
  /** 累计输出 token（output）。 */
  tokensOut?: number;
  /** 会话真实起始时刻（transcript 首条带 timestamp 行的 ms），用于"总时长"。 */
  firstTs?: number;
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
/** 落盘防抖窗口（ms）：突发事件合并成一次写。 */
const SAVE_DEBOUNCE_MS = 800;
/** pane 连续缺席这么多次探活才剔除（防瞬时 tmux 读偏差误删存活会话）。 */
const MISS_LIMIT = 2;

export class ActivityTracker {
  private readonly map = new Map<string, SessionActivity>();
  private readonly listeners = new Set<Listener>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  /** pane 连续多少次探活缺席的计数（瞬时 tmux 读偏差不立即删，连续 MISS_LIMIT 次才删）。 */
  private readonly missStreak = new Map<string, number>();

  /** persistPath 给定时持久化到磁盘（daemon 重启后恢复）；不给则纯内存。 */
  constructor(
    private readonly persistPath?: string,
    private readonly log?: Logger,
  ) {}

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

  /** 状态变了：通知订阅者 + 安排落盘。 */
  private changed(): void {
    this.emit();
    this.scheduleSave();
  }

  private upsert(h: IncomingHook): SessionActivity {
    let a = this.map.get(h.sessionId);
    const t = Date.now();
    if (!a) {
      a = { sessionId: h.sessionId, status: 'thinking', startedAt: t, lastActivityAt: t, statusSince: t };
      this.map.set(h.sessionId, a);
    }
    if (h.pane) a.pane = h.pane;
    if (h.transcriptPath) a.transcriptPath = h.transcriptPath;
    // hook cwd 会随 Claude `cd` 漂移；只用它当「无 pane 会话」的兜底,且首次写入后不再覆盖。
    // 有 pane 的会话由 syncPanes 用 tmux pane_current_path（稳定的启动目录）权威覆盖。
    if (h.cwd && !a.cwd) a.cwd = h.cwd;
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

  /** 旁路观察一个 hook 事件，更新展示态。会触发订阅者（广播）+ 落盘。 */
  observe(h: IncomingHook): void {
    switch (h.event) {
      case 'SessionStart': {
        const a = this.upsert(h);
        this.setStatus(a, 'waiting_input'); // 会话刚起，等第一条输入
        break;
      }
      case 'SessionEnd': {
        // 会话结束 → 从列表移除（顺带解决"session 永不清理"的历史问题）。
        if (this.map.delete(h.sessionId)) this.changed();
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
    this.changed();
  }

  /**
   * 用当前 tmux pane 信息同步：(a) 剔除 pane 已消失的会话(关窗口/kill 即时清理);
   * (b) 给存活会话刷新 tmuxSession 名 + cwd(= pane_current_path,稳定的启动目录,自愈 hook cwd 漂移)。
   * paneInfo: pane_id → { session, path }。无 pane 的会话(非 tmux)不受影响,靠 STALE_MS 兜底。
   */
  syncPanes(paneInfo: Map<string, { session: string; path: string }>): void {
    let changed = false;
    for (const [id, a] of this.map) {
      if (!a.pane) continue;
      const info = paneInfo.get(a.pane);
      if (!info) {
        // 连续缺席 MISS_LIMIT 次才删——单次 tmux 读偏差不误删存活会话。
        const miss = (this.missStreak.get(id) ?? 0) + 1;
        if (miss >= MISS_LIMIT) {
          this.map.delete(id);
          this.missStreak.delete(id);
          changed = true;
          this.log?.debug('会话 pane 消失，移出列表', { session: id.slice(0, 8), pane: a.pane });
        } else {
          this.missStreak.set(id, miss);
        }
        continue;
      }
      this.missStreak.delete(id); // pane 在 → 清零缺席计数
      if (info.session && a.tmuxSession !== info.session) {
        a.tmuxSession = info.session;
        changed = true;
      }
      if (info.path && a.cwd !== info.path) {
        a.cwd = info.path; // pane 路径权威覆盖（修正 Claude cd 造成的 hook cwd 漂移）
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** 按 sessionId 取记录（供"点击切回会话"解析 pane）。 */
  get(sessionId: string): SessionActivity | undefined {
    return this.map.get(sessionId);
  }

  /**
   * 后台任务探测：**仅细化"等待"态**——有后台 shell 在跑时 waiting_input ↔ waiting_background。
   * 不动 running/thinking/waiting_permission（那些不是"停下等待"）。statusSince 不重置（同一次等待的再分类）。
   */
  setBackground(sessionId: string, hasBackground: boolean): void {
    const a = this.map.get(sessionId);
    if (!a) return;
    if (hasBackground && a.status === 'waiting_input') {
      a.status = 'waiting_background';
      this.changed();
    } else if (!hasBackground && a.status === 'waiting_background') {
      a.status = 'waiting_input';
      this.changed();
    }
  }

  /** 更新会话的累计 token（输入/输出）与起始时刻（由 daemon 周期性增量解析 transcript 后调用）。 */
  setUsage(sessionId: string, tokensIn: number, tokensOut: number, firstTs?: number): void {
    const a = this.map.get(sessionId);
    if (!a) return;
    let changed = false;
    if (a.tokensIn !== tokensIn) {
      a.tokensIn = tokensIn;
      changed = true;
    }
    if (a.tokensOut !== tokensOut) {
      a.tokensOut = tokensOut;
      changed = true;
    }
    if (firstTs && !a.firstTs) {
      a.firstTs = firstTs;
      changed = true;
    }
    if (changed) this.changed();
  }

  /** 快照：先剔除陈旧会话，再按最近活动倒序，最新的在最前。 */
  snapshot(): SessionActivity[] {
    const cutoff = Date.now() - STALE_MS;
    let pruned = false;
    for (const [id, a] of this.map) {
      if (a.lastActivityAt < cutoff) {
        this.map.delete(id);
        pruned = true;
      }
    }
    if (pruned) this.scheduleSave();
    return [...this.map.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  // ---- 持久化：daemon 重启后恢复列表（恢复的死会话由 reapMissingPanes / STALE_MS 清掉） ----

  /** 从磁盘恢复（在 daemon start 时调一次）。文件缺失/损坏则静默从空开始。 */
  load(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const arr = JSON.parse(raw) as SessionActivity[];
      if (!Array.isArray(arr)) return;
      const cutoff = Date.now() - STALE_MS;
      for (const a of arr) {
        if (a && typeof a.sessionId === 'string' && a.lastActivityAt > cutoff) {
          this.map.set(a.sessionId, a);
        }
      }
      this.log?.info('已恢复展示态会话列表', { count: this.map.size });
    } catch {
      /* 文件不存在或损坏：从空开始 */
    }
  }

  private scheduleSave(): void {
    if (!this.persistPath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 立即同步落盘（防抖到点 / daemon 退出时调）。 */
  saveNow(): void {
    if (!this.persistPath) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify([...this.map.values()]));
    } catch (err) {
      this.log?.warn('展示态落盘失败', { err: String(err) });
    }
  }
}
