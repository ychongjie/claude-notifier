# CLAUDE.md

给在本仓库工作的 Claude Code 的开发指引。面向用户文档见 `README.md`,完整设计见 `docs/PLAN.md`。

## 这是什么

一个常驻 daemon,把本地 Claude Code 会话桥接到手机钉钉:Claude 停下等输入(锁屏时)→ 让 Claude 自己生成选项 → 推钉钉 → 用户点表情 → 注入回同一会话。Node/TypeScript,ESM,用 `tsx` 直接跑源码(无构建产物)。

## 开发命令

```bash
npm run typecheck                 # tsc --noEmit,改完必跑
npm run cli -- <subcommand>       # 跑 CLI(start / install-hooks / status / *-service)
npm run smoke                     # M0 冒烟:dws 收发 + tmux 注入封装
npm run cli -- install-service    # 改代码后重载 launchd 服务(幂等,tsx 跑源码所以无需 build)
npm run cli -- status             # 看运行中 daemon 的会话状态
```

无单测框架;验证靠 `typecheck` + 针对性的临时 `tsx` 脚本 + 真机/合成 hook。改动后务必 `npm run typecheck`。

## 架构(数据流)

```
bin/claude-notifier-hook         # POSIX sh:读 stdin payload + $TMUX_PANE(经 X-CN-Pane header),curl POST 给 daemon
  └─> src/hooks/hookServer.ts    # 本地 HTTP:POST /hook 收事件,GET /status 出状态,GET /events 出 SSE
        └─> src/daemon.ts        # 编排:HookServer + Poller + SessionManager + ActivityTracker
              ├─> src/status/activityTracker.ts   # 展示态(桌面控件数据源):旁路观察 hook 流,与状态机解耦
              │     └─ ubersicht/claude-sessions.jsx  # Übersicht 桌面挂件(curl /status 渲染会话列表)
              └─> src/session/sessionManager.ts   # 状态机(核心)
                    ├─ src/options/metaPrompt.ts     # 单行 meta-prompt + sentinel
                    ├─ src/options/optionsSchema.ts  # zod 校验 + 按 sentinel 搜 transcript
                    ├─ src/options/transcript.ts     # 解析 transcript JSONL(assistant 文本)
                    ├─ src/dingtalk/push.ts          # 渲染并发送选项(正文嵌 marker)
                    ├─ src/dingtalk/dwsClient.ts     # dws CLI 封装(execFile,数组传参)
                    ├─ src/dingtalk/poller.ts        # 仅在有等待时轮询群消息
                    │    └─ src/dingtalk/inboundDedup.ts  # 表情差集(仅认 reaction)
                    ├─ src/tmux/tmuxClient.ts        # send-keys -l 注入 / hasPane
                    └─ src/mac/lockState.ts          # ioreg IOConsoleLocked 锁屏检测
src/service/launchd.ts           # LaunchAgent plist 生成与加载
```

## 状态机(`SessionManager`,按 session_id)

`IDLE → GENERATING_OPTIONS → WAITING_USER → INJECTING → IDLE`

- **IDLE + Stop/idle hook(锁屏)** → 注入 meta-prompt,进 GENERATING_OPTIONS,记 `genTurns`/`sentinel`/超时。
- **GENERATING_OPTIONS + Stop** → `handleGenerationResult`:重读 transcript(容忍刷盘延迟,~2s)按 sentinel 找合法 JSON → 推送进 WAITING_USER;失败重试一次→固定选项兜底。
- **WAITING_USER + 表情事件** → `resolve`:映射 emoji→选项→`tmux send-keys` 注入,进 INJECTING。
- **INJECTING + 下一次 Stop** → 回 IDLE(那是新的自然停),进入下一轮。

## 必须遵守的不变量(改动时别破坏)

