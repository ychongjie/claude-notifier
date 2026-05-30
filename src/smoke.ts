// M0 手动冒烟：验证 dws 收发与 tmux 注入封装。
//
// 用法（在仓库根，先 cp config.example.json config.json）：
//   npm run smoke -- --send            # 给群发一条测试消息
//   npm run smoke -- --list            # 列出最近 5 分钟消息
//   npm run smoke -- --pane %3 --inject "echo hi"   # 往 pane 注入一行
//   npm run smoke                      # 默认 = --send + --list
import { loadConfig, expandHome } from './config.js';
import { Logger } from './logger.js';
import { DwsClient } from './dingtalk/dwsClient.js';
import { TmuxClient } from './tmux/tmuxClient.js';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger({ level: 'debug', filePath: expandHome(cfg.paths.logFile) });
  const dws = new DwsClient(cfg.dingtalk.dwsBin, log);
  const tmux = new TmuxClient(log);

  const doSend = hasFlag('--send') || (!hasFlag('--list') && !hasFlag('--inject'));
  const doList = hasFlag('--list') || (!hasFlag('--send') && !hasFlag('--inject'));
  const pane = getFlag('--pane');
  const inject = getFlag('--inject');

  if (doSend) {
    log.info('发送测试消息…');
    const res = await dws.send({
      group: cfg.dingtalk.openConversationId,
      title: `${cfg.dingtalk.pushTitlePrefix} 冒烟测试`,
      text: `**M0 冒烟**：dwsClient.send 正常\n时间 ${new Date().toLocaleString()}`,
    });
    log.info('发送成功', { open_taskId: res.open_taskId });
  }

  if (doList) {
    const sinceMs = Date.now() - 5 * 60 * 1000;
    const msgs = await dws.list({ group: cfg.dingtalk.openConversationId, sinceMs, limit: 10 });
    log.info(`读取到 ${msgs.length} 条消息（近 5 分钟）`);
    for (const m of msgs.slice(0, 5)) {
      const emojis = (m.emotionReplyList ?? []).map((e) => e.emoji).join(',');
      log.info('  msg', { time: m.createTime, content: m.content.slice(0, 40), emojis, id: m.openMessageId });
    }
  }

  if (pane) {
    const ok = await tmux.hasPane(pane);
    log.info(`tmux hasPane(${pane}) = ${ok}`);
    if (ok && inject) {
      await tmux.injectLine(pane, inject, cfg.tmux.sendKeysEnterDelayMs);
      log.info(`已注入到 ${pane}: ${inject}`);
    }
  }

  log.info('冒烟完成');
}

main().catch((err) => {
  process.stderr.write(`smoke 失败: ${err?.stack ?? err}\n`);
  process.exit(1);
});
