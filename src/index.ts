// CLI 入口。子命令：start | install-hooks | status。
// M0 仅搭好骨架，具体实现随 M1+ 填充。
import { loadConfig } from './config.js';

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
    case 'start':
      // 校验配置可加载，真正的 daemon 在 M1 接入。
      loadConfig();
      process.stderr.write('start: daemon 尚未实现（M1）\n');
      process.exit(1);
      break;
    case 'install-hooks':
      process.stderr.write('install-hooks: 尚未实现（M1）\n');
      process.exit(1);
      break;
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
