# claude-notifier — 钉钉远程驱动本地 Claude Code

## Context（为什么做这个）

Mac 锁屏离开时，本地正在跑的 Claude Code 经常停下来等人输入（权限确认 / 下一步指令），
人不在电脑前就只能干等，回来才发现它早就卡住了。本项目让你用**手机钉钉**远程把它"推一把"：

> Claude 停下等输入 → 钉钉收到一条「状态摘要 + 2~3 个建议选项」→ 手机上**点一下表情**（或回个数字）
> → 选项被注入回**同一个**正在运行的 session → Claude 继续干活。

目标是"轻量级遥控"：锁屏通知上一指点一下就能驱动，不需要远程桌面/SSH 进去敲命令。

仓库当前为空（greenfield），用 Node/TypeScript 实现一个常驻 bridge 守护进程。

## 已实测验证的事实（地基，均在本机跑通）

**钉钉侧（dws v1.0.32，已全局安装并登录授权）：**
- 专用单人群已建好：`openConversationId = cidkHX710+lPK4azBGUDnQiMw==`；用户 userId=`chongjie.yuan`，显示名「袁崇杰」，corpId `ding5639...`。
- 出站推送：`dws chat message send --group <id> --title <必填> --text <md> --yes` → 返回 `{result:{open_taskId}}`。需一次性**永久授权** scope `chat.message:send`（已授权）。
- 入站读取：`dws chat message list --group <id> --time "YYYY-MM-DD HH:MM:SS" --forward false --limit N --format json` → `messages[]:{content,createTime,openMessageId,sender,senderOpenDingTalkId,emotionReplyList?}`；**`--time` 起始时间必填**否则返回空。
- **关键约束**：推送消息与手机回复的 `senderOpenDingTalkId` 相同（都是你），不能靠 sender 区分；且 send 返回的 `open_taskId` 与读取的 `openMessageId` **不同源**，无法用 id 对上自己发的消息 → 去重必须靠 openMessageId 集合 + 时间水位 + 出站内容指纹。
- **表情 reaction 可轮询**：点文字表情后挂在被回复消息的 `emotionReplyList:[{emoji,replyUsers:[名字]}]` 上（非新消息）；自定义表情名原样出现（已验证自定义「1」→ `emoji:"1"`）；列表**累积**（done+1 并存）且无单条时间戳 → 检测"新表情"必须对该消息 emoji 集合做**差集**。可用 `dws chat message add-emoji` 预置候选表情。
- token：access ~2h / refresh 30 天，dws 自动续；>30 天没用才需重登。

**Claude Code 侧：**
- 触发用 `Notification` hook，matcher `idle_prompt`（等输入）/`permission_prompt`（等权限）；`Stop` hook 作兜底（payload 有 `stop_hook_active`）。payload 均含 `session_id`/`transcript_path`/`cwd`/`hook_event_name`。
- hook 配在 `~/.claude/settings.json` 的 `hooks.{Event}:[{matcher,hooks:[{type:"command",command}]}]`。用 **command 类型 shell 脚本**（而非 http 类型），以便脚本能捕获 `$TMUX_PANE` 环境变量（hook 子进程从 Claude 所在 pane 继承），把 `{payload + tmuxPane}` POST 给 daemon → **session_id↔pane 零配置自动映射**。
- transcript 是 JSONL（已验证真实结构）：assistant 行 `.type=="assistant"`，文本在 `.message.content[]|select(.type=="text").text`，带 `.timestamp`/`.uuid`。取最后一条 assistant 文本：`jq -rc 'select(.type=="assistant")|.message.content[]?|select(.type=="text")|.text' f.jsonl|tail -1`。
- **无原生注入手段**；`tmux send-keys -t <pane> -l "<text>"` + `send-keys Enter` 是唯一路。tmux 3.6a 已装。Claude 以原生 `claude` 启动、跑在具名 tmux pane 里（无 wrapper）。

## 架构与模块

单个常驻进程，内部：HTTP HookServer（收 hook）+ 全局 Poller（轮询钉钉）+ SessionManager（按 session_id 路由）。dws 与 tmux 均通过 `child_process.execFile`（数组传参，不走 shell，避免 markdown/特殊字符转义问题）。

```
claude-notifier/
  package.json  tsconfig.json  config.example.json
  bin/claude-notifier-hook        # POSIX sh：读 stdin payload + $TMUX_PANE，curl POST 给 daemon（fire-and-forget，-m 2 || true 永不阻塞 Claude）
  src/
    index.ts                      # CLI: start | install-hooks | status
    config.ts logger.ts daemon.ts # 配置/日志（脱敏 token）/进程编排与生命周期
    hooks/  hookServer.ts hookTypes.ts installHooks.ts
    session/ sessionManager.ts session.ts states.ts cycle.ts   # 状态机 + 单轮选项生成（sentinel/水位/重试）
    dingtalk/ dwsClient.ts dwsTypes.ts push.ts poller.ts inboundDedup.ts
    tmux/    tmuxClient.ts         # sendKeys / hasPane（display-message -p）/ capturePane
    options/ metaPrompt.ts optionsSchema.ts(zod) transcript.ts
    types.ts
```
依赖最小：`zod`（校验）+ 轻量 logger，不引钉钉 SDK。

