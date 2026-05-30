// 入站去重：把每轮拉到的消息列表转成"新输入"事件。
//
// 难点（实测约束）：
//  - 推送与用户回复 senderOpenDingTalkId 相同，无法按 sender 区分；
//  - 表情 reaction 累积挂在消息的 emotionReplyList 上，无单条时间戳；
//  - send 返回的 open_taskId 与 list 的 openMessageId 不同源。
// 对策：文本按 openMessageId 集合去重；表情对"目标消息已见过的 emoji 集"做差集。
import type { DwsMessage } from './dwsTypes.js';
import { parseDwsTime } from './dwsClient.js';
import type { InboundEvent } from '../session/types.js';

export class InboundTracker {
  /** 已处理的文本消息 openMessageId（LRU 上限）。 */
  private processedText = new Set<string>();
  /** 每条消息已见过的 emoji 集合（仅对活跃推送消息有意义）。 */
  private emojiSeen = new Map<string, Set<string>>();
  /** 见过的最大 createTime（ms）。 */
  watermarkMs = 0;
  private primed = false;

  constructor(
    private readonly userDisplayName: string,
    private readonly processedIdsMax: number,
  ) {}

  /** 该用户在某消息上点过的 emoji 集合（排除别人的）。 */
  private myEmojis(msg: DwsMessage): Set<string> {
    const s = new Set<string>();
    for (const e of msg.emotionReplyList ?? []) {
      if (e.replyUsers?.includes(this.userDisplayName)) s.add(e.emoji);
    }
    return s;
  }

  /** 启动时把当前所有消息/表情记为已见，避免重放历史（不产生事件）。 */
  prime(messages: DwsMessage[]): void {
    for (const m of messages) {
      this.processedText.add(m.openMessageId);
      this.emojiSeen.set(m.openMessageId, this.myEmojis(m));
      this.watermarkMs = Math.max(this.watermarkMs, parseDwsTime(m.createTime));
    }
    this.primed = true;
  }

  /** 把某条（刚推送的）消息当前表情设为基线，使后续只报新增表情。 */
  baselineEmojis(msg: DwsMessage): void {
    this.emojiSeen.set(msg.openMessageId, this.myEmojis(msg));
    this.processedText.add(msg.openMessageId); // 自己推送的消息不当文本输入
  }

  /**
   * 处理一轮消息，返回新输入事件。
   * @param activePushedIds 当前处于 WAITING_USER 的各 session 的推送消息 id，用于挂接表情。
   */
  ingest(messages: DwsMessage[], activePushedIds: Set<string>): InboundEvent[] {
    if (!this.primed) {
      this.prime(messages);
      return [];
    }
    const events: InboundEvent[] = [];
    for (const m of messages) {
      const tMs = parseDwsTime(m.createTime);
      this.watermarkMs = Math.max(this.watermarkMs, tMs);

      // 表情：仅对活跃推送消息做差集。
      if (activePushedIds.has(m.openMessageId)) {
        const current = this.myEmojis(m);
        const prev = this.emojiSeen.get(m.openMessageId) ?? new Set<string>();
        for (const emoji of current) {
          if (!prev.has(emoji)) events.push({ kind: 'emoji', emoji, messageId: m.openMessageId });
        }
        this.emojiSeen.set(m.openMessageId, current);
      }

      // 文本：未处理过的新消息。
      if (!this.processedText.has(m.openMessageId)) {
        this.processedText.add(m.openMessageId);
        events.push({ kind: 'text', text: m.content.trim(), messageId: m.openMessageId, createTimeMs: tMs });
      }
    }
    this.evictText();
    return events;
  }

  private evictText(): void {
    if (this.processedText.size <= this.processedIdsMax) return;
    const excess = this.processedText.size - this.processedIdsMax;
    const it = this.processedText.values();
    for (let i = 0; i < excess; i++) {
      const v = it.next().value;
      if (v !== undefined) this.processedText.delete(v);
    }
  }
}