1. **meta-prompt 必须单行**:`tmux send-keys` 里的换行 = 回车 = 提前提交。`injectText` 也要去换行(`optionsSchema` 已做)。
2. **只认表情 reaction**,不处理文本回复(挂在具体消息上 → 天然归属会话,无多会话歧义)。表情名 = 选项 key。
3. **锁屏门控**:`notify.onlyWhenLocked` 时未锁不推。新增推送路径都要走这个门控。
4. **sentinel 关联**:每轮 meta-prompt 用唯一 sentinel;靠它在 transcript 多条 assistant 文本里定位本轮产出(防错配、防刷盘竞态)。
5. **选项生成只在 Stop(+idle_prompt 兜底)**;`permission_prompt` 走**独立路径**(`onPermissionPrompt`):不注入 meta-prompt,直接推固定「允许/拒绝」,点选后用 `option.keys` 发送 tmux 按键名(允许=`permission.allowKey` 默认 Enter,拒绝=`permission.denyKey` 默认 Escape)。**这是安全关键**:denyKey 必须真的拒绝,改动前务必在真实权限弹窗上验证。
6. **无 pane 不推**:claude 不在 tmux 里就无法遥控,`startOptionGeneration` 直接跳过。
7. **防 token 失控**:`safety` 熔断器限制单会话单位时间生成次数;注入只来自"一次自然停"或"一次用户点选",不要引入会自动重复注入的路径。
8. **状态持久化**:`WAITING_USER` 落盘到 `paths.stateFile`,重启后 `restoreState` 恢复(恢复时**不设表情基线**,使宕机期间的点选也生效)。改等待态的地方记得 `persistState()`。
9. **外部命令经 `execFile` 数组传参**,不拼 shell(避免 markdown/特殊字符注入)。
10. **dws 失败不许硬刚**:poller 按错误分类退避——`network`/`unknown` 指数退避(封顶 `poll.maxBackoffMs`),`auth`/`pat` 暂停轮询、每 `poll.authPauseMs` 才探测一次并弹本机通知,恢复后自动继续。新增任何"循环调 dws"的路径都必须接入这套退避,**绝不能在鉴权失效时仍每 2s 调用**(会触发 dws 拉浏览器 + 烧调用)。
11. **等待态会老化**:`WAITING_USER` 超 `timeouts.staleWaitMs`(默认 6h)无人点选即作废(`expireStaleWaits`,在 `getContext` 里跑),否则一旦有等待 poller 永久轮询。
12. **通知策略(精简后)**:macOS 本机通知**只剩失败告警**——`poller` 鉴权失效、`pushAndWait` 推送失败时用 `macNotifyThrottled` 弹一条(限频),提醒你 dws 出问题需人工介入(此刻钉钉发不出,只能靠本机)。**原"空闲提醒 / 点击切回通知"已删除**(连同 `maybeIdleNotify`/`buildSwitchCommand`/`macNotifyClickable` 与 `notify.idleSwitch` 配置)——桌面控件(挂件)已覆盖"看哪些会话在等 + 点击切回",不再需要。`notify.onlyWhenLocked` 仍只对钉钉推送生效;`notify.terminalBundleId` 留给挂件点击切回时激活终端用。
13. **展示态是纯旁路,不得反向影响控制流**:`ActivityTracker`(`src/status/activityTracker.ts`)只在 `daemon.onHook` 顶部被 `observe(h)` 调一下,读 hook、只写自己的 map。它**绝不**触发注入/推送/锁屏门控/轮询,也**不**读写 `SessionManager` 的控制状态机(`IDLE/WAITING_USER…`)——两套状态各自独立。这样它就能安全地吃 `PreToolUse/PostToolUse/SessionStart/SessionEnd` 这些高频/全量事件而不会扰动安全关键逻辑。状态映射:`SessionStart→waiting_input`、`UserPromptSubmit→thinking`、`PreToolUse→running`(带 `currentTool`+`toolDetail`,复用 `describeToolUse`)、`PostToolUse→thinking`、`Stop→waiting_input`、`Notification(permission_prompt)→waiting_permission`、`SessionEnd→`移除。**移除会话的三条路径**:(1) 收到 `SessionEnd` 立即删;(2) daemon 每 `REAP_MS`(2s)调 `tmux.listPaneInfo` 批量取活 pane,`syncPanes` 删掉「有 pane 但连续 `MISS_LIMIT`(2)次探活都缺席」的会话(关窗口/kill 后 ~4s 消失,连续计数防瞬时 tmux 读偏差误删)——tmux 报错时跳过本轮、绝不误删;(3) `snapshot()` 兜底剔除 `STALE_MS`(12h)无事件的会话(无 pane 的非 tmux 会话靠它清)。**命名(展示用)**:列表名优先 **tmux session 名** + 启动目录;`syncPanes` 顺带用 **pane `current_path`** 权威覆盖 `cwd`(稳定的启动目录),**因为 hook 的 `cwd` 会随 Claude `cd` 漂移**(踩过:会话名漂成子目录 `api-test`)。挂件按末级目录命名,重名时补一层父级。**持久化**:展示态落盘到 stateFile 同目录的 `activity.json`(变更防抖写 + 退出时 `saveNow`),daemon 重启时 `load()` 恢复,死会话随后由 reaper/STALE_MS 清掉——解决"重启后列表丢会话"。**注意 reaper 只更新/移除已有会话、不新增**:会话身份只来自 hook,空闲且 daemon 启动前就存在的会话靠持久化补;activity.json 被误清后需等会话再发 hook 才回来。数据出口:`GET /status`(快照)与 `GET /events`(SSE,展示态变化即推一帧);桌面控件(`ubersicht/claude-sessions.jsx`)2s 拉一次 `/status`。**新增任何展示需求都从这条旁路走,别去动状态机。**
14. **点击切回会话(`POST /switch?session=`)跨全屏 Space 靠 Dock 菜单**:挂件点卡片 → `daemon.switchToSession`:(a) `tmux select-pane` 在目标 session 里选中 pane;(b) `setSessionTitle` 把该 session 的 ghostty 窗口标题设成 **session 名**(`set-titles on` per session)+ `refresh-client` 推下去;(c) `focusWindowViaDock`(`src/mac/notify.ts`)用**公开 AX 驱动 Dock 图标的窗口菜单**、按标题点中目标窗口——**Dock 菜单能列出跨所有 Space(含原生全屏)的窗口**,这是关键:`windows of process` 只看当前 Space,AXRaise 跨不了全屏 Space,而 Dock 菜单可以。失败(无 Accessibility / 菜单没就绪)才退化为 `activateApp`(`open -b`,只能切到 app 最前窗口)。**不用任何私有 CGS API、不动 SIP**;但需 daemon 有 Accessibility 权限(授给 plist 里的 node 真实路径)。`focusWindowViaDock` 内部**轮询等菜单就绪**(固定 delay 会偶发 `-1719`)。副作用:窗口标题被打成 session 名(顺带当标签用)。

