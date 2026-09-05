#!/usr/bin/env bash
# Build the Windows package a customer installs by double-clicking install.bat.
# Run on macOS; bun cross-compiles the binary so the customer machine needs no
# toolchain at all.
#
#   ./scripts/pack.sh <customer> <bucket> <region> <site-url>
#
# Reads the COS sub-account key and the site password from the environment so
# they never land in shell history:
#   COS_SECRET_ID=... COS_SECRET_KEY=... SITE_PASSWORD=... ./scripts/pack.sh ...
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:?用法: pack.sh <customer> <bucket> <region> <site-url>}"
BUCKET="${2:?缺少 bucket}"
REGION="${3:?缺少 region}"
SITE_URL="${4:?缺少 site-url}"
: "${COS_SECRET_ID:?请设置 COS_SECRET_ID}"
: "${COS_SECRET_KEY:?请设置 COS_SECRET_KEY}"
: "${SITE_PASSWORD:?请设置 SITE_PASSWORD（客户打开网站要输的口令）}"

OUT="$ROOT/dist/$NAME"
rm -rf "$OUT" && mkdir -p "$OUT"

cd "$ROOT"
bun test
bun build --compile --target=bun-windows-x64 ./src/publish.ts --outfile "$OUT/recorder-site.exe"
cp install.ps1 install.bat "$OUT/"

# The customer never edits this; it ships pre-filled and install.ps1 copies it
# into %APPDATA% on first run.
COS_SECRET_ID="$COS_SECRET_ID" COS_SECRET_KEY="$COS_SECRET_KEY" \
SITE_PASSWORD="$SITE_PASSWORD" BUCKET="$BUCKET" REGION="$REGION" SITE_URL="$SITE_URL" \
bun -e '
const e = process.env
await Bun.write(process.argv[1], JSON.stringify({
  password: e.SITE_PASSWORD,
  cos: { secretId: e.COS_SECRET_ID, secretKey: e.COS_SECRET_KEY, bucket: e.BUCKET, region: e.REGION },
  siteUrl: e.SITE_URL,
  uploadAudio: true,
}, null, 2) + "\n")
' "$OUT/config.json"

# ASCII filename with a UTF-8 BOM inside: Windows Explorer mangles non-ASCII zip
# entry names, and Notepad needs the BOM to read UTF-8 Chinese correctly.
printf '\xEF\xBB\xBF' > "$OUT/START-HERE.txt"
cat >> "$OUT/START-HERE.txt" <<EOF
录音笔记发布工具

安装：
  1. 把整个文件夹解压到任意位置
  2. 双击 install.bat
  3. 等待窗口显示上传进度，看到「完成」即可关闭

安装后可以删除这个文件夹。程序每 5 分钟自动检查一次，
录音笔处理完的新内容会自动发布到：
  $SITE_URL

打开网站时输入的口令，请向提供方索取。

查看运行日志（PowerShell）：
  Get-Content -Wait "\$env:LOCALAPPDATA\\recorder-site\\publish.log"
EOF

cd "$ROOT/dist" && zip -qr "$NAME.zip" "$NAME" -x '*.DS_Store'
echo "已打包: $ROOT/dist/$NAME.zip ($(du -h "$NAME.zip" | cut -f1))"
echo "站点口令: $SITE_PASSWORD  （单独告知客户，不要和安装包一起发）"
