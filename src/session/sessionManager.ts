// 会话管理 + 状态机（M2）：锁屏门控推送固定选项 → 轮询识别表情/数字 → tmux 注入。
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { DwsClient } from '../dingtalk/dwsClient.js';
import type { TmuxClient } from '../tmux/tmuxClient.js';
import { pushOptions } from '../dingtalk/push.js';
import { isScreenLocked } from '../mac/lockState.js';
import { readTranscript } from '../options/transcript.js';
import { buildMetaPrompt, makeSentinel } from '../options/metaPrompt.js';
import { findOptionsBySentinel } from '../options/optionsSchema.js';
import type { IncomingHook } from '../hooks/hookTypes.js';
import type { InboundTracker } from '../dingtalk/inboundDedup.js';
import type { PollContext } from '../dingtalk/poller.js';
import type { InboundEvent, SessionRecord } from './types.js';
import type { OptionSet } from '../types.js';

/** 兜底选项：meta-prompt 生成失败/超时/无 pane 时用。 */
const FALLBACK_OPTIONS: OptionSet = {
  summary: 'Claude 停下，等待你的输入',
  options: [
    { key: '1', label: '继续', injectText: '继续' },
    { key: '2', label: '停止', injectText: '先停一下，等我进一步指示' },
  ],
};

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  /** pushedMessageId → sessionId，便于把表情事件路由到对应会话。 */
  private readonly pushedToSession = new Map<string, string>();
  /** 各推送消息的 createTime（ms），供 poller 计算回看窗口。 */
  private readonly pushedCreateMs = new Map<string, number>();
  private tracker?: InboundTracker;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly dws: DwsClient,
    private readonly tmux: TmuxClient,
  ) {}

  attachTracker(t: InboundTracker): void {
    this.tracker = t;
  }

  private get(sessionId: string): SessionRecord {
    let r = this.sessions.get(sessionId);
    if (!r) {
      r = { sessionId, state: 'IDLE' };
      this.sessions.set(sessionId, r);
    }
    return r;
  }

  /** 供 poller 使用：当前活跃推送消息集合 + 最早时间。 */
  getContext(): PollContext {
    const ids = new Set(this.pushedToSession.keys());
    let earliest: number | undefined;
    for (const id of ids) {
      const t = this.pushedCreateMs.get(id);
      if (t !== undefined) earliest = earliest === undefined ? t : Math.min(earliest, t);
    }
    return { activePushedIds: ids, earliestActiveMs: earliest };
  }

  /** 处理一次 idle/permission hook。 */
  async onIdleHook(h: IncomingHook): Promise<void> {
    const rec = this.get(h.sessionId);
    if (h.pane) rec.pane = h.pane;

    const sid = h.sessionId.slice(0, 8);

    // 正在生成选项：Stop 到达即尝试解析（内部按 sentinel 搜索 + 重读容忍刷盘延迟）。
    if (rec.state === 'GENERATING_OPTIONS') {
      await this.handleGenerationResult(rec, h.transcriptPath);
      return;
    }

    const info = readTranscript(h.transcriptPath);

    if (rec.state === 'WAITING_USER') {
      // 已在等待。若 transcript 轮数已超过推送时（用户可能直接在终端操作了）→ 旧选项作废，重开。
      if (rec.pushedAtTurns !== undefined && info.assistantTurns > rec.pushedAtTurns) {
        this.log.info('等待期间检测到新进展，作废旧选项重开', { session: sid });
        this.clearWait(rec);
      } else {
        this.log.debug('已在等待用户，忽略重复 hook', { session: sid });
        return;
      }
    }
    if (rec.state === 'INJECTING') {
      // 注入后 Claude 完成本轮的"自然停" → 这是下一次等待，转 IDLE 继续处理。
      rec.state = 'IDLE';
    }

    // 仅锁屏时推送/生成。
    if (this.cfg.notify.onlyWhenLocked) {
      const locked = await isScreenLocked();
      if (locked === false) {
        this.log.debug('屏幕未锁，跳过', { session: sid });
        return;
      }
    }

    await this.startOptionGeneration(rec, info.assistantTurns);
  }

  /** 注入 meta-prompt，让 Claude 自吐结构化选项。无 pane 时退化为固定选项。 */
  private async startOptionGeneration(rec: SessionRecord, turns: number): Promise<void> {
    const sid = rec.sessionId.slice(0, 8);
    if (!rec.pane || !(await this.tmux.hasPane(rec.pane))) {
      this.log.warn('无可用 pane，退化为直接推送固定选项', { session: sid });
      await this.pushAndWait(rec, FALLBACK_OPTIONS, turns);
      return;
    }
    const sentinel = makeSentinel(this.cfg.metaPrompt.sentinelPrefix);
    rec.state = 'GENERATING_OPTIONS';
    rec.genTurns = turns;
    rec.sentinel = sentinel;
    rec.retriesLeft = this.cfg.options.retryOnInvalid;
    this.scheduleGenTimeout(rec);
    try {
      await this.tmux.injectLine(rec.pane, buildMetaPrompt(sentinel, this.cfg.options.maxCount), this.cfg.tmux.sendKeysEnterDelayMs);
      this.log.info('已注入 meta-prompt，等待选项产出', { session: sid, sentinel });
    } catch (err) {
      this.log.error('注入 meta-prompt 失败，退化为固定选项', { err: String(err) });
      this.clearGen(rec);
      await this.pushAndWait(rec, FALLBACK_OPTIONS, turns);
    }
  }

  /** Claude 产出后：按 sentinel 搜索合法选项（重读容忍刷盘延迟）→推送；找不到→重试一次→固定选项。 */
  private async handleGenerationResult(rec: SessionRecord, transcriptPath: string): Promise<void> {
    const sid = rec.sessionId.slice(0, 8);
    const sentinel = rec.sentinel ?? '';
    // transcript 写入相对 Stop hook 有刷盘延迟,重读最多 ~2s 直到按 sentinel 找到合法选项。
    let parsed = null;
    let turns = rec.genTurns ?? 0;
    for (let i = 0; i < 5; i++) {
      const info = readTranscript(transcriptPath);
      turns = info.assistantTurns;
      parsed = findOptionsBySentinel(info.assistantTexts, sentinel);
      if (parsed) break;
      await delay(400);
    }
    this.clearGenTimer(rec);
    if (parsed) {
      this.log.info('选项已生成', { session: sid, options: parsed.options.map((o) => o.key).join(',') });
      await this.pushAndWait(rec, parsed, turns);
      return;
    }
    if ((rec.retriesLeft ?? 0) > 0 && rec.pane) {
      rec.retriesLeft = (rec.retriesLeft ?? 0) - 1;
      rec.genTurns = turns;
      this.scheduleGenTimeout(rec);
      this.log.warn('未找到合法选项,重试一次', { session: sid });
      try {
        await this.tmux.injectLine(rec.pane, buildMetaPrompt(sentinel, this.cfg.options.maxCount), this.cfg.tmux.sendKeysEnterDelayMs);
        return;
      } catch (err) {
        this.log.error('重试注入失败', { err: String(err) });
      }
    }
    this.log.warn('选项生成失败，使用固定选项', { session: sid });
    await this.pushAndWait(rec, FALLBACK_OPTIONS, turns);
  }

  private scheduleGenTimeout(rec: SessionRecord): void {
    this.clearGenTimer(rec);
    rec.genTimer = setTimeout(() => void this.onGenTimeout(rec), this.cfg.timeouts.generationMs);
  }
  private clearGenTimer(rec: SessionRecord): void {
    if (rec.genTimer) clearTimeout(rec.genTimer);
    rec.genTimer = undefined;
  }
  private clearGen(rec: SessionRecord): void {
    this.clearGenTimer(rec);
    rec.sentinel = undefined;
    rec.genTurns = undefined;
    rec.retriesLeft = undefined;
  }
  private async onGenTimeout(rec: SessionRecord): Promise<void> {
    if (rec.state !== 'GENERATING_OPTIONS') return;
    this.log.warn('选项生成超时，使用固定选项', { session: rec.sessionId.slice(0, 8) });
    await this.pushAndWait(rec, FALLBACK_OPTIONS, rec.genTurns ?? 0);
  }

  private async pushAndWait(rec: SessionRecord, optionSet: OptionSet, turns: number): Promise<void> {
    this.clearGen(rec); // 离开 GENERATING_OPTIONS
    const marker = `CN-${rec.sessionId.slice(0, 8)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    try {
      await pushOptions(this.dws, this.cfg, { sessionId: rec.sessionId, optionSet, marker });
    } catch (err) {
      this.log.error('推送选项失败', { err: String(err) });
      return;
    }
    // 轮询 list 找到刚推送的那条消息（按 marker），拿 openMessageId 并设表情基线。
    const found = await this.findPushedMessage(marker);
    if (!found) {
      this.log.warn('未能定位推送消息，无法接收表情（仍可回数字）', { marker });
    } else {
      rec.pushedMessageId = found.openMessageId;
      this.pushedToSession.set(found.openMessageId, rec.sessionId);
      this.pushedCreateMs.set(found.openMessageId, Date.now());
      this.tracker?.baselineEmojis(found);
    }
    rec.state = 'WAITING_USER';
    rec.optionSet = optionSet;
    rec.pushedAtTurns = turns;
    this.log.info('已推送选项，等待用户选择', {
      session: rec.sessionId.slice(0, 8),
      pushedMessageId: rec.pushedMessageId,
      options: optionSet.options.map((o) => o.key).join(','),
    });
  }

  /** 轮询若干次,在群里找到含 marker 的消息。 */
  private async findPushedMessage(marker: string) {
    const sinceMs = Date.now() - 2 * 60 * 1000;
    for (let attempt = 0; attempt < 5; attempt++) {
      await delay(400);
      try {
        const msgs = await this.dws.list({ group: this.cfg.dingtalk.openConversationId, sinceMs, forward: false, limit: 10 });
        const hit = msgs.find((m) => m.content.includes(marker));
        if (hit) return hit;
      } catch (err) {
        this.log.debug('findPushedMessage 出错，重试', { err: String(err) });
      }
    }
    return undefined;
  }

  /** 处理 poller 来的入站事件。 */
  onInboundEvents(events: InboundEvent[]): void {
    for (const ev of events) {
      if (ev.kind === 'emoji') {
        const sessionId = this.pushedToSession.get(ev.messageId);
        if (!sessionId) continue; // 表情不在任何活跃推送消息上
        void this.resolve(sessionId, ev.emoji, `表情:${ev.emoji}`);
      } else {
        // 文本：归给当前唯一在等待的会话（多会话场景 M5 再细化）。
        const waiting = [...this.sessions.values()].filter((s) => s.state === 'WAITING_USER');
        if (waiting.length !== 1) {
          if (waiting.length > 1) this.log.warn('多个会话在等待，文本回复无法归属，忽略', { text: ev.text });
          continue;
        }
        void this.resolve(waiting[0]!.sessionId, ev.text, `文本:${ev.text}`);
      }
    }
  }

  private async resolve(sessionId: string, choiceKey: string, desc: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.state !== 'WAITING_USER' || !rec.optionSet) return;
    const option = rec.optionSet.options.find((o) => o.key === choiceKey.trim());
    if (!option) {
      this.log.debug('选择无法匹配选项，忽略', { session: sessionId.slice(0, 8), desc });
      return;
    }
    if (!rec.pane) {
      this.log.error('无 pane，无法注入', { session: sessionId.slice(0, 8) });
      this.clearWait(rec);
      return;
    }
    if (!(await this.tmux.hasPane(rec.pane))) {
      this.log.error('pane 已不存在，无法注入', { session: sessionId.slice(0, 8), pane: rec.pane });
      this.clearWait(rec);
      return;
    }
    // 先切到 INJECTING 并清理等待态，避免后续同消息的事件重复触发。
    rec.state = 'INJECTING';
    this.clearWait(rec);
    try {
      await this.tmux.injectLine(rec.pane, option.injectText, this.cfg.tmux.sendKeysEnterDelayMs);
      this.log.info('已注入选项', { session: sessionId.slice(0, 8), pane: rec.pane, choice: option.key, desc });
    } catch (err) {
      this.log.error('注入失败', { err: String(err) });
      rec.state = 'IDLE';
    }
  }

  /** 清理一个会话的等待态（推送消息映射等）。 */
  private clearWait(rec: SessionRecord): void {
    if (rec.pushedMessageId) {
      this.pushedToSession.delete(rec.pushedMessageId);
      this.pushedCreateMs.delete(rec.pushedMessageId);
    }
    rec.pushedMessageId = undefined;
    rec.optionSet = undefined;
    rec.pushedAtTurns = undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
