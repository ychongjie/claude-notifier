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
  // launchd 的 stdout/stderr 单独落到这里：daemon 自身已把 stderr 追加进 daemon.log，
  // 若 plist 也把 stderr 指向 daemon.log，每行会重复两遍。分开后 daemon.log 干净，
  // 这个文件只兜底捕获启动崩溃 / logger 之前的原始输出。
  const capturePath = resolve(logDir, 'daemon.out.log');
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
  <key>StandardOutPath</key><string>${xmlEscape(capturePath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(capturePath)}</string>
</dict>
</plist>
`;
  return { plist, logPath };
}

function launchctl(args: string[], opts: { ignoreError?: boolean } = {}): string {
  try {
    // stderr 用 pipe 捕获而非继承，避免 print 轮询时的 "Could not find service" 噪声。
    return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (opts.ignoreError) return '';
    throw err;
  }
}

/** 同步休眠（CLI 场景，等 launchd 卸载完成）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  // 幂等：若已加载先卸载，并等旧实例（含端口）完全释放，否则 bootstrap 会报 I/O error。
  launchctl(['bootout', `${target}/${LABEL}`], { ignoreError: true });
  for (let i = 0; i < 20; i++) {
    sleepSync(300);
    if (!launchctl(['print', `${target}/${LABEL}`], { ignoreError: true })) break; // 已卸载
  }
  // bootstrap 带重试（应对卸载尚未完全落定的瞬态 I/O error）。
  let lastErr: unknown;
  let ok = false;
  for (let i = 0; i < 5; i++) {
    try {
      launchctl(['bootstrap', target, pp]);
      ok = true;
      break;
    } catch (err) {
      lastErr = err;
      sleepSync(700);
    }
  }
  if (!ok) throw lastErr;
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
