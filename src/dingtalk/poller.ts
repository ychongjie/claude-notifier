// 入站轮询：定时拉群消息 → InboundTracker 去重 → 把新事件交给回调。
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { DwsClient, DwsError } from './dwsClient.js';
import { InboundTracker } from './inboundDedup.js';
import type { InboundEvent } from '../session/types.js';

export interface PollContext {
  /** 当前处于 WAITING_USER 的推送消息 id 集合。 */
  activePushedIds: Set<string>;
  /** 这些活跃推送消息里最早的 createTime（ms），用于回看窗口确保迟到表情不漏。 */
  earliestActiveMs?: number;
}

export class Poller {
  private timer?: ReturnType<typeof setInterval>;
  private readonly tracker: InboundTracker;
  private running = false;
  /** 下次允许真正调用 dws 的时间（ms）。失败后用退避推后，避免每 2s 硬刚。 */
  private nextPollAt = 0;
  /** 连续失败次数，用于指数退避。 */
  private consecutiveFails = 0;
  /** 鉴权失效暂停标记：已告警过则不再刷屏。 */
  private authPaused = false;

  constructor(
    private readonly dws: DwsClient,
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly getContext: () => PollContext,
    private readonly onEvents: (events: InboundEvent[]) => void,
  ) {
    this.tracker = new InboundTracker(cfg.dingtalk.userDisplayName);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.poll.intervalMs);
    this.log.info('Poller 已启动', { intervalMs: this.cfg.poll.intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // 防重入（上一轮还没结束）
    const ctx = this.getContext();
    // 没有在等待的会话就不轮询，省 dws 调用（也避免无谓的鉴权消耗）。
    if (ctx.activePushedIds.size === 0) {
      this.resetBackoff(); // 下次刚有等待时立刻轮询，不被旧退避卡住
      return;
    }
    if (Date.now() < this.nextPollAt) return; // 退避/鉴权暂停中
    this.running = true;
    try {
      const slack = this.cfg.poll.overlapSlackMs;
      // 回看窗口覆盖最早的活跃推送消息时间（迟到表情不漏），无则近 5 分钟。
      const base = ctx.earliestActiveMs ?? Date.now();
      const sinceMs = Math.max(1, base - slack);
      const messages = await this.dws.list({
        group: this.cfg.dingtalk.openConversationId,
        sinceMs,
        forward: false,
        limit: this.cfg.poll.listLimit,
      });
      this.onPollSuccess();
      const events = this.tracker.ingest(messages, ctx.activePushedIds);
      if (events.length) this.onEvents(events);
    } catch (err) {
      this.onPollFailure(err);
    } finally {
      this.running = false;
    }
  }

  private resetBackoff(): void {
    this.consecutiveFails = 0;
    this.authPaused = false;
    this.nextPollAt = 0;
  }

  private onPollSuccess(): void {
    if (this.consecutiveFails > 0 || this.authPaused) this.log.info('轮询已恢复');
    this.resetBackoff();
  }

  private onPollFailure(err: unknown): void {
    this.consecutiveFails++;
    const category = err instanceof DwsError ? err.category : 'unknown';
    // 鉴权失效无法自修（且每次调用都可能让 dws 拉起浏览器登录页）→ 长暂停、只偶尔探测，恢复后自动继续。
    if (category === 'auth') {
      const wait = this.cfg.poll.authPauseMs;
      this.nextPollAt = Date.now() + wait;
      if (!this.authPaused) {
        this.authPaused = true;
        this.log.error(
          `dws 鉴权失效：请在终端运行「dws auth login」。轮询已暂停，每 ${Math.round(wait / 1000)}s 探测一次，登录后自动恢复。`,
          { err: String(err) },
        );
      }
      return;
    }
    // 网络/未知：指数退避（intervalMs × 2^n，封顶 maxBackoffMs）。
    const base = this.cfg.poll.intervalMs;
    const backoff = Math.min(base * 2 ** Math.min(this.consecutiveFails - 1, 16), this.cfg.poll.maxBackoffMs);
    this.nextPollAt = Date.now() + backoff;
    this.log.warn('轮询出错（退避后重试）', { err: String(err), category, backoffMs: backoff, fails: this.consecutiveFails });
  }

  /** 暴露 tracker 以便 daemon 找到推送消息后设基线。 */
  get inbound(): InboundTracker {
    return this.tracker;
  }
}
