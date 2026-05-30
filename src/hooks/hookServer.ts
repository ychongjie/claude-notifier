// 本地 HTTP server：接收 hook 脚本 POST 来的 Claude payload + tmux pane。
import { createServer, type Server } from 'node:http';
import type { Logger } from '../logger.js';
import type { ClaudeHookPayload, IncomingHook } from './hookTypes.js';

export type HookHandler = (hook: IncomingHook) => void;
export type StatusProvider = () => unknown;

export class HookServer {
  private server?: Server;
  private statusProvider?: StatusProvider;

  constructor(
    private readonly opts: { host: string; port: number },
    private readonly log: Logger,
    private readonly handler: HookHandler,
  ) {}

  setStatusProvider(p: StatusProvider): void {
    this.statusProvider = p;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        if (req.method === 'GET' && req.url?.startsWith('/status')) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(this.statusProvider?.() ?? { ok: true }, null, 2));
          return;
        }
        if (req.method !== 'POST' || !req.url?.startsWith('/hook')) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        const pane = (req.headers['x-cn-pane'] as string | undefined) || undefined;
        req.on('end', () => {
          // 立刻回 200，让 hook 脚本快速返回，处理放到后面异步做。
          res.statusCode = 200;
          res.end('ok');
          try {
            this.dispatch(pane, Buffer.concat(chunks).toString('utf8'));
          } catch (err) {
            this.log.error('hook 处理异常', { err: String(err) });
          }
        });
        req.on('error', (err) => this.log.warn('hook 请求出错', { err: String(err) }));
      });
      this.server.on('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.log.info('HookServer 已启动', { url: `http://${this.opts.host}:${this.opts.port}/hook` });
        resolve();
      });
    });
  }

  private dispatch(pane: string | undefined, body: string): void {
    let payload: ClaudeHookPayload = {};
    if (body.trim()) {
      try {
        payload = JSON.parse(body) as ClaudeHookPayload;
      } catch {
        this.log.warn('hook payload 非 JSON，忽略 body', { bodyHead: body.slice(0, 120) });
      }
    }
    if (!payload.session_id || !payload.transcript_path) {
      this.log.warn('hook 缺少 session_id/transcript_path，丢弃', { pane, event: payload.hook_event_name });
      return;
    }
    const hook: IncomingHook = {
      sessionId: payload.session_id,
      transcriptPath: payload.transcript_path,
      cwd: payload.cwd,
      event: payload.hook_event_name ?? 'unknown',
      notificationType: payload.notification_type,
      message: payload.message,
      stopHookActive: payload.stop_hook_active,
      pane,
    };
    this.log.debug('收到 hook', { event: hook.event, type: hook.notificationType, pane, session: hook.sessionId.slice(0, 8) });
    this.handler(hook);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
