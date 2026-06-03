// Claude Code hook 事件类型，以及 daemon 内部归一化后的形态。
import type { PaneId, SessionId } from '../types.js';

/** Claude 通过 stdin 传给 hook 脚本的 payload（取我们关心的字段）。 */
export interface ClaudeHookPayload {
  session_id?: SessionId;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** Notification 事件带的人类可读消息。 */
  message?: string;
  /** Notification 的子类型（idle_prompt / permission_prompt / …）。 */
  notification_type?: string;
  /** Stop 事件的重入标记。 */
  stop_hook_active?: boolean;
  /** PreToolUse/PostToolUse 的工具名（Bash/Edit/…）。 */
  tool_name?: string;
  /** PreToolUse 的工具入参（command / file_path / …）。 */
  tool_input?: Record<string, unknown>;
}

/** daemon 内部归一化的 hook 事件（合并了 query 里的 pane）。 */
export interface IncomingHook {
  sessionId: SessionId;
  transcriptPath: string;
  cwd?: string;
  event: string;
  notificationType?: string;
  message?: string;
  stopHookActive?: boolean;
  /** PreToolUse/PostToolUse 的工具名。 */
  toolName?: string;
  /** PreToolUse 的工具入参。 */
  toolInput?: Record<string, unknown>;
  /** 来自 $TMUX_PANE，可能为空（Claude 不在 tmux 里时）。 */
  pane?: PaneId;
}
