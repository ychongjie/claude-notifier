// 会话管理 + 状态机：锁屏门控 → 注入 meta-prompt 生成选项 → 推送 → 轮询表情 → tmux 注入。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config.js';
import { expandHome } from '../config.js';
import type { Logger } from '../logger.js';
import { DwsError } from '../dingtalk/dwsClient.js';
import type { DwsClient } from '../dingtalk/dwsClient.js';
import type { TmuxClient } from '../tmux/tmuxClient.js';
import { pushOptions } from '../dingtalk/push.js';
import { isScreenLocked } from '../mac/lockState.js';
import { macNotifyThrottled, macNotifyClickable, buildSwitchCommand } from '../mac/notify.js';
import { readTranscript, readPendingToolUse, describeToolUse } from '../options/transcript.js';
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
  private readonly stateFilePath: string;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly dws: DwsClient,
    private readonly tmux: TmuxClient,
  ) {
    this.stateFilePath = expandHome(cfg.paths.stateFile);
  }

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
    this.expireStaleWaits(); // 先清理无人响应的陈旧等待，避免永久轮询
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
    if (h.cwd) rec.cwd = h.cwd;

    const sid = h.sessionId.slice(0, 8);

    // 正在生成选项：Stop 到达即尝试解析（内部按 sentinel 搜索 + 重读容忍刷盘延迟）。
    if (rec.state === 'GENERATING_OPTIONS') {
      await this.handleGenerationResult(rec, h.transcriptPath);
      return;
    }

    const info = readTranscript(h.transcriptPath);

    if (rec.state === 'WAITING_USER') {
      // 已在等待。若 transcript 轮数已超过推送时（用户直接回终端操作了）→ 旧选项作废。
      if (rec.pushedAtTurns !== undefined && info.assistantTurns > rec.pushedAtTurns) {
        this.log.info('等待期间检测到新进展，作废旧选项', { session: sid });
        this.clearWait(rec);
        rec.state = 'IDLE'; // 关键：回到 IDLE，按新的自然停继续处理（否则卡死在 WAITING_USER）
      } else {
        this.log.debug('已在等待用户，忽略重复 hook', { session: sid });
        return;
      }
    }
    if (rec.state === 'INJECTING') {
      // 注入后 Claude 完成本轮的"自然停" → 这是下一次等待，转 IDLE 继续处理。
      rec.state = 'IDLE';
    }

    // 空闲提醒：这是一次"新的等待"（已排除 GENERATING_OPTIONS 与重复 hook）→ 重置 30 分钟时钟。
    this.maybeArmIdleTimer(rec, info.assistantTurns);

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

  /** 处理工具授权弹窗：推送「允许/拒绝」，点选后发送对应按键。 */
  async onPermissionPrompt(h: IncomingHook): Promise<void> {
    if (!this.cfg.permission.enabled) return;
    const rec = this.get(h.sessionId);
    if (h.pane) rec.pane = h.pane;
    if (h.cwd) rec.cwd = h.cwd;
    const sid = h.sessionId.slice(0, 8);

    // 无 pane 无法操作菜单 → 跳过。
    if (!rec.pane || !(await this.tmux.hasPane(rec.pane))) {
      this.log.debug('权限弹窗但无可用 pane，跳过', { session: sid });
      return;
    }
    // 仅锁屏时介入。
    if (this.cfg.notify.onlyWhenLocked) {
      const locked = await isScreenLocked();
      if (locked === false) {
        this.log.debug('屏幕未锁，权限弹窗交给本机处理', { session: sid });
        return;
      }
    }
    // 取消任何进行中的选项生成（权限优先），用固定的允许/拒绝选项推送。
    this.clearGen(rec);
    // 从 transcript 取出正在等待授权的工具调用，展示「具体执行什么命令」。
    // hook 的 message 多为泛化文案（如 "Claude needs your permission"），不含命令本身。
    const pending = readPendingToolUse(h.transcriptPath);
    const head = pending ? describeToolUse(pending) : h.message?.trim() || 'Claude 请求执行一个需要确认的操作';
    const optionSet: OptionSet = {
      summary: '需要工具授权：' + head,
      options: [
        { key: '1', label: '允许', injectText: 'allow', keys: this.cfg.permission.allowKey },
        { key: '2', label: '拒绝', injectText: 'deny', keys: this.cfg.permission.denyKey },
      ],
    };
    const info = readTranscript(h.transcriptPath);
    this.log.info('收到权限弹窗，推送允许/拒绝', { session: sid, message: optionSet.summary.slice(0, 80) });
    await this.pushAndWait(rec, optionSet, info.assistantTurns, 'permission');
  }

  /** 注入 meta-prompt，让 Claude 自吐结构化选项。 */
  private async startOptionGeneration(rec: SessionRecord, turns: number): Promise<void> {
    const sid = rec.sessionId.slice(0, 8);
    // 无可用 tmux pane（claude 不在 tmux 里，或 pane 已关）→ 无法遥控该会话，直接跳过、不推送。
    if (!rec.pane || !(await this.tmux.hasPane(rec.pane))) {
      this.log.debug('无可用 tmux pane，跳过（该会话无法遥控）', { session: sid, pane: rec.pane });
      return;
    }
    // 熔断器：单会话在 windowMs 内 meta-prompt 生成次数超阈值 → 不再生成（不注入、不烧 token），降级固定选项。
    const now = Date.now();
    rec.genTimes = (rec.genTimes ?? []).filter((t) => now - t < this.cfg.safety.windowMs);
    if (rec.genTimes.length >= this.cfg.safety.maxGenerationsPerWindow) {
      this.log.error('生成频率过高，熔断：降级为固定选项以防 token 失控', {
        session: sid,
        count: rec.genTimes.length,
        windowMs: this.cfg.safety.windowMs,
      });
      await this.pushAndWait(rec, FALLBACK_OPTIONS, turns);
      return;
    }
    rec.genTimes.push(now);
    const sentinel = makeSentinel(this.cfg.metaPrompt.sentinelPrefix);
    rec.state = 'GENERATING_OPTIONS';
    rec.genTurns = turns;
    rec.sentinel = sentinel;
    rec.retriesLeft = this.cfg.options.retryOnInvalid;
    this.scheduleGenTimeout(rec);
    this.clearIdleTimer(rec); // 进入"生成中"，不再算等待用户（产出选项后的 push 会重新武装）
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

  // ---- 30 分钟空闲提醒（独立于钉钉遥控：任一 tmux 会话等待用户输入过久 → 可点击本机通知）----

  /** 用户在该会话提交了输入（UserPromptSubmit hook）→ 正在工作，取消空闲提醒。 */
  onUserActivity(h: IncomingHook): void {
    const rec = this.get(h.sessionId);
    if (h.pane) rec.pane = h.pane;
    if (h.cwd) rec.cwd = h.cwd;
    this.clearIdleTimer(rec);
  }

  /**
   * 武装空闲提醒定时器。仅 tmux 会话（有 pane，能切换）才提醒；
   * 同一轮数的重复 hook 不重置时钟（否则反复 idle 通知会让 30 分钟永远走不到）。
   */
  private maybeArmIdleTimer(rec: SessionRecord, turns: number): void {
    if (!this.cfg.notify.idleSwitch.enabled) return;
    if (!rec.pane) return; // 非 tmux 会话点了也切不过去 → 不提醒
    if (rec.idleTurns === turns) return; // 无新进展的重复 hook：不重置时钟也不重弹
    this.clearIdleTimer(rec);
    rec.idleTurns = turns;
    rec.waitingSince = Date.now();
    rec.idleNotified = false;
    rec.idleTimer = setTimeout(() => void this.maybeIdleNotify(rec), this.cfg.notify.idleSwitch.afterMs);
  }

  private clearIdleTimer(rec: SessionRecord): void {
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    rec.idleTimer = undefined;
  }

  /** 定时器到点：仍是 tmux 等待态 + 未锁屏 → 弹一条可点击通知（点击切回该会话）。
   *  锁屏时你不在电脑前，提醒走钉钉，桌面通知不弹。 */
  private async maybeIdleNotify(rec: SessionRecord): Promise<void> {
    rec.idleTimer = undefined;
    const sid = rec.sessionId.slice(0, 8);
    if (rec.state === 'INJECTING') return; // 正在处理用户输入，不算等待
    if (!rec.pane || !(await this.tmux.hasPane(rec.pane))) return; // pane 没了，切不过去
    const locked = await isScreenLocked();
    // 锁屏（或判定不出）：你不在电脑前，此时已走钉钉提醒 → 桌面通知不弹、也不重探。
    if (locked !== false) return;
    if (rec.idleNotified) return;
    rec.idleNotified = true;
    const ageMin = Math.round((Date.now() - (rec.waitingSince ?? Date.now())) / 60000);
    const cwdBase = rec.cwd ? (rec.cwd.split('/').filter(Boolean).pop() ?? rec.cwd) : sid;
    const exec = buildSwitchCommand(rec.pane, this.cfg.notify.idleSwitch.terminalBundleId);
    const clickable = macNotifyClickable({
      title: `Claude 已等待输入 ${ageMin} 分钟`,
      subtitle: cwdBase,
      message: '点击切回该会话',
      group: `cn-idle-${rec.sessionId}`,
      execute: exec ?? undefined,
      notifierBin: this.cfg.notify.idleSwitch.terminalNotifierBin,
    });
    this.log.info('已弹空闲提醒通知', { session: sid, pane: rec.pane, ageMin, clickable: clickable && !!exec });
  }

  private async pushAndWait(
    rec: SessionRecord,
    optionSet: OptionSet,
    turns: number,
    kind: 'options' | 'permission' = 'options',
  ): Promise<void> {
    this.clearGen(rec); // 离开 GENERATING_OPTIONS
    const marker = `CN-${rec.sessionId.slice(0, 8)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    try {
      await pushOptions(this.dws, this.cfg, { sessionId: rec.sessionId, optionSet, marker, kind });
    } catch (err) {
      this.log.error('推送选项失败', { err: String(err) });
      // 推送失败若是鉴权/授权问题，弹本机通知提醒（此时钉钉已发不出，只能靠本机）。
      const cat = err instanceof DwsError ? err.category : 'unknown';
      if ((cat === 'auth' || cat === 'pat') && this.cfg.notify.localNotification) {
        const action = cat === 'pat' ? 'dws pat chmod' : 'dws auth login';
        macNotifyThrottled('claude-notifier 推送失败', `dws ${cat} 失效，请运行 ${action}`);
      }
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
    this.maybeArmIdleTimer(rec, turns); // 已推送、等待用户在手机点选 → 30 分钟仍无响应则本机提醒
    this.persistState();
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

  /** 处理 poller 来的入站事件（仅表情，挂在具体推送消息上，天然归属到对应会话）。 */
  onInboundEvents(events: InboundEvent[]): void {
    for (const ev of events) {
      const sessionId = this.pushedToSession.get(ev.messageId);
      if (!sessionId) continue; // 表情不在任何活跃推送消息上
      void this.resolve(sessionId, ev.emoji, `表情:${ev.emoji}`);
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
    rec.genTimes = []; // 用户成功介入 → 重置熔断计数
    this.clearIdleTimer(rec); // 用户已介入 → 取消空闲提醒（下一次自然停会重新武装）
    this.clearWait(rec);
    try {
      if (option.keys) {
        // 权限菜单：发送按键名（如 Enter/Escape）而非字面文本。
        await this.tmux.sendKey(rec.pane, option.keys);
        this.log.info('已发送授权按键', { session: sessionId.slice(0, 8), pane: rec.pane, choice: option.key, keys: option.keys, desc });
      } else {
        await this.tmux.injectLine(rec.pane, option.injectText, this.cfg.tmux.sendKeysEnterDelayMs);
        this.log.info('已注入选项', { session: sessionId.slice(0, 8), pane: rec.pane, choice: option.key, desc });
      }
    } catch (err) {
      this.log.error('注入失败', { err: String(err) });
      rec.state = 'IDLE';
    }
  }

  /**
   * 作废超时无人点选的等待：否则一旦有等待，poller 会永久轮询（周末无人回复 → 一整天每 2s 调 dws）。
   * 同时这也是 daemon 重启后清掉 stateFile 里历史遗留死等待的入口。
   */
  private expireStaleWaits(): void {
    const now = Date.now();
    const max = this.cfg.timeouts.staleWaitMs;
    for (const rec of this.sessions.values()) {
      if (rec.state !== 'WAITING_USER' || !rec.pushedMessageId) continue;
      const started = this.pushedCreateMs.get(rec.pushedMessageId) ?? now;
      if (now - started > max) {
        this.log.warn('等待超时无人响应，作废该选项', {
          session: rec.sessionId.slice(0, 8),
          ageMin: Math.round((now - started) / 60000),
        });
        this.clearWait(rec);
        rec.state = 'IDLE';
      }
    }
  }

  /** 清理一个会话的等待态（推送消息映射、表情记录、状态文件）。 */
  private clearWait(rec: SessionRecord): void {
    if (rec.pushedMessageId) {
      this.pushedToSession.delete(rec.pushedMessageId);
      this.pushedCreateMs.delete(rec.pushedMessageId);
      this.tracker?.forget(rec.pushedMessageId);
    }
    rec.pushedMessageId = undefined;
    rec.optionSet = undefined;
    rec.pushedAtTurns = undefined;
    this.persistState();
  }

  // ---- 状态持久化：让 daemon 重启后仍能接收对此前推送消息的表情 ----

  private persistState(): void {
    const waits = [...this.sessions.values()]
      .filter((s) => s.state === 'WAITING_USER' && s.pushedMessageId && s.optionSet)
      .map((s) => ({
        sessionId: s.sessionId,
        pane: s.pane,
        pushedMessageId: s.pushedMessageId,
        pushedCreateMs: this.pushedCreateMs.get(s.pushedMessageId!),
        optionSet: s.optionSet,
        pushedAtTurns: s.pushedAtTurns,
      }));
    try {
      mkdirSync(dirname(this.stateFilePath), { recursive: true });
      writeFileSync(this.stateFilePath, JSON.stringify({ waits }, null, 2));
    } catch (err) {
      this.log.warn('写状态文件失败', { err: String(err) });
    }
  }

  /** 启动时恢复未决的等待，使重启/宕机期间或之后点的表情仍能生效。 */
  restoreState(): void {
    let data: { waits?: Array<Record<string, unknown>> };
    try {
      data = JSON.parse(readFileSync(this.stateFilePath, 'utf8')) as typeof data;
    } catch {
      return; // 无状态文件
    }
    let n = 0;
    for (const w of data.waits ?? []) {
      const sessionId = w.sessionId as string | undefined;
      const pushedMessageId = w.pushedMessageId as string | undefined;
      const optionSet = w.optionSet as OptionSet | undefined;
      if (!sessionId || !pushedMessageId || !optionSet) continue;
      const rec: SessionRecord = {
        sessionId,
        state: 'WAITING_USER',
        pane: w.pane as string | undefined,
        pushedMessageId,
        optionSet,
        pushedAtTurns: w.pushedAtTurns as number | undefined,
      };
      this.sessions.set(sessionId, rec);
      this.pushedToSession.set(pushedMessageId, sessionId);
      this.pushedCreateMs.set(pushedMessageId, (w.pushedCreateMs as number) ?? Date.now());
      // 不设表情基线：宕机期间已点的表情视为"新"，重启后会被处理。
      n++;
    }
    if (n > 0) this.log.info('已恢复未决等待', { count: n });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
