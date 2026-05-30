// launchd 常驻：生成 LaunchAgent plist，开机自启 + 崩溃自动重启。
// 关键：launchd 的 PATH 极简，daemon 要调 dws/tmux/ioreg；把真实 node 所在目录
// （同目录下也有 dws）、homebrew、/usr/sbin 等显式写进 plist 的 PATH。
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SELF_DIR, '../..'); // src/service → repo root
export const LABEL = 'com.claude-notifier.daemon';

function plistPath(): string {
  return resolve(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 构造 plist 内容。 */
function buildPlist(): { plist: string; logPath: string } {
  const node = process.execPath; // 真实 node 绝对路径
  const nodeBinDir = dirname(node); // 同目录含 dws（asdf 下的全局包）
  const tsxCli = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
  const indexTs = resolve(REPO_ROOT, 'src/index.ts');
  const configPath = process.env.CN_CONFIG ?? resolve(REPO_ROOT, 'config.json');
  const logDir = resolve(homedir(), '.claude-notifier');
  const logPath = resolve(logDir, 'daemon.log');
  mkdirSync(logDir, { recursive: true });

  // PATH：node/dws 同目录 + homebrew(tmux,asdf) + /usr/sbin(ioreg) + 标准目录。
  const PATH = [nodeBinDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/bin'].join(':');

  const args = [node, tsxCli, indexTs, 'start'];
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(PATH)}</string>
    <key>CN_CONFIG</key><string>${xmlEscape(configPath)}</string>
    <key>CN_LOG_LEVEL</key><string>${xmlEscape(process.env.CN_LOG_LEVEL ?? 'info')}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
  return { plist, logPath };
}

function launchctl(args: string[], opts: { ignoreError?: boolean } = {}): string {
  try {
    return execFileSync('/bin/launchctl', args, { encoding: 'utf8' });
  } catch (err) {
    if (opts.ignoreError) return '';
    throw err;
  }
}

export interface ServiceResult {
  plistPath: string;
  logPath: string;
}

/** 安装并加载服务（幂等：先卸载再重新加载）。 */
export function installService(): ServiceResult {
  const uid = process.getuid?.() ?? 0;
  const target = `gui/${uid}`;
  const pp = plistPath();
  const { plist, logPath } = buildPlist();
  mkdirSync(dirname(pp), { recursive: true });
  writeFileSync(pp, plist);
  // 幂等：若已加载先卸载。
  launchctl(['bootout', `${target}/${LABEL}`], { ignoreError: true });
  launchctl(['bootstrap', target, pp]);
  // 强制（重）启动一次。
  launchctl(['kickstart', '-k', `${target}/${LABEL}`], { ignoreError: true });
  return { plistPath: pp, logPath };
}

/** 卸载并删除 plist。 */
export function uninstallService(): { plistPath: string } {
  const uid = process.getuid?.() ?? 0;
  const pp = plistPath();
  launchctl(['bootout', `gui/${uid}/${LABEL}`], { ignoreError: true });
  if (existsSync(pp)) rmSync(pp);
  return { plistPath: pp };
}

/** 查询服务状态。 */
export function serviceStatus(): { loaded: boolean; detail: string } {
  const uid = process.getuid?.() ?? 0;
  const out = launchctl(['print', `gui/${uid}/${LABEL}`], { ignoreError: true });
  if (!out) return { loaded: false, detail: '未加载' };
  const stateLine = /state = (\w+)/.exec(out)?.[0] ?? '';
  const pidLine = /pid = (\d+)/.exec(out)?.[0] ?? '';
  return { loaded: true, detail: [stateLine, pidLine].filter(Boolean).join(', ') || '已加载' };
}
