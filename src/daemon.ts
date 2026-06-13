// 常驻守护进程。M2：hook → 锁屏门控推送固定选项 → 轮询识别表情/数字 → tmux 注入。
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import { expandHome } from './config.js';
import type { Logger } from './logger.js';
import { DwsClient } from './dingtalk/dwsClient.js';
import { TmuxClient } from './tmux/tmuxClient.js';
import { HookServer } from './hooks/hookServer.js';
import type { IncomingHook } from './hooks/hookTypes.js';
import { Poller } from './dingtalk/poller.js';
import { SessionManager } from './session/sessionManager.js';
import { ActivityTracker } from './status/activityTracker.js';
import { readTranscriptUsage } from './options/transcript.js';
import { activateApp, focusWindowViaDock } from './mac/notify.js';

/** pane 探活周期（ms）：与 HUD 面板 2s 刷新同量级，关窗口后约这么久从列表消失。 */
const REAP_MS = 2000;
/** token/时长 增量解析周期（ms）。 */
const USAGE_MS = 4000;

/**
 * 识别 Claude Code 输入框页脚里的「后台 shell 在跑」(如 "… · 1 shell · ↓ to manage")。
 * 只看**底部若干行**(页脚区)且要求同一行同时有「N shell」与管理提示「manage」——
 * 避免命中对话/scrollback 里偶然出现的 "1 shell still running"(那只是文字,无 manage)。
 */
function hasBackgroundShell(paneText: string): boolean {
  const lines = paneText.split('\n');
  return lines.slice(-8).some((l) => /[1-9]\d* shells?\b/.test(l) && /manage/.test(l));
}

