// 构造注入给 Claude 的 meta-prompt（必须单行：tmux send-keys 里换行会被当回车提前提交）。
// 让 Claude 只输出一个 JSON 块，bridge 解析出选项后推给手机。

/** 生成本轮唯一 sentinel。 */
export function makeSentinel(prefix: string): string {
  const rand = Math.floor(Math.random() * 1e12).toString(36);
  return `${prefix}${rand}`;
}

/** 单行 meta-prompt。maxOptions 为允许的最大选项数；detailed=true 时要求更详尽的进展与选项说明。 */
export function buildMetaPrompt(sentinel: string, maxOptions: number, detailed = false): string {
  // summary 写清楚：现在在做什么 / 卡在哪或在等什么 / 为什么需要我决定（让我在手机上一眼看懂你要干嘛）。
  const summaryHint = detailed
    ? '把现状讲详细些（不超过400字）：你刚做了什么、当前卡点或在等什么、为什么需要我拍板、各选项分别会导致什么'
    : '不超过120字，简明讲清现状和卡在哪/在等什么（让我一眼看懂你要做什么，别展开细节）';
  // label：每个选项写成一句能看懂"选了会发生什么"的短句；injectText：选中后替我发给你的指令。
  const labelHint = detailed ? '一句话说清这个选项会让你做什么（可稍长）' : '能看懂选了会发生什么的短句';
  return (
    `[claude-notifier] 暂停一下：请总结当前进展并给出接下来 2~${maxOptions} 个可选操作，` +
    `只输出一个 JSON 代码块、不要任何其它文字。格式严格为 ` +
    `{"sentinel":"${sentinel}","summary":"${summaryHint}","options":[{"key":"1","label":"${labelHint}","injectText":"该选项被选中时我替你原样发给你的话"}]}。` +
    `给 2 到 ${maxOptions} 个选项，key 用 "1" 到 "${maxOptions}"；injectText 写成能让你据此直接继续工作的明确指令；summary 与 injectText 内不要出现换行。`
  );
}
