// 常驻守护进程。M2：hook → 锁屏门控推送固定选项 → 轮询识别表情/数字 → tmux 注入。
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { DwsClient } from './dingtalk/dwsClient.js';
import { TmuxClient } from './tmux/tmuxClient.js';
import { HookServer } from './hooks/hookServer.js';
import type { IncomingHook } from './hooks/hookTypes.js';
import { Poller } from './dingtalk/poller.js';
import { SessionManager } from './session/sessionManager.js';
import { ActivityTracker } from './status/activityTracker.js';
import { activateApp, focusWindowViaDock } from './mac/notify.js';

export class Daemon {
  private readonly dws: DwsClient;
  private readonly tmux: TmuxClient;
  private readonly hookServer: HookServer;
  private readonly sessions: SessionManager;
  private readonly poller: Poller;
  /** 展示态（桌面控件数据源），与控制状态机解耦。 */
  private readonly activity = new ActivityTracker();

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    this.dws = new DwsClient(cfg.dingtalk.dwsBin, log, cfg.dingtalk.agentCode);
    this.tmux = new TmuxClient(log);
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
   * 无 Accessibility 权限时 AXRaise 抛错,退化为 activateApp(至少把 app 调前)。terminalBundleId 复用空闲提醒配置。
   */
  private async switchToSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const pane = this.activity.get(sessionId)?.pane;
    if (!pane) return { ok: false, error: 'no pane' };
    if (!(await this.tmux.hasPane(pane))) return { ok: false, error: 'pane gone' };
    const sid = sessionId.slice(0, 8);
    const bundleId = this.cfg.notify.idleSwitch.terminalBundleId;
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

  async start(): Promise<void> {
    this.hookServer.setStatusProvider(() => this.buildStatus());
    this.hookServer.setSwitchHandler((sid) => this.switchToSession(sid));
    // 展示态变化即向 SSE 客户端推送一帧。
    this.activity.subscribe(() => this.hookServer.broadcast(this.buildStatus()));
    this.sessions.restoreState(); // 恢复重启前未决的等待
    await this.hookServer.start();
    this.poller.start();
    this.log.info('daemon 已启动', { group: this.cfg.dingtalk.openConversationId });
    const shutdown = () => {
      this.log.info('收到退出信号，关闭中…');
      this.poller.stop();
      void this.hookServer.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  private onHook(h: IncomingHook): void {
    // 旁路更新展示态（桌面控件数据源）。纯观察，不影响下面的遥控控制流。
    this.activity.observe(h);

    // 用户提交了输入 → 该会话正在工作，取消空闲提醒（下一次自然停会重新计时）。
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
