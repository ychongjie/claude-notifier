// 解析并校验 Claude 按 meta-prompt 吐出的选项 JSON。
import { z } from 'zod';
import type { OptionSet } from '../types.js';

const OptionSchema = z.object({
  key: z.string().regex(/^[1-5]$/),
  label: z.string().min(1).max(160),
  injectText: z.string().min(1),
});

const OptionSetJsonSchema = z.object({
  sentinel: z.string(),
  summary: z.string().max(600),
  options: z.array(OptionSchema).min(2).max(5),
});

/** 从一段文本里抽出 JSON 对象字符串：优先 ```json 围栏，其次第一个含 "sentinel" 的 {…}。 */
function extractJson(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence && fence[1]) return fence[1].trim();
  // 退而求其次：找包含 sentinel 字段的最外层花括号片段。
  const idx = text.indexOf('"sentinel"');
  if (idx >= 0) {
    const start = text.lastIndexOf('{', idx);
    const end = text.indexOf('}', idx);
    // 简单地从 start 向后做花括号配平。
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
    }
    void end;
  }
  return null;
}

/** key 去重后保证连续性不强制；这里仅去除重复 key（保留先出现者）。 */
function dedupeKeys(options: OptionSet['options']): OptionSet['options'] {
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)));
}

/**
 * 解析选项。成功且 sentinel 匹配返回 OptionSet，否则 null。
 * injectText 内的换行会被替换为空格（防止 tmux 注入时提前提交）。
 */
export function parseOptions(text: string | null, expectedSentinel: string): OptionSet | null {
  if (!text) return null;
  const jsonStr = extractJson(text);
  if (!jsonStr) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  const parsed = OptionSetJsonSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.sentinel !== expectedSentinel) return null;
  const options = dedupeKeys(
    parsed.data.options.map((o) => ({ ...o, injectText: o.injectText.replace(/\s*\n\s*/g, ' ').trim() })),
  );
  if (options.length < 2) return null;
  return { summary: parsed.data.summary, options };
}

/** 在多条 assistant 文本里(从新到旧)找出 sentinel 匹配且合法的选项。 */
export function findOptionsBySentinel(texts: string[], expectedSentinel: string): OptionSet | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const r = parseOptions(texts[i]!, expectedSentinel);
    if (r) return r;
  }
  return null;
}