export class Daemon {
  private readonly dws: DwsClient;
  private readonly tmux: TmuxClient;
  private readonly hookServer: HookServer;
  private readonly sessions: SessionManager;
  private readonly poller: Poller;
  /** 展示态（桌面控件数据源），与控制状态机解耦。持久化到 stateFile 同目录的 activity.json。 */
  private readonly activity: ActivityTracker;
  /** pane 探活定时器：周期性剔除 pane 已消失的会话。 */
  private reapTimer?: ReturnType<typeof setInterval>;
  /** token/时长 解析定时器。 */
  private usageTimer?: ReturnType<typeof setInterval>;
  /** 每会话 transcript 增量解析状态：已读偏移 + 累计输入/输出 token。 */
  private readonly usageState = new Map<string, { offset: number; tokensIn: number; tokensOut: number }>();

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    this.dws = new DwsClient(cfg.dingtalk.dwsBin, log, cfg.dingtalk.agentCode);
    this.tmux = new TmuxClient(log);
    this.activity = new ActivityTracker(join(dirname(expandHome(cfg.paths.stateFile)), 'activity.json'), log);
    this.sessions = new SessionManager(cfg, log, this.dws, this.tmux);
    this.poller = new Poller(
      this.dws,
      cfg,
      log,
      () => this.sessions.getContext(),
      (events) => this.sessions.onInboundEvents(events),
    );
    this.sessions.attachTracker(this.poller.inbound);
    this.hookServer = new HookServer(cfg.hookServer, log, (h) => this.onHook(h));
  }

  /** 桌面控件用的状态快照。 */
  private buildStatus(): unknown {
    return { onlyWhenLocked: this.cfg.notify.onlyWhenLocked, sessions: this.activity.snapshot() };
  }

  /**
   * 点击桌面控件 → 切回该会话:在其所属 tmux session 里选中目标 pane,再把承载该 session 的
   * 那个终端窗口拉到最前。多窗口终端(ghostty 单进程多窗口)靠"按 session 名设标题 + AXRaise"精确聚焦;
   * 无 Accessibility 权限时退化为 activateApp(至少把 app 调前)。终端 app 由 notify.terminalBundleId 指定。
   */
  private async switchToSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const pane = this.activity.get(sessionId)?.pane;
    if (!pane) return { ok: false, error: 'no pane' };
    if (!(await this.tmux.hasPane(pane))) return { ok: false, error: 'pane gone' };
    const sid = sessionId.slice(0, 8);
    const bundleId = this.cfg.notify.terminalBundleId;
    try {
      await this.tmux.selectPane(pane); // 在目标 session 里选中该 pane
    } catch (err) {
      this.log.warn('切回会话失败(select-pane)', { session: sid, pane, err: String(err) });
      return { ok: false, error: String(err) };
    }
    // 通过 Dock 窗口菜单聚焦承载该 session 的终端窗口（可跨全屏 Space,纯公开 AX）。
    let focused = '';
    try {
      const tmuxSession = await this.tmux.sessionOfPane(pane);
      const ttys = tmuxSession ? await this.tmux.clientTtysOfSession(tmuxSession) : [];
      if (tmuxSession && ttys.length) {
        await this.tmux.setSessionTitle(tmuxSession); // 窗口标题 = session 名 → Dock 菜单项即按此名
        for (const tty of ttys) await this.tmux.refreshClient(tty);
        focused = await focusWindowViaDock(bundleId, tmuxSession);
        this.log.debug('Dock 聚焦', { session: sid, tmuxSession, result: focused });
      }
    } catch (err) {
      this.log.warn('Dock 聚焦失败(可能缺 Accessibility 权限)', { session: sid, err: String(err) });
    }
    if (focused !== 'ok') {
      // 退化:Dock 路径没成,至少把 app 调前(同 Space 下也算切过去了)。
      try {
        await activateApp(bundleId);
      } catch {
        /* 调前台失败不致命 */
      }
    }
    this.log.info('点击切回会话', { session: sid, pane, focused });
    return { ok: true };
  }

  /** 周期性同步 tmux pane 信息：剔除已关闭窗口的会话 + 刷新 session 名/启动目录 + 后台任务探测。 */
  private async syncPaneInfo(): Promise<void> {
    try {
      const info = await this.tmux.listPaneInfo(); // tmux 异常会抛出 → 不误删；只有 server 在跑且确无该 pane 才剔除
      this.activity.syncPanes(info);
    } catch {
      return; // tmux 不可用（如 server 没起）：跳过本轮
    }
    // 后台任务探测：对"等待"态会话抓 pane，识别状态行里的「N shell still running」→ waiting_background。
    for (const s of this.activity.snapshot()) {
      if (!s.pane || (s.status !== 'waiting_input' && s.status !== 'waiting_background')) continue;
      try {
        const text = await this.tmux.capturePane(s.pane);
        this.activity.setBackground(s.sessionId, hasBackgroundShell(text));
      } catch {
        /* 抓不到就维持原状态 */
      }
    }
  }

  /** 增量解析各会话 transcript，更新累计 token 与起始时刻。同步 fs，调用很轻（只读新增字节）。 */
  private refreshUsage(): void {
    const sessions = this.activity.snapshot();
    const alive = new Set(sessions.map((s) => s.sessionId));
    for (const id of this.usageState.keys()) if (!alive.has(id)) this.usageState.delete(id); // 清理已移除会话
    for (const s of sessions) {
      if (!s.transcriptPath) continue;
      const st = this.usageState.get(s.sessionId) ?? { offset: 0, tokensIn: 0, tokensOut: 0 };
      const r = readTranscriptUsage(s.transcriptPath, st.offset);
      if (r.reset) {
        st.tokensIn = 0; // 文件被重写 → 归零重算
        st.tokensOut = 0;
      }
      st.tokensIn += r.tokensInDelta;
      st.tokensOut += r.tokensOutDelta;
      st.offset = r.offset;
      this.usageState.set(s.sessionId, st);
      this.activity.setUsage(s.sessionId, st.tokensIn, st.tokensOut, r.firstTs);
      this.activity.setTopic(s.sessionId, { aiTitle: r.aiTitle, lastPrompt: r.lastPrompt, firstPrompt: r.firstPrompt });
    }
  }

  async start(): Promise<void> {
    this.hookServer.setStatusProvider(() => this.buildStatus());
    this.hookServer.setSwitchHandler((sid) => this.switchToSession(sid));
    // 展示态变化即向 SSE 客户端推送一帧。
    this.activity.subscribe(() => this.hookServer.broadcast(this.buildStatus()));
    this.activity.load(); // 恢复重启前的会话列表（死会话由 reaper / STALE_MS 清掉）
    this.sessions.restoreState(); // 恢复重启前未决的等待
    await this.hookServer.start();
    this.poller.start();
    this.reapTimer = setInterval(() => void this.syncPaneInfo(), REAP_MS);
    this.usageTimer = setInterval(() => this.refreshUsage(), USAGE_MS);
    this.log.info('daemon 已启动', { group: this.cfg.dingtalk.openConversationId });
    const shutdown = () => {
      this.log.info('收到退出信号，关闭中…');
      if (this.reapTimer) clearInterval(this.reapTimer);
      if (this.usageTimer) clearInterval(this.usageTimer);
      this.activity.saveNow(); // 落盘最新列表
      this.poller.stop();
      void this.hookServer.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  private onHook(h: IncomingHook): void {
    // 旁路更新展示态（桌面控件数据源）。纯观察，不影响下面的遥控控制流。
    this.activity.observe(h);

    // 用户提交了输入 → 刷新该会话 pane/cwd（展示态已由上面的 activity.observe 处理）。
    if (h.event === 'UserPromptSubmit') {
      this.sessions.onUserActivity(h);
      return;
    }
    // 工具授权弹窗：推送允许/拒绝，注入对应按键。
    if (h.event === 'Notification' && h.notificationType === 'permission_prompt') {
      void this.sessions.onPermissionPrompt(h);
      return;
    }
    // Claude 真正结束一轮、等人介入时触发：Stop（立即）/ idle_prompt（锁屏 60s 兜底）。
    const isIdle =
      h.event === 'Stop' ||
      (h.event === 'Notification' && (h.notificationType === 'idle_prompt' || h.notificationType == null));
    if (!isIdle) return;
    void this.sessions.onIdleHook(h);
  }
}
