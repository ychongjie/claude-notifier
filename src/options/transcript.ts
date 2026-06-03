// 解析 Claude Code 的 transcript JSONL：统计 assistant 轮数、取最后一条 assistant 文本。
// 实测结构：assistant 行 .type=="assistant"，文本在 .message.content[]|select(.type=="text").text。
import { readFileSync } from 'node:fs';

export interface TranscriptInfo {
  /** assistant 轮数（type=="assistant" 的行数），用作防死循环水位。 */
  assistantTurns: number;
  /** 最后一条 assistant 的纯文本（拼接所有 text 块），无则 null。 */
  lastAssistantText: string | null;
  /** 所有非空 assistant 文本（按出现顺序），用于按 sentinel 搜索。 */
  assistantTexts: string[];
}

interface ContentBlock {
  type?: string;
  text?: string;
  // tool_use 块
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result 块
  tool_use_id?: string;
}

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
  };
}

export interface PendingToolUse {
  /** 工具名，如 Bash / Edit / Write。 */
  name: string;
  /** 工具入参（command / file_path / url 等）。 */
  input: Record<string, unknown>;
}

function extractText(line: TranscriptLine): string | null {
  const content = line.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string);
    if (parts.length) return parts.join('\n');
  }
  return null;
}

/** 读取 transcript 文件并解析。读不到/解析失败时返回安全默认值。 */
export function readTranscript(path: string): TranscriptInfo {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { assistantTurns: 0, lastAssistantText: null, assistantTexts: [] };
  }
  let assistantTurns = 0;
  const assistantTexts: string[] = [];
  for (const rawLine of raw.split('\n')) {
    const s = rawLine.trim();
    if (!s) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(s) as TranscriptLine;
    } catch {
      continue;
    }
    if (line.type === 'assistant' && line.message?.role === 'assistant') {
      assistantTurns++;
      const text = extractText(line);
      if (text != null && text.length > 0) assistantTexts.push(text);
    }
  }
  return {
    assistantTurns,
    lastAssistantText: assistantTexts.length ? assistantTexts[assistantTexts.length - 1]! : null,
    assistantTexts,
  };
}

/**
 * 找出最后一个「尚无 tool_result」的 tool_use——即正在等待授权的那次工具调用。
 * 用于权限弹窗展示「具体执行什么命令」。读不到/无 pending 时返回 null。
 * 注意：子代理(Agent 工具)内部的工具调用不写在主 transcript,此时只能拿到 Agent 本身。
 */
export function readPendingToolUse(path: string): PendingToolUse | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const resolvedIds = new Set<string>();
  for (const rawLine of raw.split('\n')) {
    const s = rawLine.trim();
    if (!s) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(s) as TranscriptLine;
    } catch {
      continue;
    }
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'tool_use' && typeof c.id === 'string' && typeof c.name === 'string') {
        toolUses.push({ id: c.id, name: c.name, input: (c.input ?? {}) as Record<string, unknown> });
      } else if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') {
        resolvedIds.add(c.tool_use_id);
      }
    }
  }
  for (let i = toolUses.length - 1; i >= 0; i--) {
    const tu = toolUses[i]!;
    if (!resolvedIds.has(tu.id)) return { name: tu.name, input: tu.input };
  }
  return null;
}

/** 把 pending tool_use 渲染成单行人类可读描述,如 `Bash: git push origin main`。 */
export function describeToolUse(tu: PendingToolUse, maxLen = 160): string {
  const inp = tu.input ?? {};
  const pick = (k: string): string | null => {
    const v = inp[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  // 按工具类型挑最有信息量的字段。
  const detail =
    pick('command') ?? // Bash
    pick('file_path') ?? // Read/Write/Edit
    pick('path') ??
    pick('url') ?? // WebFetch
    pick('pattern') ?? // Grep
    pick('query') ?? // WebSearch
    pick('description') ??
    null;
  let line = detail ? `${tu.name}: ${detail}` : tu.name;
  // 折叠换行(钉钉正文 + tmux 安全),并截断。
  line = line.replace(/\s*\n\s*/g, ' ⏎ ').trim();
  if (line.length > maxLen) line = line.slice(0, maxLen - 1) + '…';
  return line;
}
