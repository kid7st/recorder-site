#!/usr/bin/env bash
# Install the LaunchAgent that republishes the site after voicenote processes new
# recordings. Idempotent: re-run after moving the repo or changing the interval.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="sh.fastagent.recorder-site"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HOME/.local/state/recorder-site"
CONFIG="$HOME/.config/recorder-site/config.json"
INTERVAL="${PUBLISH_INTERVAL:-300}"

BUN="$(command -v bun || true)"
[ -n "$BUN" ] || { echo "未找到 bun，请先安装：curl -fsSL https://bun.sh/install | bash"; exit 1; }

mkdir -p "$STATE" "$(dirname "$CONFIG")" "$(dirname "$PLIST")"
[ -d "$ROOT/node_modules" ] || (cd "$ROOT" && "$BUN" install)

if [ ! -f "$CONFIG" ]; then
  cp "$ROOT/config.example.json" "$CONFIG"
  chmod 600 "$CONFIG"
  echo "已创建配置模板 $CONFIG —— 填好 password 和 cos 后再运行本脚本"
  exit 0
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BUN</string><string>$ROOT/src/publish.ts</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$STATE/publish.log</string>
  <key>StandardErrorPath</key><string>$STATE/publish.log</string>
</dict></plist>
EOF
chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "已安装：每 ${INTERVAL}s 检查一次并发布变更"
echo "日志：tail -f $STATE/publish.log"
echo "卸载：launchctl bootout gui/\$(id -u) $PLIST && rm $PLIST"
