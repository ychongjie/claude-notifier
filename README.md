# claude-notifier

用**手机钉钉**远程轻量驱动本地 Mac 上的 **Claude Code** 会话。

当你锁屏离开,本地 Claude Code 干完一轮停下来等你下一步时,它会让 Claude 自己总结现状、给出几个建议选项,推送到你手机钉钉;你**点一下对应表情**(或**引用那条消息回复一段文字**直接发指令),选项/文字就被注入回那个正在运行的会话,驱动 Claude 继续。

每轮选项还会固定附一项「都不合适／看更详细的进展和选项」——选它不推进工作,而是让 Claude 重新产出一版**更详尽的进展+选项**再推给你。

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
- **出站/入站**:经 [dingtalk-workspace-cli (`dws`)](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli) 发消息 / 轮询读消息。入站认两种:**挂在推送消息上的表情 reaction**(表情名 = 选项 key),以及**「引用」推送消息的文字回复**(靠引用里的原消息 id 精确归属到对应会话;纯数字当作选编号,否则把文字作为自由指令注入)。普通(无引用)文本不处理。
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
| `dingtalk.agentCode` | host-owned PAT 模式标识(默认 `claude-notifier`)。注入 `DINGTALK_DWS_AGENTCODE`,让 dws 命中 PAT 墙时返回结构化错误而**不拉起浏览器** |
| `notify.onlyWhenLocked` | **仅锁屏时推送**(默认 true),避免你在电脑前被打扰 |
| `notify.localNotification` | 鉴权失效/缺授权时弹一条**本机 macOS 通知**(默认 true);此时 dws 已发不出钉钉,靠本机提醒你介入 |
| `notify.terminalBundleId` | 桌面控件「点击切回会话」要激活的终端 app bundle id(默认 `com.mitchellh.ghostty`) |
| `poll.maxBackoffMs` / `authPauseMs` | 轮询失败退避上限 / 鉴权失效时暂停探测间隔(默认 1min / 10min) |
| `timeouts.staleWaitMs` | 等待无人响应多久后自动作废(默认 6h),避免永久轮询 |
| `emojis.candidates` | 候选表情名(默认 `["1".."5"]`),即选项 key |
| `options.maxCount` / `retryOnInvalid` | 最多选项数(≤5,含固定的「更详细」项) / JSON 非法重试次数 |
| `options.reserveDetailOption` / `detailOptionLabel` | 是否保留固定的「看更详细的进展和选项」末位项(默认 true)/ 其展示文案。开启时 Claude 自生成的选项被压到 `maxCount-1` |
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
3. Claude 干完停下 → 手机钉钉收到 `[CN] 请选择 #...` + 选项(**首次推送精简**:只列编号+标签+简短摘要,末位固定一项「看更详细的进展和选项」)。
4. 三选一让 Claude 继续:
   - 在那条消息上**点对应数字表情**(或点你定义的表情);
   - **引用那条消息回复一段文字**(都不合适时),文字会作为自由指令注入;
   - 点末位「看更详细的进展和选项」(它的编号紧接最后一个真实选项,不跳号)→ 收到**更详尽的二次推送**(更长摘要 + 每个选项附「→ 选中后会发的指令」),不推进工作。

> 不在 tmux 里运行的 Claude 会话**不会**推送(无法遥控,避免无意义打扰)。

### 工具授权(允许/拒绝)

非 auto 模式下,Claude 中途需要工具授权(`permission_prompt`)时,锁屏的话会推送一条 `[CN] 需要授权 #...`,列出 `1) 允许 2) 拒绝`。点表情即可:
- **允许** → 发送 `Enter`(确认弹窗高亮的默认项 Yes)
- **拒绝** → 发送 `Escape`(取消 = No)

按键可在 `config.json` 的 `permission.allowKey` / `denyKey` 调整,可用 `permission.enabled:false` 关闭。

### 置顶浮层:实时会话面板 + 点击切回

