// 解析 Claude Code 的 transcript JSONL：统计 assistant 轮数、取最后一条 assistant 文本。
// 实测结构：assistant 行 .type=="assistant"，文本在 .message.content[]|select(.type=="text").text。
import { readFileSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';

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

export interface TranscriptUsage {
  /** 新增的输入 token（含缓存：input+cacheCreate+cacheRead）。 */
  tokensInDelta: number;
  /** 新增的输出 token（output）。 */
  tokensOutDelta: number;
  /** 已完整解析到的新字节偏移（下次从这里继续）。 */
  offset: number;
  /** 文件被重写/压缩（size < fromOffset）→ 调用方应把累计 token 归零再加 delta。 */
  reset: boolean;
  /** 仅 fromOffset==0 时返回：首条带 timestamp 的行的 ms（会话起始时刻）。 */
  firstTs?: number;
  /** 本次新字节里出现的最后一个 Claude Code 自动标题（type=="ai-title".aiTitle），无则 undefined。 */
  aiTitle?: string;
  /** 本次新字节里出现的最后一条用户 prompt（type=="last-prompt".lastPrompt），无则 undefined。 */
  lastPrompt?: string;
  /** 仅 fromOffset==0 时返回：首条真实用户 prompt（滤掉 slash 命令展开 / caveat / meta），无则 undefined。 */
  firstPrompt?: string;
}

/**
 * 增量统计 transcript 的 token 用量 + 会话起始时刻。只读 fromOffset 之后的新字节，
 * 按完整行解析（半行留到下次），累计 assistant 行的 usage 四项之和。供桌面控件展示"总 token / 总时长"。
 */
export function readTranscriptUsage(path: string, fromOffset: number): TranscriptUsage {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { tokensInDelta: 0, tokensOutDelta: 0, offset: fromOffset, reset: false };
  }
  try {
    const size = fstatSync(fd).size;
    let start = fromOffset;
    let reset = false;
    if (size < fromOffset) {
      start = 0; // 文件被重写（如 /compact）→ 从头重算
      reset = true;
    }
    if (size <= start) return { tokensInDelta: 0, tokensOutDelta: 0, offset: start, reset };
    const buf = Buffer.allocUnsafe(size - start);
    readSync(fd, buf, 0, size - start, start);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return { tokensInDelta: 0, tokensOutDelta: 0, offset: start, reset }; // 还没有完整新行
    const complete = text.slice(0, lastNl);
    const newOffset = start + Buffer.byteLength(complete, 'utf8') + 1; // +1=换行符
    let tokensInDelta = 0;
    let tokensOutDelta = 0;
    let firstTs: number | undefined;
    let aiTitle: string | undefined;
    let lastPrompt: string | undefined;
    let firstPrompt: string | undefined;
    const wantFirst = start === 0;
    for (const rawLine of complete.split('\n')) {
      const s = rawLine.trim();
      if (!s) continue;
      let line: {
        type?: string;
        timestamp?: string;
        isMeta?: boolean;
        isSidechain?: boolean;
        aiTitle?: string;
        lastPrompt?: string;
        message?: { role?: string; usage?: Record<string, number>; content?: ContentBlock[] | string };
      };
      try {
        line = JSON.parse(s);
      } catch {
        continue;
      }
      if (wantFirst && firstTs === undefined && typeof line.timestamp === 'string') {
        const t = Date.parse(line.timestamp);
        if (!Number.isNaN(t)) firstTs = t;
      }
      // Claude Code 周期性追加的会话标题 / 最近 prompt：取本次新字节里最后出现的。
      if (line.type === 'ai-title' && typeof line.aiTitle === 'string' && line.aiTitle.trim()) {
        aiTitle = line.aiTitle.trim();
      }
      if (line.type === 'last-prompt' && typeof line.lastPrompt === 'string' && line.lastPrompt.trim()) {
        lastPrompt = line.lastPrompt.trim();
      }
      // 首条真实用户 prompt：仅从头解析时取一次。滤掉 slash 命令展开 / caveat / stdout（以 `<` 开头）、meta、子代理。
      if (wantFirst && firstPrompt === undefined && line.type === 'user' && !line.isMeta && !line.isSidechain) {
        const text = extractText(line as TranscriptLine);
        if (text != null && text.trim() && !text.trimStart().startsWith('<')) {
          firstPrompt = text.trim();
        }
      }
      const u = line.message?.usage;
      if (line.type === 'assistant' && u) {
        tokensInDelta += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        tokensOutDelta += u.output_tokens || 0;
      }
    }
    return { tokensInDelta, tokensOutDelta, offset: newOffset, reset, firstTs, aiTitle, lastPrompt, firstPrompt };
  } finally {
    closeSync(fd);
  }
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
