// 本机 macOS 通知：鉴权失效/需要 PAT 授权等"必须人工介入"时提醒。
// 这类时刻 dws 往往已发不出钉钉（鉴权死了），所以用本机通知兜底。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

let lastNotifyMs = 0;

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

/** 前台激活某 app（按 bundle id），不重开实例；其若全屏则 macOS 切到对应 Space。 */
export async function activateApp(bundleId: string): Promise<void> {
  await pExecFile('/usr/bin/open', ['-b', bundleId]);
}

/**
 * 把某 app（按 bundle id）下标题含 marker 的那个窗口 AXRaise 到该 app 的最前。
 * 用于多窗口终端（如 ghostty 单进程多窗口）按 tmux session 名精确定位窗口。
 * 只负责"排到最前",不负责切 Space——调用方随后用 activateApp(open -b) 跳到该窗口所在 Space
 * （全屏窗口各占一个 Space，AXRaise 不会切 Space，必须 activate）。
 * 需要 daemon 具备「辅助功能(Accessibility)」权限；没权限时 osascript 抛错，调用方退化为仅 activateApp。
 */
/**
 * 通过 Dock 图标的窗口菜单聚焦「标题含 marker」的那个窗口。
 * 关键:Dock 菜单列出该 app **跨所有 Space(含全屏)**的窗口（不像 `windows of process` 只看当前 Space），
 * 选中某窗口项会触发 macOS 原生「跳到该窗口」——需要切 Space(含全屏)就切。**纯公开 AX,无私有 API、不动 SIP。**
 * 需要 daemon 具备「辅助功能(Accessibility)」权限。返回诊断状态:ok / no-proc / no-dock-item / no-menu / no-window-item。
 */
export async function focusWindowViaDock(bundleId: string, marker: string): Promise<string> {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
tell application "System Events"
  set procs to (every process whose bundle identifier is "${esc(bundleId)}")
  if procs is {} then return "no-proc"
  set appName to name of item 1 of procs
  tell process "Dock"
    set di to missing value
    try
      set di to (first UI element of list 1 whose name is appName)
    end try
    if di is missing value then return "no-dock-item:" & appName
    perform action "AXShowMenu" of di
    -- 轮询等菜单就绪（固定 delay 会偶发 -1719「无效索引」)。最多约 1s。
    set m to missing value
    repeat 20 times
      try
        set m to menu 1 of di
      end try
      if m is not missing value then exit repeat
      delay 0.05
    end repeat
    if m is missing value then
      key code 53
      return "no-menu"
    end if
    set hits to (menu items of m whose name contains "${esc(marker)}")
    if hits is {} then
      key code 53
      return "no-window-item"
    end if
    click item 1 of hits
    return "ok"
  end tell
end tell`;
  const { stdout } = await pExecFile('/usr/bin/osascript', ['-e', script]);
  return stdout.trim();
}
