// 本地 HTTP server：接收 hook 脚本 POST 来的 Claude payload + tmux pane。
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '../logger.js';
import type { ClaudeHookPayload, IncomingHook } from './hookTypes.js';
import { PANEL_HTML } from '../panel/panelHtml.js';

export type HookHandler = (hook: IncomingHook) => void;
export type StatusProvider = () => unknown;
export type SwitchHandler = (sessionId: string) => Promise<{ ok: boolean; error?: string }>;

export class HookServer {
  private server?: Server;
  private statusProvider?: StatusProvider;
  private switchHandler?: SwitchHandler;
  /** /events 的 SSE 长连接（桌面控件推送）。 */
  private readonly sse = new Set<ServerResponse>();

  constructor(
    private readonly opts: { host: string; port: number },
    private readonly log: Logger,
    private readonly handler: HookHandler,
  ) {}

  setStatusProvider(p: StatusProvider): void {
    this.statusProvider = p;
  }

  /** 注册"点击切回会话"处理器（解析 pane、select-pane、激活终端）。 */
  setSwitchHandler(fn: SwitchHandler): void {
    this.switchHandler = fn;
  }

  /** 向所有 SSE 客户端推一帧状态（供 daemon 在展示态变化时调用）。 */
  broadcast(payload: unknown): void {
    if (this.sse.size === 0) return;
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.sse) {
      try {
        res.write(line);
      } catch {
        this.sse.delete(res);
      }
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        if (req.method === 'GET' && req.url?.startsWith('/status')) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.setHeader('access-control-allow-origin', '*'); // 允许浏览器/控件跨源拉取
          res.end(JSON.stringify(this.statusProvider?.() ?? { ok: true }, null, 2));
          return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/panel')) {
          // 置顶浮层(左缘抽屉的 WKWebView)页面：自包含 HTML，内部连 /events SSE 实时渲染。
          res.statusCode = 200;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(PANEL_HTML);
          return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/events')) {
          // SSE：建立长连接，状态变化时由 broadcast() 推送。
          res.statusCode = 200;
          res.setHeader('content-type', 'text/event-stream');
          res.setHeader('cache-control', 'no-cache');
          res.setHeader('connection', 'keep-alive');
          res.setHeader('access-control-allow-origin', '*');
          res.write(': connected\n\n');
          res.write(`data: ${JSON.stringify(this.statusProvider?.() ?? {})}\n\n`); // 连上即给初始快照
          this.sse.add(res);
          req.on('close', () => this.sse.delete(res));
          return;
        }
        if (req.url?.startsWith('/switch')) {
          // 桌面控件点击 → 切回该会话的 tmux pane。method 不限（GET/POST 皆可）。
          res.setHeader('content-type', 'application/json');
          res.setHeader('access-control-allow-origin', '*');
          const sid = new URL(req.url, 'http://localhost').searchParams.get('session') ?? '';
          if (!this.switchHandler || !sid) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'missing session' }));
            return;
          }
          this.switchHandler(sid)
            .then((r) => {
              res.statusCode = r.ok ? 200 : 409;
              res.end(JSON.stringify(r));
            })
            .catch((err) => {
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: String(err) }));
            });
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
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
      pane,
    };
    this.log.debug('收到 hook', { event: hook.event, type: hook.notificationType, pane, session: hook.sessionId.slice(0, 8) });
    this.handler(hook);
  }

  async stop(): Promise<void> {
    for (const res of this.sse) {
      try {
        res.end();
      } catch {
        /* 忽略 */
      }
    }
    this.sse.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
