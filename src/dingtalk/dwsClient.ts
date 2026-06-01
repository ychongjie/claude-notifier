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

/**
 * 错误分类：daemon 据此决定退避策略。
 * - auth：未登录/凭证失效（exit 2），需人工 dws auth login → 长暂停。
 * - pat：缺少行为授权（exit 4，host-owned PAT 模式下返回结构化 JSON），需 dws pat chmod → 长暂停。
 * - network：网络/超时 → 指数退避。
 */
export type DwsErrorCategory = 'auth' | 'pat' | 'network' | 'unknown';

export class DwsError extends Error {
  readonly reason?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly category: DwsErrorCategory;
  constructor(
    message: string,
    opts: { reason?: unknown; stdout?: string; stderr?: string; exitCode?: number; category?: DwsErrorCategory } = {},
  ) {
    super(message);
    this.name = 'DwsError';
    this.reason = opts.reason;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.exitCode = opts.exitCode;
    this.category = opts.category ?? 'unknown';
  }
}

export class DwsClient {
  constructor(
    private readonly bin: string,
    private readonly log: Logger,
    /** 非空则注入 DINGTALK_DWS_AGENTCODE，让 dws 以 host-owned PAT 模式运行（不拉浏览器）。 */
    private readonly agentCode?: string,
  ) {}

  /** dws 子进程的环境：继承当前环境，并按需注入 host-owned PAT 标识。 */
  private childEnv(): NodeJS.ProcessEnv | undefined {
    if (!this.agentCode) return undefined;
    return { ...process.env, DINGTALK_DWS_AGENTCODE: this.agentCode };
  }

  private async run(args: string[]): Promise<unknown> {
    this.log.debug('dws run', { args });
    let stdout: string;
    try {
      ({ stdout } = await pExecFile(this.bin, args, { maxBuffer: MAX_BUFFER, env: this.childEnv() }));
    } catch (err) {
      throw this.classifyExecError(args, err);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new DwsError('dws 输出不是合法 JSON', { reason: err, stdout });
    }
    this.detectAuthFailure(parsed);
    return parsed;
  }

  /**
   * dws 失败时退出码非零、且把结构化错误写到 **stderr**（如
   * `{"error":{"category":"auth","reason":"not_authenticated",...}}`）。
   * 解析出来分类，便于上层（poller）按 auth/network 采取不同退避，并把可读原因带进日志。
   */
  private classifyExecError(args: string[], err: unknown): DwsError {
    const e = err as { stderr?: string | Buffer; code?: number; message?: string };
    const stderr = (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString()) ?? '';
    const exitCode = typeof e.code === 'number' ? e.code : undefined;
    let category: DwsErrorCategory = 'unknown';
    let detail = '';
    // dws 退出码契约：4=PAT 行为授权不足（host-owned 模式返回结构化 JSON），2=auth 未登录。
    if (exitCode === 4) category = 'pat';
    try {
      const j = JSON.parse(stderr) as { error?: { category?: string; reason?: string; message?: string; hint?: string } };
      const er = j?.error;
      if (er) {
        detail = [er.message, er.hint].filter(Boolean).join(' / ');
        if (category === 'unknown') {
          if (er.category === 'auth' || /not_authenticated|auth/i.test(er.reason ?? '')) category = 'auth';
          else if (/network|timeout/i.test(er.category ?? '') || /timeout/i.test(er.reason ?? '')) category = 'network';
        }
      }
    } catch {
      // stderr 非 JSON，下面按文本特征兜底分类
    }
    if (category === 'unknown') {
      const blob = stderr || (e.message ?? '');
      if (/PAT_\w*|pat.*(auth|scope|permission)|行为授权|需要.*授权/i.test(blob)) category = 'pat';
      else if (/not_authenticated|auth login|未登录|登录已过期|gateway_auth_expired/i.test(blob)) category = 'auth';
      else if (/i\/o timeout|dial tcp|lookup .*timeout|NETWORK_TIMEOUT|connection refused|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|无法连接|超时/i.test(blob))
        category = 'network';
    }
    const msg = `dws 调用失败[${category}]: ${args.slice(0, 3).join(' ')}${detail ? ` — ${detail}` : ''}`;
    return new DwsError(msg, { reason: err, stderr, exitCode, category });
  }

  /** 兜底：极少数鉴权错误可能以"成功输出"形式出现在 stdout，这里也扫一遍给出清晰告警。 */
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
