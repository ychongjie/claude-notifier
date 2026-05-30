// CLI 入口。子命令：start | install-hooks | status。
import { loadConfig, expandHome } from './config.js';
import { Logger } from './logger.js';
import { Daemon } from './daemon.js';
import { installHooks } from './hooks/installHooks.js';

const HELP = `claude-notifier — 钉钉远程驱动本地 Claude Code

用法:
  claude-notifier start           启动常驻 bridge 守护进程
  claude-notifier install-hooks   把 hook 写入 ~/.claude/settings.json
  claude-notifier status          查看运行状态

环境变量:
  CN_CONFIG   配置文件路径（默认 ./config.json）
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'start': {
      const cfg = loadConfig();
      const log = new Logger({ level: process.env.CN_LOG_LEVEL as never, filePath: expandHome(cfg.paths.logFile) });
      await new Daemon(cfg, log).start();
      break; // daemon 常驻，靠信号退出
    }
    case 'install-hooks': {
      const cfg = loadConfig();
      const dry = process.argv.includes('--dry-run');
      const settingsPath = process.argv.includes('--settings')
        ? process.argv[process.argv.indexOf('--settings') + 1]
        : undefined;
      const res = installHooks({ port: cfg.hookServer.port, dryRun: dry, settingsPath });
      if (dry) {
        process.stdout.write(`[dry-run] 将写入 ${res.settingsPath}\nhook 脚本 → ${res.hookScriptDest}\n\n`);
        process.stdout.write(JSON.stringify(res.settings, null, 2) + '\n');
      } else {
        process.stdout.write(`已写入 ${res.settingsPath}（原文件备份为 .cn-backup）\nhook 脚本 → ${res.hookScriptDest}\n`);
      }
      break;
    }
    case 'status':
      process.stderr.write('status: 尚未实现（M4）\n');
      process.exit(1);
      break;
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`未知命令: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
