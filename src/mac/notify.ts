// 本机 macOS 通知：鉴权失效/需要 PAT 授权等"必须人工介入"时提醒。
// 这类时刻 dws 往往已发不出钉钉（鉴权死了），所以用本机通知兜底。
import { execFile } from 'node:child_process';

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
