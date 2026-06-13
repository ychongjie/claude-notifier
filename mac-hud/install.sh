#!/bin/bash
# 构建 HUD 并装成登录自启的 LaunchAgent(com.claude-notifier.hud,崩溃自动重启)。
# 幂等:重复跑会先卸载旧的再装新的。卸载用 mac-hud/uninstall.sh。
set -euo pipefail
cd "$(dirname "$0")"

./build.sh

BIN="$PWD/build/ClaudeSessionsHUD.app/Contents/MacOS/ClaudeSessionsHUD"
LABEL="com.claude-notifier.hud"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/.claude-notifier"
mkdir -p "$LOGDIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/hud.out.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/hud.out.log</string>
</dict>
</plist>
PLISTEOF

# 先卸旧(忽略不存在),再装。
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
pkill -x ClaudeSessionsHUD 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$UID" "$PLIST"
echo "已安装并启动:$LABEL"
echo "plist:$PLIST"
echo "日志:$LOGDIR/hud.out.log"
