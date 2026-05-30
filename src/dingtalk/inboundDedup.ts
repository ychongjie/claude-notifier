// 入站去重（仅表情 reaction）：对活跃推送消息的 emotionReplyList 做差集，报新增表情。
//
// 实测约束：表情累积挂在消息上、无单条时间戳；推送与用户回复同一 sender。
// 只认"挂在我们推送消息上的表情",故按消息维护已见 emoji 集合，新增者即用户选择。
import type { DwsMessage } from './dwsTypes.js';
import type { EmojiEvent } from '../session/types.js';

export class InboundTracker {
  /** openMessageId → 已见过的 emoji 集合。 */
  private emojiSeen = new Map<string, Set<string>>();

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

  /** 处理一轮消息，返回活跃推送消息上的新增表情事件。 */
  ingest(messages: DwsMessage[], activePushedIds: Set<string>): EmojiEvent[] {
    const events: EmojiEvent[] = [];
    for (const m of messages) {
      if (!activePushedIds.has(m.openMessageId)) continue;
      const current = this.myEmojis(m);
      const prev = this.emojiSeen.get(m.openMessageId) ?? new Set<string>();
      for (const emoji of current) {
        if (!prev.has(emoji)) events.push({ kind: 'emoji', emoji, messageId: m.openMessageId });
      }
      this.emojiSeen.set(m.openMessageId, current);
    }
    return events;
  }
}
