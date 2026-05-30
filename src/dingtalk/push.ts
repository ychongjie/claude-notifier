// 把状态/选项格式化成钉钉消息并发送。title 带 pushTitlePrefix 作出站指纹（用于入站去重）。
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

/** M2+：推送状态摘要 + 编号选项。 */
export async function pushOptions(
  dws: DwsClient,
  cfg: Config,
  args: { sessionId: SessionId; optionSet: OptionSet },
): Promise<SendResult> {
  const title = `${cfg.dingtalk.pushTitlePrefix} 请选择 #${shortSession(args.sessionId)}`;
  const lines = args.optionSet.options.map((o) => `${o.key}) ${o.label}`).join('\n');
  const text = `**${truncate(args.optionSet.summary, 200)}**\n\n点对应表情或回复编号：\n${lines}`;
  return dws.send({ group: cfg.dingtalk.openConversationId, title, text });
}