## 核心一：状态机（防 meta-prompt 注入死循环）

每次注入（meta-prompt 或用户选项）都会让 Claude 跑一轮再次触发 Stop/idle hook，hook 层面三种"停"无法区分。用**两个独立信号同时**判定：

1. **状态门**：`IDLE`（等自然停）/ `GENERATING_OPTIONS`（已注入 meta-prompt，等选项 JSON）/ `WAITING_USER`（已推送，轮询用户选择）/ `INJECTING`+`COOLDOWN`（注入后短暂吞掉回声 hook）。
2. **sentinel + transcript 水位**：注入 meta-prompt 时记录当前 assistant 轮数 N，并在 meta-prompt 里嵌入唯一 `CN_OPTIONS_<cycleId>` sentinel。收到 `GENERATING_OPTIONS` 下的 Stop 时，要求 transcript 轮数 > N **且** 新 assistant 文本含 sentinel **且** JSON 可解析——否则视为陈旧/中间停而忽略。

关键转移：
- IDLE + （idle/Stop hook，pane 有效） → GENERATING_OPTIONS：注入 meta-prompt，记 N/sentinel，启动生成超时。
- GENERATING_OPTIONS + Stop（轮数↑ + sentinel + JSON 合法） → WAITING_USER：解析 OptionSet，推钉钉，`add-emoji` 预置候选表情，记 pushedMessageId + 基线 emoji 集，启动等待超时。
- GENERATING_OPTIONS + （非法且有重试） → 重注入（retry--）；（非法且无重试 / 生成超时） → WAITING_USER 用**固定兜底选项**（继续/停止）。
- WAITING_USER + 合法选择 → INJECTING：`send-keys` option.injectText + Enter，清 pushedMessage，启动 cooldown。
- INJECTING/COOLDOWN（cooldown 内的回声 hook）→ 吞掉；cooldown 结束 → IDLE。
- 任意态 + pane 丢失 → 推错误提示，回 IDLE，丢弃映射等下次 hook 重绑。
- WAITING_USER 期间又来"带新轮次的自然停"（如用户解锁后直接在终端敲了）→ 作废旧选项，转 GENERATING_OPTIONS 重开一轮。

## 核心二：入站轮询 + 去重

全局轮询，间隔默认 ~2s。`since = min(watermark-slack, 活跃pushed消息createTime-slack)`（确保旧 pushed 消息上的迟到表情不漏），`forward false`。dedup 状态：`watermark`（最大 createTime）、`processedMessageIds`（LRU≤500）、`emojiSeen: Map<msgId, Set<emoji>>`。

- **文本回复（数字兜底）**：跳过已处理 id；靠**出站内容指纹**（每条推送 title 带 `[CN]` 前缀，含 sessionId/cycleId）识别并跳过 daemon 自己的消息（因 push id 与 read id 不同源，不能用 id 匹配）；其余短文本（`1`/`2`/`3`/标签）→ 发 `text` 事件。
- **表情（主）**：对带 emotionReplyList 的消息，`current = {emoji | replyUsers 含「袁崇杰」}`（预置候选表情 replyUsers 为空，天然排除）；`new = current \ 上次集合（基线=预置集）`，新增 emoji → 发 `emoji` 事件；更新 emojiSeen。表情不改 createTime，故活跃 pushed 消息**每轮都扫**，不受 watermark 影响。
- **多输入/竞态**：按 createTime 排序，WAITING_USER 下第一个映射成功的选择胜出 → INJECTING，之后该消息选项已清，后续忽略（"第一下点击生效"）。

## 核心三：hook 投递与脚本

本地 HTTP server `127.0.0.1:8787`（选 HTTP 而非 unix socket：curl 到 localhost 最通用，且 command 脚本能捕获 `$TMUX_PANE`）。hook 脚本读 stdin payload，把 `$TMUX_PANE` 与 event 作为 query 参数，`curl -m 2 ... || true` POST（永不阻塞/失败 Claude 的轮次）。server 收到后解析 Claude payload + pane → `IncomingHook` → SessionManager；按 `(session_id, event, transcript mtime/轮数)` 去重以吸收 curl 重试与多 matcher 重复触发。`install-hooks` 子命令负责把这段写进 settings.json（注入 CN_PORT），并为 `Notification`（idle_prompt/permission_prompt）与 `Stop` 注册。

## 核心四：meta-prompt 与选项契约

