// 配置加载与校验。路径里的 ~ 展开为 HOME。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

export const ConfigSchema = z.object({
  dingtalk: z.object({
    openConversationId: z.string().min(1),
    userId: z.string().min(1),
    userDisplayName: z.string().min(1),
    dwsBin: z.string().min(1).default('dws'),
    pushTitlePrefix: z.string().default('[CN]'),
  }),
  poll: z.object({
    intervalMs: z.number().int().positive().default(2000),
    overlapSlackMs: z.number().int().nonnegative().default(5000),
    listLimit: z.number().int().positive().default(20),
    processedIdsMax: z.number().int().positive().default(500),
  }),
  hookServer: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(8787),
  }),
  tmux: z.object({
    sendKeysEnterDelayMs: z.number().int().nonnegative().default(150),
    paneOverride: z.record(z.string()).nullable().default(null),
  }),
  emojis: z.object({
    // 你手动定义的文字表情名，直接等于选项 key（最多 5 个）。
    candidates: z.array(z.string().min(1)).min(1).max(5).default(['1', '2', '3', '4', '5']),
  }),
  options: z.object({
    minCount: z.number().int().min(1).default(2),
    maxCount: z.number().int().min(1).max(5).default(5),
    retryOnInvalid: z.number().int().nonnegative().default(1),
  }),
  timeouts: z.object({
    generationMs: z.number().int().positive().default(60000),
    userWaitMs: z.number().int().positive().default(1800000),
    cooldownMs: z.number().int().nonnegative().default(1500),
  }),
  paths: z.object({
    logFile: z.string().default('~/.claude-notifier/daemon.log'),
    stateFile: z.string().default('~/.claude-notifier/state.json'),
  }),
  metaPrompt: z.object({
    sentinelPrefix: z.string().default('CN_OPTIONS_'),
  }),
  notify: z
    .object({
      // 仅在 Mac 锁屏时推送，避免你在电脑前工作时被打扰。
      onlyWhenLocked: z.boolean().default(true),
    })
    .default({}),
  permission: z
    .object({
      // 处理工具授权弹窗：推送"允许/拒绝"到手机，点选后注入对应按键。
      enabled: z.boolean().default(true),
      // tmux 按键名：允许=确认高亮默认项(Yes)，拒绝=取消(No)。如真实菜单不同可改。
      allowKey: z.string().default('Enter'),
      denyKey: z.string().default('Escape'),
    })
    .default({}),
  safety: z
    .object({
      // 熔断器：单会话在 windowMs 内最多注入这么多次 meta-prompt，超出则降级为固定选项（不再生成，防 token 失控）。
      maxGenerationsPerWindow: z.number().int().positive().default(8),
      windowMs: z.number().int().positive().default(300000),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/** 把开头的 ~ 展开为用户 HOME。 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/** 从给定路径加载并校验配置（默认 $CN_CONFIG 或 ./config.json）。 */
export function loadConfig(path?: string): Config {
  const file = path ?? process.env.CN_CONFIG ?? resolve(process.cwd(), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`无法读取配置文件 ${file}：${(err as Error).message}（可复制 config.example.json）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置文件 ${file} 不是合法 JSON：${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`配置校验失败：${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return result.data;
}
