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
  └─> src/hooks/hookServer.ts    # 本地 HTTP:POST /hook 收事件,GET /status 出状态
        └─> src/daemon.ts        # 编排:HookServer + Poller + SessionManager
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
12. **空闲提醒是独立路径**:任一 **tmux** 会话等待用户输入超 `notify.idleSwitch.afterMs`(默认 30min)且**锁屏**时,弹一条**可点击**本机通知(`maybeIdleNotify`);点击经 `terminal-notifier -execute` 跑 `buildSwitchCommand`(tmux select-window/pane + `open -b <bundleId>`)切回会话。与钉钉遥控**完全解耦**——不注入 meta-prompt、不推钉钉。要点:(a) 用 `idleTurns` 去重——**同轮数的重复 idle hook 不重置 30min 时钟**(否则 idle_prompt 反复触发会让 30min 永远走不到);(b) `UserPromptSubmit` hook → `onUserActivity` 取消计时(防"Claude 正忙"误报),注入 meta-prompt / 用户点选注入时也 `clearIdleTimer`,下一次自然停重新计时;(c) 只对有 `pane` 的会话武装(没 pane 切不过去);(d) 到点未锁屏则每 `recheckMs` 重探,直到锁屏弹一次或等待超 `staleWaitMs` 放弃;弹过一次即 `idleNotified`,不重弹。`terminal-notifier` 未装时 `macNotifyClickable` 退化为不可点击的 osascript 通知。

## 实测得到的环境约束(踩过的坑)

- `$TMUX_PANE` 形如 `%6`,含 `%` → 走 **HTTP header**(不能放 URL,会被当百分号转义)。
- hook 脚本 curl 必须 `--noproxy '*'`:用户机器常设 `http_proxy`,否则 localhost 也被代理拦截(502)。
- transcript(`~/.claude/projects/<proj>/<session>.jsonl`):assistant 行 `.type=="assistant"`,文本在 `.message.content[]|select(.type=="text").text`;有大量纯 tool_use 的空文本 assistant 行。
- launchd PATH 极简:plist 的 PATH 指向**真实 node 目录**(同目录含 asdf 全局装的 `dws`)+ `/opt/homebrew/bin`(tmux)+ `/usr/sbin`(ioreg),绕开 asdf shim。重装服务要先 bootout、轮询卸载完再 bootstrap(+重试),否则 `bootstrap failed: 5: I/O error`。
- dws:群消息 `send` 必须 `--title`;`list` 必须 `--time` 起始;`send` 返回 `open_taskId` 与 `list` 的 `openMessageId` **不同源**(故按正文 marker 定位推送消息);`send` 需一次性永久授权 scope `chat.message:send`。
- **dws 鉴权(源码实证,踩过的大坑)**:登录只有 OAuth 扫码/设备流,**不支持 AppKey/AppSecret**;access ~2h、refresh ~30 天,自动静默续期。失败时 dws 把结构化错误写 **stderr** 且退出码非零(`not_authenticated`→exit 2;PAT 行为授权不足→exit 4),**stdout 为空**——所以必须解析 stderr+exitCode 分类(`dwsClient.classifyExecError`),否则只能看到含糊的"调用失败"。曾出事故:周末 token 失效后 dws 每次调用都拉起浏览器登录页,叠加 poller 无退避每 2s 狂刷 → 一天上万次、满屏鉴权页。
- **host-owned PAT 模式**:`dwsClient` 对每次调用注入 `DINGTALK_DWS_AGENTCODE`(=`dingtalk.agentCode`),使 dws 命中 PAT 墙时返回结构化 JSON(exit 4)而**不拉浏览器/不轮询**(见 dws `internal/auth/channel.go`+`pat_auth_retry.go`)。配套:`dws pat browser-policy --enabled=false` + `dws pat chmod ... --grant-type permanent`。
- launchd 的 `StandardOut/ErrPath` 必须指向**独立文件**(`daemon.out.log`),不能指向 app 自己写的 `daemon.log`——否则 logger 既写 stderr 又 appendFile、launchd 再把 stderr 重定向进同一文件,每行重复两遍。
- **可点击通知(空闲提醒)**:osascript `display notification` 点击**无法执行命令**,故用 `terminal-notifier -execute`(可选依赖,`brew install terminal-notifier`)。`-execute` 经 `/bin/sh -c` 跑命令,所以:(1) 两次 tmux 调用之间**不能用 `\;`**(会被 sh 当命令分隔符,把 `select-pane` 当独立命令跑失败),要写成两条独立 `tmux ...; tmux ...`;(2) 命令里 tmux 用**绝对路径**(`/opt/homebrew/bin/tmux`),点击时由通知系统重启 terminal-notifier、PATH 不可靠;(3) 激活终端用 `/usr/bin/open -b <bundleId>`,对已运行的 app **只前台化、不重开实例**,全屏则切到对应 Space。`terminal-notifier` 2.x 用已弃用的通知 API,新 macOS 上**点击动作偶失灵**(通知必弹,失灵的是 click handler)。

## 约定

- 代码与注释用中文(与现有风格一致);提交信息英文、结尾带 Co-Authored-By。
- `config.json` 被 gitignore;改 schema 同步更新 `config.example.json`(schema 有默认值,旧 config 缺字段也能跑)。
