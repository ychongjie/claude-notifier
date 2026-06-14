// 跨模块共享的基础类型。

/** Claude Code 的 session id（hook payload 里的 session_id）。 */
export type SessionId = string;

/** tmux pane 标识，如 "%3"（来自 $TMUX_PANE）。 */
export type PaneId = string;

/** 一个被推送给用户的选项。 */
export interface Option {
  /** "1".."5"，与表情回复对应。 */
  key: string;
  /** 简短标签，展示用。 */
  label: string;
  /** 被选中时原样注入到 session 的文本（普通选项）。 */
  injectText: string;
  /** 若设置，则改为向 pane 发送该 tmux 按键名（如 Enter/Escape），用于权限菜单的允许/拒绝。 */
  keys?: string;
  /**
   * 特殊动作（非普通文本注入）：
   * - `regen-detail`：固定的「看更详细的进展和选项」项，选中后不推进实际工作，
   *   而是用「更详细」变体的 meta-prompt 重新让 Claude 产出一轮更详尽的进展+选项再推送。
   */
  action?: 'regen-detail';
}

/** 一轮要推送的选项集合（meta-prompt 产物，或固定兜底）。 */
export interface OptionSet {
  /** 状态摘要，<=200 字。 */
  summary: string;
  options: Option[];
}
