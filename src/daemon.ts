// 常驻守护进程。M1：收到 hook → 读 transcript 摘要 → 推送一条钉钉通知（含去重）。
// 状态机 / 轮询 / 注入随 M2+ 接入。
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { DwsClient } from './dingtalk/dwsClient.js';
import { TmuxClient } from './tmux/tmuxClient.js';
import { HookServer } from './hooks/hookServer.js';
import type { IncomingHook } from './hooks/hookTypes.js';
import { readTranscript } from './options/transcript.js';
import { pushStatus } from './dingtalk/push.js';

export class Daemon {
  private readonly dws: DwsClient;
  private readonly tmux: TmuxClient;
  private readonly hookServer: HookServer;
  /** 去重：sessionId → 上次已通知的 key（event:assistantTurns）。 */
  private readonly lastNotified = new Map<string, string>();
  /** sessionId → 最近一次见到的 tmux pane。 */
  private readonly paneBySession = new Map<string, string>();

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    this.dws = new DwsClient(cfg.dingtalk.dwsBin, log);
    this.tmux = new TmuxClient(log);
    this.hookServer = new HookServer(cfg.hookServer, log, (h) => this.onHook(h));
  }

  async start(): Promise<void> {
    await this.hookServer.start();
    this.log.info('daemon 已启动', { group: this.cfg.dingtalk.openConversationId });
    const shutdown = () => {
      this.log.info('收到退出信号，关闭中…');
      void this.hookServer.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  /** M1 的 hook 处理：仅在「有新进展」时推送状态。 */
  private onHook(h: IncomingHook): void {
    if (h.pane) this.paneBySession.set(h.sessionId, h.pane);

    // 只处理"等待输入"类事件：Stop（立即）、Notification idle_prompt（60s 延迟兜底）、
    // permission_prompt（需要授权）。其它 Notification 子类型忽略。
    const isPermission = h.event === 'Notification' && h.notificationType === 'permission_prompt';
    const isIdle =
      h.event === 'Stop' ||
      (h.event === 'Notification' && (h.notificationType === 'idle_prompt' || h.notificationType == null));
    if (!isPermission && !isIdle) return;

    const info = readTranscript(h.transcriptPath);
    // 去重 key：把 Stop 与 idle_prompt 归为同一个 "idle" 类（同一次停只推一条，
    // idle_prompt 退化为 Stop 未送达时的兜底）；permission 单独成类避免被吞。
    const cls = isPermission ? 'perm' : 'idle';
    const key = `${cls}:${info.assistantTurns}`;
    if (this.lastNotified.get(h.sessionId) === key) {
      this.log.debug('重复 hook，跳过推送', { session: h.sessionId.slice(0, 8), key });
      return;
    }
    this.lastNotified.set(h.sessionId, key);

    void this.notify(h, info.lastAssistantText);
  }

  private async notify(h: IncomingHook, summary: string | null): Promise<void> {
    try {
      const res = await pushStatus(this.dws, this.cfg, { sessionId: h.sessionId, summary });
      this.log.info('已推送状态通知', {
        session: h.sessionId.slice(0, 8),
        event: h.event,
        pane: h.pane,
        open_taskId: res.open_taskId,
      });
    } catch (err) {
      this.log.error('推送失败', { err: String(err) });
    }
  }
}