## 实测得到的环境约束(踩过的坑)

- `$TMUX_PANE` 形如 `%6`,含 `%` → 走 **HTTP header**(不能放 URL,会被当百分号转义)。
- hook 脚本 curl 必须 `--noproxy '*'`:用户机器常设 `http_proxy`,否则 localhost 也被代理拦截(502)。
- transcript(`~/.claude/projects/<proj>/<session>.jsonl`):assistant 行 `.type=="assistant"`,文本在 `.message.content[]|select(.type=="text").text`;有大量纯 tool_use 的空文本 assistant 行。
- launchd PATH 极简:plist 的 PATH 指向**真实 node 目录**(同目录含 asdf 全局装的 `dws`)+ `/opt/homebrew/bin`(tmux)+ `/usr/sbin`(ioreg),绕开 asdf shim。重装服务要先 bootout、轮询卸载完再 bootstrap(+重试),否则 `bootstrap failed: 5: I/O error`。**实测 `install-service` 偶尔不真重启**(旧进程没退、新进程没起),改完代码若没生效,手动 `launchctl bootout gui/$UID/com.claude-notifier.daemon` + `pkill -f claude-notifier/src/index.ts` + 重新 `install-service`。
- **launchd 下 `tmux -F` 格式里的 `\t` 会退化成空格**(同样代码在交互 shell 里是真 tab):`#{pane_id}\t#{session_name}` 在 daemon 里输出变成空格分隔,`split('\t')` 失配 → 整行成了一个字段。故 `listPaneInfo` 改用**空格分隔 + 按位置切**(pane/session 无空格,path 取剩余)。新写"daemon 里跑 tmux 并解析多字段"的代码都别依赖 `\t`。
- dws:群消息 `send` 必须 `--title`;`list` 必须 `--time` 起始;`send` 返回 `open_taskId` 与 `list` 的 `openMessageId` **不同源**(故按正文 marker 定位推送消息);`send` 需一次性永久授权 scope `chat.message:send`。
- **dws 鉴权(源码实证,踩过的大坑)**:登录只有 OAuth 扫码/设备流,**不支持 AppKey/AppSecret**;access ~2h、refresh ~30 天,自动静默续期。失败时 dws 把结构化错误写 **stderr** 且退出码非零(`not_authenticated`→exit 2;PAT 行为授权不足→exit 4),**stdout 为空**——所以必须解析 stderr+exitCode 分类(`dwsClient.classifyExecError`),否则只能看到含糊的"调用失败"。曾出事故:周末 token 失效后 dws 每次调用都拉起浏览器登录页,叠加 poller 无退避每 2s 狂刷 → 一天上万次、满屏鉴权页。
- **host-owned PAT 模式**:`dwsClient` 对每次调用注入 `DINGTALK_DWS_AGENTCODE`(=`dingtalk.agentCode`),使 dws 命中 PAT 墙时返回结构化 JSON(exit 4)而**不拉浏览器/不轮询**(见 dws `internal/auth/channel.go`+`pat_auth_retry.go`)。配套:`dws pat browser-policy --enabled=false` + `dws pat chmod ... --grant-type permanent`。
- launchd 的 `StandardOut/ErrPath` 必须指向**独立文件**(`daemon.out.log`),不能指向 app 自己写的 `daemon.log`——否则 logger 既写 stderr 又 appendFile、launchd 再把 stderr 重定向进同一文件,每行重复两遍。

## 约定

- 代码与注释用中文(与现有风格一致);提交信息英文、结尾带 Co-Authored-By。
- `config.json` 被 gitignore;改 schema 同步更新 `config.example.json`(schema 有默认值,旧 config 缺字段也能跑)。
