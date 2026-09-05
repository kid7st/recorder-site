#!/usr/bin/env bash
# Build the Windows installer package and the handoff prompt that goes with it.
# Run on macOS; bun cross-compiles the binary so the customer machine needs no
# toolchain at all.
#
#   ./scripts/pack.sh <customer> <bucket> <region> <site-url>
#
# Produces two artefacts that must travel separately:
#   dist/<customer>.zip        installer, contains NO credentials
#   dist/<customer>-handoff.md prompt for the customer's AI agent, contains the key
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:?用法: pack.sh <customer> <bucket> <region> <site-url>}"
BUCKET="${2:?缺少 bucket}"
REGION="${3:?缺少 region}"
SITE_URL="${4:?缺少 site-url}"
: "${COS_SECRET_ID:?请设置 COS_SECRET_ID}"
: "${COS_SECRET_KEY:?请设置 COS_SECRET_KEY}"
SITE_PASSWORD="${SITE_PASSWORD:-}"

OUT="$ROOT/dist/$NAME"
rm -rf "$OUT" && mkdir -p "$OUT"

cd "$ROOT"
bun test
bun build --compile --target=bun-windows-x64 ./src/publish.ts --outfile "$OUT/recorder-site.exe"
cp install.ps1 install.bat config.example.json "$OUT/"

# ASCII filename with a UTF-8 BOM inside: Windows Explorer mangles non-ASCII zip
# entry names, and Notepad needs the BOM to read UTF-8 Chinese correctly.
printf '\xEF\xBB\xBF' > "$OUT/START-HERE.txt"
cat >> "$OUT/START-HERE.txt" <<EOF
录音笔记发布工具

这个安装包不包含密钥。请把提供方单独发来的那段配置命令
交给你的 AI 助手执行，或者按下面的方式手动安装。

手动安装（PowerShell，在本文件夹内执行）：

  .\install.ps1 -SecretId <单独提供> -SecretKey <单独提供> \`
                -Bucket $BUCKET -Region $REGION -SiteUrl $SITE_URL

安装后可以删除这个文件夹。程序每 5 分钟自动检查一次，
录音笔处理完的新内容会自动发布到：
  $SITE_URL

查看运行日志：
  Get-Content -Wait "\$env:LOCALAPPDATA\\recorder-site\\publish.log"
EOF

cd "$ROOT/dist" && zip -qr "$NAME.zip" "$NAME" -x '*.DS_Store'

BUCKET="$BUCKET" REGION="$REGION" SITE_URL="$SITE_URL" NAME="$NAME" \
COS_SECRET_ID="$COS_SECRET_ID" COS_SECRET_KEY="$COS_SECRET_KEY" SITE_PASSWORD="$SITE_PASSWORD" \
bun "$ROOT/scripts/handoff.ts" > "$ROOT/dist/$NAME-handoff.md"

echo "安装包:   $ROOT/dist/$NAME.zip ($(du -h "$NAME.zip" | cut -f1))  — 不含密钥"
echo "交接文档: $ROOT/dist/$NAME-handoff.md — 含密钥，走安全通道单独发送"
