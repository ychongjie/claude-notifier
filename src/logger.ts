// 轻量分级日志：写 stderr，同时可追加到文件。会对常见敏感字段做脱敏。
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// 出现在日志里就打码的字段名（大小写不敏感），避免把 token 等写进文件。
const REDACT_KEYS = /(token|secret|authorization|client_secret|access_token|refresh_token)/i;

function redact(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? '***' : redact(v);
  }
  return out;
}

export class Logger {
  private threshold: number;
  private filePath?: string;

  constructor(opts: { level?: LogLevel; filePath?: string } = {}) {
    this.threshold = LEVEL_ORDER[opts.level ?? 'info'];
    this.filePath = opts.filePath;
    if (this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
      } catch {
        // 目录创建失败不致命，退化为只写 stderr。
        this.filePath = undefined;
      }
    }
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const ts = new Date().toISOString();
    const payload = fields ? ` ${JSON.stringify(redact(fields))}` : '';
    const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${payload}`;
    process.stderr.write(line + '\n');
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, line + '\n');
      } catch {
        // 忽略写文件错误。
      }
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields);
  }
}
