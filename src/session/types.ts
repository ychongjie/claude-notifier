// 会话状态机与入站事件类型。
import type { OptionSet, PaneId } from '../types.js';

export type SessionState =
  | 'IDLE' // 等自然停
  | 'GENERATING_OPTIONS' // 已注入 meta-prompt，等 Claude 吐结构化选项
  | 'WAITING_USER' // 已推送选项，轮询用户选择
  | 'INJECTING'; // 已注入，等 Claude 跑下一轮（其完成即下一次自然停）

/** 用户在钉钉上点的表情 reaction（emoji 名即选项 key）。 */
export interface EmojiEvent {
  kind: 'emoji';
  emoji: string;
  /** 表情挂在哪条消息上（openMessageId）。 */
  messageId: string;
}

/** 用户「引用某条推送消息」回复的文字（自由指令；纯数字时也可当作选编号）。 */
export interface TextReplyEvent {
  kind: 'text';
  /** 用户回复的文字内容。 */
  text: string;
  /** 该回复消息自身的 openMessageId（用于去重，避免每轮轮询重复注入）。 */
  messageId: string;
  /** 被引用的原推送消息 openMessageId（用于归属到对应会话，解决多会话歧义）。 */
  quotedMessageId: string;
}

export type InboundEvent = EmojiEvent | TextReplyEvent;

/** 单个 session 的运行态。 */
export interface SessionRecord {
  sessionId: string;
  state: SessionState;
  pane?: PaneId;
  /** 会话工作目录（来自 hook payload）。 */
  cwd?: string;
  /** 当前推送的选项集（WAITING_USER 时有效）。 */
  optionSet?: OptionSet;
  /** 当前推送消息的 openMessageId（用于挂接表情轮询）。 */
  pushedMessageId?: string;
  /** 推送时的 assistant 轮数，用于判定"等待期间用户直接在终端操作了"的陈旧情况。 */
  pushedAtTurns?: number;
  // ---- GENERATING_OPTIONS 期间使用 ----
  /** 注入 meta-prompt 时的 assistant 轮数（水位），用于识别"选项已产出"。 */
  genTurns?: number;
  /** 本轮 meta-prompt 的 sentinel，校验 Claude 输出是否对应本轮。 */
  sentinel?: string;
  /** 本轮是否为「更详细」生成（用户点了 regen-detail 选项触发）；用于重试时复用同一变体。 */
  genDetailed?: boolean;
  /** 剩余重试次数（JSON 非法时）。 */
  retriesLeft?: number;
  /** 生成超时定时器。 */
  genTimer?: ReturnType<typeof setTimeout>;
  /** 熔断器：近期 meta-prompt 注入时间戳（ms），用于限制单位时间生成次数。 */
  genTimes?: number[];
}