meta-prompt（注入文本）要求 Claude **只输出**一个 ```json 块：
`{"sentinel":"CN_OPTIONS_<cycleId>","summary":"<=200字","options":[{"key":"1".."3","label":"短标签","injectText":"被选中时原样注入的文本"}]}`，2~3 个选项。

zod 校验：从 N 轮之后的 assistant 文本提取 ```json``` 块 → parse → schema 校验 → 断言 sentinel 匹配；失败按状态表重试/兜底。
选择→注入：表情名/数字 → key → `option.injectText` → `tmux send-keys -t <pane> -l <injectText>` 然后单独 `send-keys Enter`（`-l` 字面模式避免把内容里的词当按键名）。固定兜底：`继续/停止`。

## 配置（config.json 要点）

`dingtalk.openConversationId/userId/userDisplayName/dwsBin/pushTitlePrefix("[CN]")`；`poll.intervalMs(2000)/overlapSlackMs(5000)/listLimit(20)`；`hookServer.port(8787)`；`tmux.sendKeysEnterDelayMs(150)/paneOverride(null=自动)`；`emojis.candidates(["1","2","3"] 顺序映射到 option key，用自定义文字表情)`；`options.retryOnInvalid(1)`；`timeouts.generationMs(60000)/userWaitMs(1800000)/cooldownMs(1500)`；`paths.logFile/stateFile`。

## 边界与失败处理（择要）

- 回复在 Claude 还在跑时到达 / 无活跃选项 → 忽略。
- dws 鉴权失败 → 退避重试、`status` 标 degraded；>30 天需手动 `dws login`（daemon 给明确提示，自身无法修复）。
- pane 丢失 → 每次注入/起轮前 `hasPane` 校验，缺失则推提示并复位。
- JSON 校验失败 → 重试一次 → 固定兜底；生成超时同样兜底，防止模型不配合卡死。
- 预置表情/daemon 自身反应永不被当用户输入（基线集 + replyUsers 名字过滤）。
- daemon 重启：可选 stateFile 持久化 watermark/processedIds/进行中状态（MVP 可先简单地把 watermark 复位为 now）。
- injectText 多行/特殊字符：一律 `-l` 字面，仅末尾发一次 Enter，避免提前提交。

## MVP 里程碑（最薄垂直切片优先）

- **M0 脚手架**：package.json/tsconfig/zod/logger/config；`dwsClient.send/list` 与 `tmuxClient.sendKeys/hasPane` 封装 + 手动冒烟。
- **M1 单向推送**（最薄切片）：install-hooks 写 settings.json；hook 脚本 POST payload+pane；HookServer 接收；任意 Stop → 用 transcript 末条 assistant 摘要推一条 `[CN]` 钉钉。**验证 hook→daemon→钉钉 + pane 捕获**。⚠️锁屏时优先确认 `idle_prompt` 与 `Stop` 哪个真触发。
- **M2 固定选项 + 表情/数字 → 注入**：推固定"继续/停止"，预置候选表情，跑 Poller + inboundDedup，识别选择，`send-keys` 注入；落地 IDLE/WAITING_USER/INJECTING/COOLDOWN + 水位防回声。**打通完整遥控闭环（固定选项）**。
- **M3 动态选项**：加 GENERATING_OPTIONS + metaPrompt/sentinel/水位关联 + zod 校验 + 重试→兜底（最难的正确性活，被 M2 的防环机制兜底）。
- **M4 健壮性**：各类超时、dws 鉴权退避、pane 丢失、等待中陈旧停处理、`status` 子命令、可选 stateFile。
- **M5 多 session + 常驻**：验证两个 pane 并发（`[CN]` title 带 sessionId/cycleId 让表情轮询挂到正确会话）；用 launchd 做开机/掉线自启；permission_prompt 的允许/拒绝选项（延伸）。

## 验证方式（端到端）

1. M0：命令行直接调 `dwsClient`/`tmuxClient` 封装，确认能给「Claude遥控」群发消息、能 `send-keys` 进一个测试 tmux pane。
2. M1：在 tmux 里 `claude` 跑个会话，让它停下；手机确认收到 `[CN]` 通知；daemon 日志确认拿到了正确的 `$TMUX_PANE`。**重点实测锁屏下哪个 hook 触发**。
3. M2：手机点表情「1」/回数字「2」，确认对应文本被注入到那个 pane 且 Claude 继续；故意连点两下验证"第一下生效"、迟到表情不漏、自己的推送不被当输入。
4. M3：制造一次真实"等输入"，确认 Claude 按 meta-prompt 吐合法 JSON、选项推到钉钉；故意让其吐非法 JSON 验证重试→兜底。
5. 回归：`dws auth status` 临近过期时的自动续期；kill 掉 pane 看错误提示；重启 daemon 不重放旧消息。
