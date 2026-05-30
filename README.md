# claude-notifier

用**手机钉钉**远程轻量驱动本地 Mac 上的 **Claude Code** 会话。

当你锁屏离开,本地 Claude Code 干完一轮停下来等你下一步时,它会让 Claude 自己总结现状、给出 2~5 个建议选项,推送到你手机钉钉;你**点一下对应表情**,选项就被注入回那个正在运行的会话,驱动 Claude 继续。

```
Claude 停下(锁屏)  ──Stop hook──▶  daemon  ──注入 meta-prompt──▶  Claude 生成 JSON 选项
                                     │                                      │
       你点表情  ◀──钉钉推送选项──  daemon  ◀────────读取选项──────────────┘
          │
          └──轮询读到表情──▶  daemon  ──tmux send-keys 注入选中项──▶  Claude 继续
```

## 工作原理

- **触发**:Claude Code 的 `Stop` hook(会话结束一轮、等你输入时触发;锁屏时 60s 的 `idle_prompt` 作兜底)。只有"真正停下等人"才触发——auto 模式不会自启新一轮,不会误触发;`permission_prompt`(轮次中途的工具授权)不处理。
- **选项生成**:daemon 往同一会话注入一句固定 meta-prompt,让 Claude 输出带唯一 `sentinel` 的 JSON 选项;daemon 按 sentinel 在 transcript 里找到并校验。失败重试一次,再不行退化为固定"继续/停止"。
- **出站/入站**:经 [dingtalk-workspace-cli (`dws`)](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli) 发消息 / 轮询读消息。**只认挂在推送消息上的表情 reaction**(表情名 = 选项 key),不处理文本回复。
- **注入**:`tmux send-keys` 打进 Claude 所在 pane。会话↔pane 由 hook 自动捕获 `$TMUX_PANE` 映射,**无需手动命名**。
- **常驻**:作为 launchd 服务运行,开机自启 + 崩溃自动重启。

## 前置条件

1. **macOS** + **tmux**(默认 server)。
2. **Node ≥ 20**。
3. **`dws` 已安装并登录**:`npm i -g dingtalk-workspace-cli && dws auth login`(约每 30 天需重登一次)。
4. 一个**钉钉单人群**(API 建群可绕过 UI 最少人数:`dws chat group create --name "Claude遥控" --users <你的userId>`),拿到它的 `openConversationId`。
5. 在手机钉钉里**手动创建文字表情 `1` `2` `3` `4` `5`**(`dws chat message create-text-emotion` 也可),用于点选。

## 安装

```bash
git clone <repo> && cd claude-notifier
npm install
cp config.example.json config.json     # 然后按需修改 config.json
npm run cli -- install-hooks            # 写入 ~/.claude/settings.json(会备份原文件)
npm run cli -- install-service          # 安装并启动 launchd 常驻服务
```

## 配置(`config.json`)

| 键 | 说明 |
|---|---|
| `dingtalk.openConversationId` | 推送/轮询的钉钉群会话 id |
| `dingtalk.userId` / `userDisplayName` | 你的 userId / 显示名(用于识别你点的表情) |
| `dingtalk.dwsBin` | dws 可执行名,默认 `dws` |
| `notify.onlyWhenLocked` | **仅锁屏时推送**(默认 true),避免你在电脑前被打扰 |
| `emojis.candidates` | 候选表情名(默认 `["1".."5"]`),即选项 key |
| `options.maxCount` / `retryOnInvalid` | 最多选项数(≤5) / JSON 非法重试次数 |
| `timeouts.generationMs` | 等 Claude 产出选项的超时(超时用固定选项) |
| `safety.maxGenerationsPerWindow` / `windowMs` | 熔断:单会话单位时间最多生成次数,超出降级固定选项(防 token 失控) |
| `poll.intervalMs` | 轮询表情的间隔(仅在有会话等待时轮询) |
| `hookServer.port` | 本地 hook 接收端口,默认 8787 |

## 使用

1. **在 tmux 里**原生启动 Claude:
   ```bash
   tmux new -s work
   claude
   ```
2. 正常用 Claude。离开时**锁屏**(`Ctrl+Cmd+Q`)。
3. Claude 干完停下 → 手机钉钉收到 `[CN] 请选择 #...` + 选项。
4. 在那条消息上**点对应数字表情**(或点你定义的表情)→ Claude 继续。

> 不在 tmux 里运行的 Claude 会话**不会**推送(无法遥控,避免无意义打扰)。

## 命令

```bash
npm run cli -- status             # 当前在等哪些会话(打到运行中的 daemon)
npm run cli -- service-status     # launchd 服务存活状态
npm run cli -- install-service    # 安装/重载服务(改代码后跑这个,幂等)
npm run cli -- uninstall-service  # 卸载服务
npm run cli -- start              # 前台运行 daemon(调试用)
```

日志:`~/.claude-notifier/daemon.log`。

## 已知限制

- **整机重启**后 launchd 服务会自启,但你之前的 tmux 会话已不存在 → 重启前未处理的回复无法注入(可配合 tmux-resurrect)。
- 必须用**默认 tmux server**(别用 `tmux -L <socket>` 另起的 server),否则 daemon 找不到 pane。
- `dws` 鉴权约 30 天过期,失效时日志会提示 `dws auth login`(daemon 无法自修)。
- 仅 macOS(锁屏检测用 `ioreg` 的 `IOConsoleLocked`)。

## 卸载

```bash
npm run cli -- uninstall-service
cp ~/.claude/settings.json.cn-backup ~/.claude/settings.json   # 或手动删掉 hooks 里 claude-notifier 的条目
```
