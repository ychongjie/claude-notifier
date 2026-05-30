// 把 claude-notifier 的 hook 注册进 ~/.claude/settings.json。
// 幂等：重复执行只会刷新自己注册的条目，保留用户其它 hook。
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
/** 仓库内的 hook 脚本路径（src/hooks/ → ../../bin/claude-notifier-hook）。 */
export const HOOK_SCRIPT_SRC = resolve(SELF_DIR, '../../bin/claude-notifier-hook');

/** 我们注册的事件与 matcher。Notification 用 idle_prompt/permission_prompt，Stop 兜底。 */
const REGISTRATIONS: Array<{ event: string; matcher: string }> = [
  { event: 'Notification', matcher: 'idle_prompt' },
  { event: 'Notification', matcher: 'permission_prompt' },
  { event: 'Stop', matcher: '' },
];

/** 用这个标记识别「是我们装的」hook 条目，便于幂等替换。 */
const TAG = 'claude-notifier-hook';

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command?: string; url?: string }>;
}

export interface InstallOptions {
  /** settings.json 路径，默认 ~/.claude/settings.json。 */
  settingsPath?: string;
  /** daemon 端口，写进 CN_PORT 环境前缀。 */
  port: number;
  /** hook 脚本安装到的位置，默认 ~/.claude-notifier/claude-notifier-hook。 */
  hookScriptDest?: string;
  /** 仅返回将要写入的内容，不落盘。 */
  dryRun?: boolean;
}

export interface InstallResult {
  settingsPath: string;
  hookScriptDest: string;
  settings: unknown;
}

function buildCommand(port: number, hookScriptDest: string): string {
  // 用 sh 执行，免去给脚本加可执行位；CN_PORT 通过环境前缀传入。
  return `CN_PORT=${port} sh ${hookScriptDest}`;
}

/** 移除某事件下我们之前装的条目（按 command 含 TAG 判定）。 */
function stripOurs(entries: HookEntry[]): HookEntry[] {
  return entries
    .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !(h.command ?? '').includes(TAG)) }))
    .filter((e) => e.hooks.length > 0);
}

export function installHooks(opts: InstallOptions): InstallResult {
  const settingsPath = opts.settingsPath ?? resolve(homedir(), '.claude/settings.json');
  const hookScriptDest = opts.hookScriptDest ?? resolve(homedir(), '.claude-notifier/claude-notifier-hook');
  const command = buildCommand(opts.port, hookScriptDest);

  // 读现有 settings.json（不存在则空对象）。
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`现有 settings.json 不是合法 JSON，已中止以免覆盖：${(err as Error).message}`);
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  // 按事件分组：每个事件先剥掉上次装的（含 TAG 的），再一次性追加该事件的所有 matcher，
  // 避免循环内 stripOurs 把本轮刚加的条目又删掉。
  const matchersByEvent = new Map<string, string[]>();
  for (const { event, matcher } of REGISTRATIONS) {
    matchersByEvent.set(event, [...(matchersByEvent.get(event) ?? []), matcher]);
  }
  for (const [event, matchers] of matchersByEvent) {
    const entries = stripOurs(hooks[event] ?? []);
    for (const matcher of matchers) {
      entries.push({ matcher, hooks: [{ type: 'command', command }] });
    }
    hooks[event] = entries;
  }
  settings.hooks = hooks;

  if (!opts.dryRun) {
    // 安装 hook 脚本。
    mkdirSync(dirname(hookScriptDest), { recursive: true });
    copyFileSync(HOOK_SCRIPT_SRC, hookScriptDest);
    // 备份后写 settings.json。
    mkdirSync(dirname(settingsPath), { recursive: true });
    if (existsSync(settingsPath)) {
      copyFileSync(settingsPath, settingsPath + '.cn-backup');
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  return { settingsPath, hookScriptDest, settings };
}
