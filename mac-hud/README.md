# Claude Sessions HUD(置顶浮层 / 左缘抽屉)

竖屏副屏左缘的一个**置顶浮层**:平时只露一个箭头把手,点一下面板从左滑出占满竖屏宽度并钉住,再点收回。浮在所有窗口之上(含最大化 / 原生全屏),平时不占地、不干扰其他 app。

是桌面挂件(`ubersicht/claude-sessions.jsx`)之外的另一个出口,数据同源——daemon 的 `GET /panel`(自包含 HTML,内部连 `/events` SSE 实时刷新)。

## 用法

```bash
./build.sh        # 编译 Swift → 组装成 .app(产物在 build/,已 gitignore)
./install.sh      # 构建 + 装成登录自启的 LaunchAgent(com.claude-notifier.hud)
./uninstall.sh    # 卸载自启并退出
```

依赖:`swiftc`(Xcode Command Line Tools 即可)。需要 daemon 在跑(端口 8787);daemon 没起时浮层显示「未运行」,起来后自动重连。

## 可调

`ClaudeSessionsHUD.swift` 顶部常量:`HANDLE_W`/`HANDLE_H`(把手宽高)、`MAX_H`(面板高)、`TOP_MARGIN`(距屏顶,避开浏览器标题栏)、`BOTTOM_MARGIN`、`ANIM`(动画时长)。改完重新 `./build.sh && ./install.sh`(或手动重启 app)。

字号 / 卡片样式在 daemon 侧 `src/panel/panelHtml.ts`,改完需重载 daemon(`npm run cli -- install-service`)再重启 HUD 让 WKWebView 重新拉 `/panel`。

## 实现要点

- 无边框浮动 `NSPanel`:`level=.floating` + `collectionBehavior=[.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]` → 跨所有 Space(含全屏)置顶。
- `.nonactivatingPanel` + `setActivationPolicy(.accessory)`:不抢焦点、不进 Dock。
- 抽屉=滑动窗口 x:收起时内容滑到屏外左侧只露把手(停屏左缘),展开时占满全宽、把手停屏右缘。
- 打成 `.app` 是为了 Info.plist:`NSAllowsLocalNetworking`(WKWebView 才能 load 本地 http)+ `LSUIElement`(不进 Dock)。
