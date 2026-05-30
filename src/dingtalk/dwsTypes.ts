// dws CLI 返回结构的类型（实测自 dws v1.0.32）。

/** chat message list 返回的单条消息。 */
export interface DwsMessage {
  content: string;
  /** 形如 "2026-05-30 11:28:51"（本机本地时区）。 */
  createTime: string;
  openConversationId: string;
  /** 稳定的消息 id，用于去重。注意与 send 返回的 open_taskId 不同源。 */
  openMessageId: string;
  sender: string;
  senderOpenDingTalkId: string;
  /** 文字表情/reaction，累积列表，无单条时间戳。 */
  emotionReplyList?: EmotionReply[];
}

export interface EmotionReply {
  emoji: string;
  /** 点了该表情的用户显示名列表。 */
  replyUsers: string[];
}

/** chat message send 的返回。open_taskId 与 list 的 openMessageId 不同源。 */
export interface SendResult {
  open_taskId?: string;
  success: boolean;
}

/** list 的返回外层结构。 */
export interface ListResult {
  result?: {
    hasMore?: boolean;
    messages?: DwsMessage[];
    nextCursor?: number;
  };
  success?: boolean;
}
