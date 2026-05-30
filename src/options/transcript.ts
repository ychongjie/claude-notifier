// 解析 Claude Code 的 transcript JSONL：统计 assistant 轮数、取最后一条 assistant 文本。
// 实测结构：assistant 行 .type=="assistant"，文本在 .message.content[]|select(.type=="text").text。
import { readFileSync } from 'node:fs';

export interface TranscriptInfo {
  /** assistant 轮数（type=="assistant" 的行数），用作防死循环水位。 */
  assistantTurns: number;
  /** 最后一条 assistant 的纯文本（拼接所有 text 块），无则 null。 */
  lastAssistantText: string | null;
}

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };
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
    return { assistantTurns: 0, lastAssistantText: null };
  }
  let assistantTurns = 0;
  let lastAssistantText: string | null = null;
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
      if (text != null) lastAssistantText = text;
    }
  }
  return { assistantTurns, lastAssistantText };
}
