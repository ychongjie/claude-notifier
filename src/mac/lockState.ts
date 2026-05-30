// macOS 屏幕锁定检测（零依赖）：读取 ioreg 的 IOConsoleLocked。
// 锁屏 → <true/>，未锁 → <false/>。读不到则返回 null（调用方按"宁可推"处理）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

/** true=已锁屏，false=未锁，null=无法判定。 */
export async function isScreenLocked(): Promise<boolean | null> {
  try {
    const { stdout } = await pExecFile('ioreg', ['-n', 'Root', '-d1', '-a'], { maxBuffer: 8 * 1024 * 1024 });
    // key 与 value 分行，\s* 跨换行匹配。
    const m = /<key>IOConsoleLocked<\/key>\s*<(true|false)\/>/.exec(stdout);
    if (!m) return null;
    return m[1] === 'true';
  } catch {
    return null;
  }
}
