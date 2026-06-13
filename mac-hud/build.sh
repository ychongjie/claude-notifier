#!/bin/bash
# 编译 ClaudeSessionsHUD.swift → 组装成 .app(带 Info.plist:LSUIElement 不进 Dock、
# NSAllowsLocalNetworking 让 WKWebView 能 load 本地 http)。产物在 mac-hud/build/。
set -euo pipefail
cd "$(dirname "$0")"

APP="build/ClaudeSessionsHUD.app"
BIN_DIR="$APP/Contents/MacOS"
rm -rf "$APP"
mkdir -p "$BIN_DIR"

echo "编译…"
swiftc -O ClaudeSessionsHUD.swift -o "$BIN_DIR/ClaudeSessionsHUD" \
  -framework Cocoa -framework WebKit

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ClaudeSessionsHUD</string>
  <key>CFBundleIdentifier</key><string>com.claude-notifier.hud</string>
  <key>CFBundleExecutable</key><string>ClaudeSessionsHUD</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# 本地临时签名(ad-hoc),避免 Gatekeeper / 权限弹窗每次变身份。
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "已构建:$APP"
