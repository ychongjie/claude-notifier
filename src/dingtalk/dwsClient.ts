// dws CLI 的薄封装：通过 execFile（数组传参，不走 shell）收发钉钉消息。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../logger.js';
import type { DwsMessage, ListResult, SendResult } from './dwsTypes.js';

const pExecFile = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

/** 把毫秒时间戳格式化为 dws --time 需要的 "YYYY-MM-DD HH:mm:ss"（本地时区）。 */
export function formatDwsTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把 "YYYY-MM-DD HH:mm:ss"（本地时区）解析为毫秒。 */
export function parseDwsTime(s: string): number {
  // 形如 2026-05-30 11:28:51，按本地时区解析。
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return Date.parse(s);
  const [, y, mo, da, h, mi, se] = m;
  return new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(se)).getTime();
}

export class DwsError extends Error {
  readonly reason?: unknown;
  readonly stdout?: string;
  constructor(message: string, reason?: unknown, stdout?: string) {
    super(message);
    this.name = 'DwsError';
    this.reason = reason;
    this.stdout = stdout;
  }
}

export class DwsClient {
  constructor(
    private readonly bin: string,
    private readonly log: Logger,
  ) {}

  private async run(args: string[]): Promise<unknown> {
    this.log.debug('dws run', { args });
    let stdout: string;
    try {
      ({ stdout } = await pExecFile(this.bin, args, { maxBuffer: MAX_BUFFER }));
    } catch (err) {
      throw new DwsError(`dws 调用失败: ${args.join(' ')}`, err);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new DwsError('dws 输出不是合法 JSON', err, stdout);
    }
    this.detectAuthFailure(parsed);
    return parsed;
  }

  /** 识别 dws 鉴权失效/过期，给出清晰告警（daemon 无法自修，需人工 dws auth login）。 */
  private detectAuthFailure(parsed: unknown): void {
    const s = JSON.stringify(parsed);
    if (/PAT_\w*?(NO_PERMISSION|RISK)|authenticated"\s*:\s*false|未登录|登录已过期|token.*(expired|invalid)/i.test(s)) {
      this.log.error('dws 鉴权可能已失效/过期，请在终端运行：dws auth login', { hint: s.slice(0, 160) });
    }
  }

  /** 给群发一条消息（群消息 --title 必填）。返回 open_taskId。 */
  async send(opts: { group: string; title: string; text: string }): Promise<SendResult> {
    const res = (await this.run([
      'chat', 'message', 'send',
      '--group', opts.group,
      '--title', opts.title,
      '--text', opts.text,
      '--yes', '--format', 'json',
    ])) as Record<string, unknown>;
    const success = res?.['success'] === true || res?.['errcode'] === 0;
    if (!success) {
      throw new DwsError(`发送失败: ${JSON.stringify(res)}`);
    }
    const result = res?.['result'] as Record<string, unknown> | undefined;
    return { open_taskId: result?.['open_taskId'] as string | undefined, success: true };
  }

  /** 读取群消息。--time 起始时间必填，否则返回空。 */
  async list(opts: { group: string; sinceMs: number; forward?: boolean; limit?: number }): Promise<DwsMessage[]> {
    const res = (await this.run([
      'chat', 'message', 'list',
      '--group', opts.group,
      '--time', formatDwsTime(opts.sinceMs),
      '--forward', String(opts.forward ?? false),
      '--limit', String(opts.limit ?? 20),
      '--format', 'json',
    ])) as ListResult;
    return res?.result?.messages ?? [];
  }

  /** 给某条消息添加文字表情（用于预置候选项）。 */
  async addEmoji(opts: { group: string; messageId: string; emoji: string }): Promise<void> {
    await this.run([
      'chat', 'message', 'add-emoji',
      '--group', opts.group,
      '--message-id', opts.messageId,
      '--emoji', opts.emoji,
      '--yes', '--format', 'json',
    ]);
  }
}
