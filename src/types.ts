// 跨模块共享的基础类型。

/** Claude Code 的 session id（hook payload 里的 session_id）。 */
export type SessionId = string;

/** tmux pane 标识，如 "%3"（来自 $TMUX_PANE）。 */
export type PaneId = string;

/** 一个被推送给用户的选项。 */
export interface Option {
  /** "1".."3"，与表情/数字回复对应。 */
  key: string;
  /** 简短标签，展示用。 */
  label: string;
  /** 被选中时原样注入到 session 的文本。 */
  injectText: string;
}

/** 一轮要推送的选项集合（meta-prompt 产物，或固定兜底）。 */
export interface OptionSet {
  /** 状态摘要，<=200 字。 */
  summary: string;
  options: Option[];
}
