// 把状态/选项格式化成钉钉消息并发送。title 带 pushTitlePrefix 作出站指纹（用于入站去重）。
import { homedir } from 'node:os';
import type { Config } from '../config.js';
import type { SessionId, OptionSet } from '../types.js';
import type { DwsClient } from './dwsClient.js';
import type { SendResult } from './dwsTypes.js';

/** 截断到 n 个字符，超出加省略号。 */
function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** session id 的短标识，放进 title 便于多 session 区分。 */
function shortSession(id: SessionId): string {
  return id.slice(0, 8);
}

/** 把 home 前缀缩成 ~。 */
function abbrevHome(p: string): string {
  const home = homedir();
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** 会话标注：tmux session 名 + 启动路径（用于区分不同 Claude Code 会话）。 */
export interface SessionLabel {
  tmuxSession?: string;
  cwd?: string;
}

/** M1：仅推送一条「等待输入 + 状态摘要」通知。 */
export async function pushStatus(
  dws: DwsClient,
  cfg: Config,
  args: { sessionId: SessionId; summary: string | null },
): Promise<SendResult> {
  const title = `${cfg.dingtalk.pushTitlePrefix} Claude 等待输入 #${shortSession(args.sessionId)}`;
  const body = args.summary ? truncate(args.summary, 500) : '（无摘要）';
  const text = `**Claude 停下，等待你的输入**\n\n${body}`;
  return dws.send({ group: cfg.dingtalk.openConversationId, title, text });
}

/** 把选项渲染成消息正文，并在末尾附一个可检索的标记（用于在 list 里定位本条推送）。 */
export function buildOptionsText(optionSet: OptionSet, marker: string, label?: SessionLabel): string {
  const lines = optionSet.options.map((o) => `${o.key}) ${o.label}`).join('\n');
  // 会话标注行：tmux 会话名 + 启动路径，区分不同 Claude Code 会话。
  const labelParts = [label?.tmuxSession, label?.cwd ? abbrevHome(label.cwd) : undefined].filter(Boolean);
  const labelLine = labelParts.length ? `📂 ${labelParts.join('  ·  ')}\n\n` : '';
  return `**${truncate(optionSet.summary, 200)}**\n\n${labelLine}点对应表情或回复编号：\n${lines}\n\n〔${marker}〕`;
}

/** 推送状态摘要 + 编号选项。text 内含 marker，便于轮询时定位该消息。 */
export async function pushOptions(
  dws: DwsClient,
  cfg: Config,
  args: {
    sessionId: SessionId;
    optionSet: OptionSet;
    marker: string;
    kind?: 'options' | 'permission';
    label?: SessionLabel;
  },
): Promise<SendResult> {
  const kindLabel = args.kind === 'permission' ? '需要授权' : '请选择';
  // 标题用 tmux 会话名(更直观)；没有则回退到 session id 前缀。
  const who = args.label?.tmuxSession ? args.label.tmuxSession : `#${shortSession(args.sessionId)}`;
  const title = `${cfg.dingtalk.pushTitlePrefix} ${kindLabel} · ${who}`;
  const text = buildOptionsText(args.optionSet, args.marker, args.label);
  return dws.send({ group: cfg.dingtalk.openConversationId, title, text });
}
