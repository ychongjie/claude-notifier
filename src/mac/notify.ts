// 本机 macOS 通知：鉴权失效/需要 PAT 授权等"必须人工介入"时提醒。
// 这类时刻 dws 往往已发不出钉钉（鉴权死了），所以用本机通知兜底。
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

let lastNotifyMs = 0;

/** 解析可执行名到绝对路径（含缓存）。绝对路径直接判存在；否则用 which。找不到返回 null。 */
const binCache = new Map<string, string | null>();
function resolveBin(name: string): string | null {
  if (name.startsWith('/')) return existsSync(name) ? name : null;
  if (binCache.has(name)) return binCache.get(name)!;
  let resolved: string | null = null;
  try {
    resolved = execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim() || null;
  } catch {
    resolved = null;
  }
  binCache.set(name, resolved);
  return resolved;
}

/** 用 osascript 弹一条通知。execFile 数组传参，内容做 AppleScript 字符串转义，避免注入。 */
export function macNotify(title: string, message: string): void {
  const script = `display notification ${asStr(message)} with title ${asStr(title)}`;
  execFile('/usr/bin/osascript', ['-e', script], () => {
    /* 通知失败不致命，静默 */
  });
}

/** 限频通知：minGapMs 内最多弹一条，避免反复告警刷屏。 */
export function macNotifyThrottled(title: string, message: string, minGapMs = 600000): void {
  const now = Date.now();
  if (now - lastNotifyMs < minGapMs) return;
  lastNotifyMs = now;
  macNotify(title, message);
}

/** 转成 AppleScript 字符串字面量（转义反斜杠与双引号）。 */
function asStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * 弹一条可点击通知：点击时由 terminal-notifier 经 /bin/sh -c 执行 execute 命令。
 * 没装 terminal-notifier（或没给 execute）则退化为不可点击的 osascript 通知。
 * 返回是否走了可点击通道（true=可点击）。
 */
export function macNotifyClickable(opts: {
  title: string;
  message: string;
  subtitle?: string;
  /** 同 group 的通知互相替换，避免同一会话反复堆叠。 */
  group?: string;
  /** 点击时执行的 shell 命令（如切 tmux pane + 激活终端）。 */
  execute?: string;
  /** terminal-notifier 可执行名/路径，默认 'terminal-notifier'。 */
  notifierBin?: string;
}): boolean {
  const bin = resolveBin(opts.notifierBin ?? 'terminal-notifier');
  if (bin && opts.execute) {
    const args = ['-title', opts.title, '-message', opts.message];
    if (opts.subtitle) args.push('-subtitle', opts.subtitle);
    if (opts.group) args.push('-group', opts.group);
    args.push('-execute', opts.execute);
    execFile(bin, args, () => {
      /* 通知失败不致命，静默 */
    });
    return true;
  }
  // 退化：osascript 通知不可点击，把会话信息塞进正文，至少能看到是哪一个。
  macNotify(opts.title, opts.subtitle ? `${opts.subtitle} — ${opts.message}` : opts.message);
  return false;
}

/**
 * 构造"点击 → 切到该 tmux pane 所在窗口并激活终端 app"的 shell 命令。
 * - 两次独立 tmux 调用：不用 `\;`（会被 /bin/sh 当成命令分隔符，把 select-pane 当成独立命令）。
 * - open -b 激活已运行的终端 app（不会重开实例）；其若是全屏则 macOS 切到对应 Space。
 * tmux 解析不到绝对路径时返回 null（无法可靠遥控，调用方退化为不可点击通知）。
 */
export function buildSwitchCommand(pane: string, bundleId: string): string | null {
  const tmux = resolveBin('tmux');
  if (!tmux) return null;
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `${tmux} select-window -t ${q(pane)}; ${tmux} select-pane -t ${q(pane)}; /usr/bin/open -b ${q(bundleId)}`;
}
