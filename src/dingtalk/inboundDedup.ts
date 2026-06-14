// 入站去重：(1) 对活跃推送消息的 emotionReplyList 做差集，报新增表情；
//          (2) 识别「引用某条活跃推送消息」的文字回复，按引用原消息 id 归属到会话。
//
// 实测约束：表情累积挂在消息上、无单条时间戳；推送与用户回复同一 sender。
// 表情：只认"挂在我们推送消息上的表情",按消息维护已见 emoji 集合，新增者即用户选择。
// 文字：钉钉「引用回复」会在消息上带 quotedMessage（含被引用消息的 openMessageId），
//      据此把裸文字精确归属到对应会话（解决多会话歧义）；按回复消息自身 id 去重，避免重复注入。
import type { DwsMessage } from './dwsTypes.js';
import type { InboundEvent } from '../session/types.js';

/** 已处理过的文字回复 id 上限：超过即清空（已注入的等待早已失活，重清不会误触发）。 */
const TEXT_SEEN_MAX = 1000;

export class InboundTracker {
  /** openMessageId → 已见过的 emoji 集合。 */
  private emojiSeen = new Map<string, Set<string>>();
  /** 已处理过的文字回复消息 id（去重，避免每轮轮询重复注入同一条回复）。 */
  private textSeen = new Set<string>();

  constructor(private readonly userDisplayName: string) {}

  /** 该用户在某消息上点过的 emoji 集合（排除别人）。 */
  private myEmojis(msg: DwsMessage): Set<string> {
    const s = new Set<string>();
    for (const e of msg.emotionReplyList ?? []) {
      if (e.replyUsers?.includes(this.userDisplayName)) s.add(e.emoji);
    }
    return s;
  }

  /** 把某条（刚推送的）消息当前表情设为基线，使后续只报新增表情。 */
  baselineEmojis(msg: DwsMessage): void {
    this.emojiSeen.set(msg.openMessageId, this.myEmojis(msg));
  }

  /** 等待结束后清理该消息的表情记录，避免无界增长。 */
  forget(messageId: string): void {
    this.emojiSeen.delete(messageId);
  }

  /** 处理一轮消息，返回活跃推送消息上的新增表情事件 + 引用活跃推送的文字回复事件。 */
  ingest(messages: DwsMessage[], activePushedIds: Set<string>): InboundEvent[] {
    const events: InboundEvent[] = [];
    for (const m of messages) {
      // (1) 表情：挂在我们推送消息上的新增表情。
      if (activePushedIds.has(m.openMessageId)) {
        const current = this.myEmojis(m);
        const prev = this.emojiSeen.get(m.openMessageId) ?? new Set<string>();
        for (const emoji of current) {
          if (!prev.has(emoji)) events.push({ kind: 'emoji', emoji, messageId: m.openMessageId });
        }
        this.emojiSeen.set(m.openMessageId, current);
      }
      // (2) 文字：用户「引用」某条活跃推送消息回复的文字（我们自己的推送从不引用，天然区分）。
      const q = m.quotedMessage;
      if (q && activePushedIds.has(q.openMessageId) && !this.textSeen.has(m.openMessageId)) {
        this.textSeen.add(m.openMessageId);
        if (this.textSeen.size > TEXT_SEEN_MAX) this.textSeen.clear();
        const text = (m.content ?? '').trim();
        if (text) events.push({ kind: 'text', text, messageId: m.openMessageId, quotedMessageId: q.openMessageId });
      }
    }
    return events;
  }
}