一个置顶浮层 HUD(`mac-hud/`),竖屏副屏左缘的左缘抽屉——平时只露箭头把手,点一下面板从左滑出占满竖屏宽度并钉住、再点收回;**浮在所有窗口之上(含最大化 / 原生全屏)**,平时不占地、不干扰其他 app。面板里**实时列出所有 Claude 会话**:tmux session 名 + 启动目录(重名补父级)+ 运行状态(运行中/思考中/等输入/等后台结果/等授权)+ ◆ 工作主题(Claude Code 自动标题)+ 初始/当前 prompt + 当前在跑的工具 + 时长·token。数据走 daemon 的 `GET /panel`(自包含 HTML,内部连 `/events` SSE 实时刷新)。每张卡片有一个 **「切回 →」按钮** → 切回该会话:在其 tmux session 里选中 pane,并把承载它的终端窗口拉到最前(经 Dock 窗口菜单,**可跨原生全屏 Space**,不重开实例)。

安装(需 `swiftc`,Xcode Command Line Tools 即可):

```bash
cd mac-hud
./install.sh      # 编译 → 装成登录自启的 LaunchAgent(com.claude-notifier.hud)
./uninstall.sh    # 卸载自启并退出
```

- **点击切回**需给 daemon 的 node 加「辅助功能(Accessibility)」权限(`launchctl print` 里 plist 用的 node 真实路径);没权限时退化为仅把终端 app 调前。终端 app 由 `notify.terminalBundleId` 指定(默认 ghostty)。
- 切回全屏窗口若发现全屏 Space 顺序被打乱,是 macOS「自动根据最近使用情况重新排列空间」所致,关掉即可:`defaults write com.apple.dock mru-spaces -bool false && killall Dock`。
- 会话**出现**:启动即入列(`SessionStart`),daemon 重启也不丢(持久化到 `~/.claude-notifier/activity.json`)。**消失**:正常退出即时移除 / 关窗口·kill 后约 4s 移除(pane 探活)/ 12h 无活动兜底。
- 与钉钉遥控**完全解耦**——浮层只读状态、点击只切窗口,不注入、不推钉钉。
- 位置/尺寸调参见 `mac-hud/README.md`(把手宽高、面板高、距屏顶等常量)。

> ⚠️ **安全提示**:首次使用前请用一个真实权限弹窗验证"拒绝"确实拒绝了(见下)。不同 Claude Code 版本菜单若有差异,改 `denyKey` 即可。

## 命令

```bash
npm run cli -- status             # 当前在等哪些会话(打到运行中的 daemon)
npm run cli -- service-status     # launchd 服务存活状态
npm run cli -- install-service    # 安装/重载服务(改代码后跑这个,幂等)
npm run cli -- uninstall-service  # 卸载服务
npm run cli -- start              # 前台运行 daemon(调试用)
```

日志:`~/.claude-notifier/daemon.log`。

## 鉴权与无人值守

dws 用 OAuth(扫码/设备流)登录,access token ~2h、refresh token ~30 天,**会自动静默续期**——正常情况下可无人长跑。两个要点:

- **host-owned PAT 模式(默认开)**:`dingtalk.agentCode` 非空时,daemon 给 dws 注入 `DINGTALK_DWS_AGENTCODE`。命中"行为授权(PAT)"墙时 dws **只返回结构化错误、不拉起浏览器、不轮询**(交给宿主)。这根除了"鉴权失效时每次调用弹一个钉钉登录页"的风暴。
- **失败即暂停 + 本机通知**:轮询遇到鉴权失效(`auth`,需 `dws auth login`)或缺授权(`pat`,需 `dws pat chmod`)时,daemon **暂停轮询、每 10min 才探测一次**(不再每 2s 硬刚),并弹一条本机 macOS 通知提醒你;处理后**自动恢复**,无需重启。

**一次性设置(登录后做一遍):**

```bash
dws auth login                                  # 扫码登录(约每 30 天一次)
dws pat browser-policy --enabled=false          # 关掉 PAT 撞墙时的浏览器弹窗(全局兜底)
dws pat chmod chat.message:send chat.message:list \
  --grant-type permanent --agentCode claude-notifier   # 永久授予 daemon 所需 scope
```

> ⚠️ **无法 100% 免登录**:dws 不支持 AppKey/AppSecret 登录,base token 真正失效(满 30 天、被吊销、或长断网期间续期链断裂)后仍需手动 `dws auth login` 一次。本机通知会在那时提醒你。

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
