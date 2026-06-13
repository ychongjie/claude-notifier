#!/bin/bash
# 卸载 HUD 自启并退出进程。
set -euo pipefail
LABEL="com.claude-notifier.hud"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
pkill -x ClaudeSessionsHUD 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "已卸载:$LABEL"
