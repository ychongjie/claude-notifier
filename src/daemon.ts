// 常驻守护进程。M2：hook → 锁屏门控推送固定选项 → 轮询识别表情/数字 → tmux 注入。
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { DwsClient } from './dingtalk/dwsClient.js';
import { TmuxClient } from './tmux/tmuxClient.js';
import { HookServer } from './hooks/hookServer.js';
import type { IncomingHook } from './hooks/hookTypes.js';
import { Poller } from './dingtalk/poller.js';
import { SessionManager } from './session/sessionManager.js';

export class Daemon {
  private readonly dws: DwsClient;
  private readonly tmux: TmuxClient;
  private readonly hookServer: HookServer;
  private readonly sessions: SessionManager;
  private readonly poller: Poller;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    this.dws = new DwsClient(cfg.dingtalk.dwsBin, log);
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

  async start(): Promise<void> {
    this.hookServer.setStatusProvider(() => this.sessions.getStatus());
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
