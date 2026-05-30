// 会话状态机与入站事件类型。
import type { OptionSet, PaneId } from '../types.js';

export type SessionState =
  | 'IDLE' // 等自然停
  | 'WAITING_USER' // 已推送选项，轮询用户选择
  | 'INJECTING'; // 已注入，等 Claude 跑下一轮（其完成即下一次自然停）

/** 用户在钉钉上点的表情 reaction（emoji 名即选项 key）。 */
export interface EmojiEvent {
  kind: 'emoji';
  emoji: string;
  /** 表情挂在哪条消息上（openMessageId）。 */
  messageId: string;
}

/** 用户发的文本消息（数字兜底）。 */
export interface TextEvent {
  kind: 'text';
  text: string;
  messageId: string;
  createTimeMs: number;
}

export type InboundEvent = EmojiEvent | TextEvent;

/** 单个 session 的运行态。 */
export interface SessionRecord {
  sessionId: string;
  state: SessionState;
  pane?: PaneId;
  /** 当前推送的选项集（WAITING_USER 时有效）。 */
  optionSet?: OptionSet;
  /** 当前推送消息的 openMessageId（用于挂接表情轮询）。 */
  pushedMessageId?: string;
  /** 推送时的 assistant 轮数，用于判定"等待期间用户直接在终端操作了"的陈旧情况。 */
  pushedAtTurns?: number;
}
