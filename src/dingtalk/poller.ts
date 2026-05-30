// 入站轮询：定时拉群消息 → InboundTracker 去重 → 把新事件交给回调。
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { DwsClient } from './dwsClient.js';
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
    if (ctx.activePushedIds.size === 0) return;
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
      const events = this.tracker.ingest(messages, ctx.activePushedIds);
      if (events.length) this.onEvents(events);
    } catch (err) {
      this.log.warn('轮询出错（将重试）', { err: String(err) });
    } finally {
      this.running = false;
    }
  }

  /** 暴露 tracker 以便 daemon 找到推送消息后设基线。 */
  get inbound(): InboundTracker {
    return this.tracker;
  }
}
