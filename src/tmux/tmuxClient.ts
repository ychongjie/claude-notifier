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

  /** 抓取 pane 当前可见内容（调试用）。 */
  async capturePane(pane: PaneId): Promise<string> {
    return this.run(['capture-pane', '-p', '-t', pane]);
  }
}
