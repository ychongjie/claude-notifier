// tmux 封装：把文本注入到指定 pane（send-keys -l 字面模式），并探测 pane 是否存在。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../logger.js';
import type { PaneId } from '../types.js';

const pExecFile = promisify(execFile);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TmuxClient {
  constructor(
    private readonly log: Logger,
    private readonly bin = 'tmux',
  ) {}

  private async run(args: string[]): Promise<string> {
    this.log.debug('tmux run', { args });
    const { stdout } = await pExecFile(this.bin, args, { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  }

  /**
   * 所有存活 pane 的信息：pane_id → { session 名, current_path }。
   * 供展示态一次性批量同步（探活 + 刷新 session 名 + 启动目录）。
   */
  async listPaneInfo(): Promise<Map<string, { session: string; path: string }>> {
    // 空格分隔（pane_id 与 session_name 无空格；path 取剩余部分，容忍路径含空格）。
    // 不用 \t：launchd 下 \t 会退化成空格，split('\t') 失配。
    const out = await this.run(['list-panes', '-a', '-F', '#{pane_id} #{session_name} #{pane_current_path}']);
    const m = new Map<string, { session: string; path: string }>();
    for (const line of out.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const i1 = s.indexOf(' ');
      if (i1 < 0) continue;
      const pane = s.slice(0, i1);
      const rest = s.slice(i1 + 1);
      const i2 = rest.indexOf(' ');
      const session = i2 < 0 ? rest : rest.slice(0, i2);
      const path = i2 < 0 ? '' : rest.slice(i2 + 1);
      m.set(pane, { session, path });
    }
    return m;
  }

  /** 探测 pane 是否还在。 */
  async hasPane(pane: PaneId): Promise<boolean> {
    try {
      await this.run(['display-message', '-p', '-t', pane, '#{pane_id}']);
      return true;
    } catch {
      return false;
    }
  }

  /** 以字面模式把一行文本发进 pane，然后单独发回车提交。 */
  async injectLine(pane: PaneId, text: string, enterDelayMs = 150): Promise<void> {
    // -l 字面模式 + -- 结束选项解析，避免把内容里的词当按键名或当成 flag。
    await this.run(['send-keys', '-t', pane, '-l', '--', text]);
    if (enterDelayMs > 0) await sleep(enterDelayMs);
    await this.run(['send-keys', '-t', pane, 'Enter']);
  }

  /** 向 pane 发送一个 tmux 按键名（如 Enter / Escape），非字面文本。用于菜单选择。 */
  async sendKey(pane: PaneId, key: string): Promise<void> {
    await this.run(['send-keys', '-t', pane, key]);
  }

  /** 切到该 pane 所在的窗口并选中它（用于"点击切回会话"）。两次独立调用，数组传参不走 shell。 */
  async selectPane(pane: PaneId): Promise<void> {
    await this.run(['select-window', '-t', pane]);
    await this.run(['select-pane', '-t', pane]);
  }

  /** 该 pane 所属的 tmux session 名。 */
  async sessionOfPane(pane: PaneId): Promise<string> {
    return (await this.run(['display-message', '-p', '-t', pane, '#{session_name}'])).trim();
  }

  /** 该 pane 的 session 名 + current_path（用于钉钉消息标注是哪个会话）。空格分隔、session 取首词、path 取剩余。 */
  async paneInfo(pane: PaneId): Promise<{ session: string; path: string }> {
    const out = (await this.run(['display-message', '-p', '-t', pane, '#{session_name} #{pane_current_path}'])).trim();
    const i = out.indexOf(' ');
    return i < 0 ? { session: out, path: '' } : { session: out.slice(0, i), path: out.slice(i + 1) };
  }

  /** 某 session 上所有已连接客户端的 tty（每个 = 一个终端窗口）。未连接则空数组。 */
  async clientTtysOfSession(session: string): Promise<string[]> {
    const out = await this.run(['list-clients', '-t', session, '-F', '#{client_tty}']);
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** 让某 session 的终端窗口标题显示其 session 名（供按标题 AXRaise 定位窗口）。仅作用于该 session。 */
  async setSessionTitle(session: string): Promise<void> {
    await this.run(['set-option', '-t', session, 'set-titles', 'on']);
    await this.run(['set-option', '-t', session, 'set-titles-string', '#{session_name}']);
  }

  /** 立刻把标题等刷给指定客户端（tty）。 */
  async refreshClient(tty: string): Promise<void> {
    await this.run(['refresh-client', '-t', tty]);
  }

  /** 抓取 pane 当前可见内容（调试用）。 */
  async capturePane(pane: PaneId): Promise<string> {
    return this.run(['capture-pane', '-p', '-t', pane]);
  }
}
