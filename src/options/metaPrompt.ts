// 构造注入给 Claude 的 meta-prompt（必须单行：tmux send-keys 里换行会被当回车提前提交）。
// 让 Claude 只输出一个 JSON 块，bridge 解析出选项后推给手机。

/** 生成本轮唯一 sentinel。 */
export function makeSentinel(prefix: string): string {
  const rand = Math.floor(Math.random() * 1e12).toString(36);
  return `${prefix}${rand}`;
}

/** 单行 meta-prompt。maxOptions 为允许的最大选项数。 */
export function buildMetaPrompt(sentinel: string, maxOptions: number): string {
  return (
    `[claude-notifier] 暂停一下：请总结当前进展并给出接下来 2~${maxOptions} 个可选操作，` +
    `只输出一个 JSON 代码块、不要任何其它文字。格式严格为 ` +
    `{"sentinel":"${sentinel}","summary":"不超过200字的现状或在等什么","options":[{"key":"1","label":"简短标签","injectText":"该选项被选中时我替你原样发给你的话"}]}。` +
    `给 2 到 ${maxOptions} 个选项，key 用 "1" 到 "${maxOptions}"；injectText 写成能让你据此直接继续工作的指令；summary 与 injectText 内不要出现换行。`
  );
}
