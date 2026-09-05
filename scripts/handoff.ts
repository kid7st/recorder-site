#!/usr/bin/env bun
/**
 * Emits the self-contained handoff prompt for a customer's AI agent.
 *
 *   BUCKET=... REGION=... SITE_URL=... COS_SECRET_ID=... COS_SECRET_KEY=... \
 *     bun scripts/handoff.ts > handoff.md
 *
 * The prompt installs from the public repo, so nothing else has to be shipped.
 */
const e = process.env
const secretId = e.COS_SECRET_ID!
const secretKey = e.COS_SECRET_KEY!
const bucket = e.BUCKET!
const region = e.REGION!
const siteUrl = e.SITE_URL!
const password = e.SITE_PASSWORD || ''
const repo = e.REPO || 'https://github.com/kid7st/recorder-site'

console.log(`# 任务：安装「录音笔记自动发布」工具

你是这台 Windows 电脑上的 AI 助手。请独立完成下面的安装，遇到问题自行诊断解决，
不要把原始报错转给用户。全部步骤在 PowerShell 中完成。

## 这是什么

这台电脑已经在运行 voicenote（命令 \`vn\`）：录音笔插上电脑后，它自动把录音
转写成文字、生成结构化摘要，存到本地工作目录。

现在要装的工具负责最后一环：把这些笔记和录音发布成网站。装好之后，用户在任何
设备上打开 ${siteUrl} 就能看到全部记录、摘要、待办和原始录音。

两个工具各自独立运行，通过本地目录交接，互不干扰。voicenote 每 60 秒扫一次
录音笔，这个工具每 5 分钟扫一次笔记目录，有变化就发布。

## 配置参数（已备好，直接用）

| 项 | 值 |
| --- | --- |
| 网站地址 | \`${siteUrl}\` |
| 存储桶 | \`${bucket}\` |
| 地域 | \`${region}\` |
| SecretId | \`${secretId}\` |
| SecretKey | \`${secretKey}\` |
| 访问口令 | ${password ? `\`${password}\`` : '无，网站直接可访问'} |

这组密钥只能向上面那一个存储桶写入和删除，读不了任何东西，也看不到别的资源。

## 第 1 步：前置检查

\`\`\`powershell
vn doctor        # voicenote 是否正常
bun --version    # 需要 1.3 以上，voicenote 依赖它，通常已装好
\`\`\`

\`vn doctor\` 必须通过再往下走，否则发布工具找不到笔记目录。
如果 \`bun\` 不存在：\`powershell -c "irm bun.sh/install.ps1 | iex"\`，然后重开终端。

## 第 2 步：获取程序

装到固定位置，之后不要移动或删除这个目录（计划任务会一直指向它）：

\`\`\`powershell
$app = "$env:LOCALAPPDATA\\recorder-site\\app"
New-Item -ItemType Directory -Force -Path (Split-Path $app) | Out-Null
Invoke-WebRequest -Uri "${repo}/archive/refs/heads/main.zip" -OutFile "$env:TEMP\\rs.zip"
Expand-Archive -Path "$env:TEMP\\rs.zip" -DestinationPath "$env:TEMP\\rs" -Force
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
Move-Item "$env:TEMP\\rs\\recorder-site-main" $app
Set-Location $app
bun install
\`\`\`

## 第 3 步：安装

\`\`\`powershell
.\\install.ps1 \`
  -SecretId '${secretId}' \`
  -SecretKey '${secretKey}' \`
  -Bucket '${bucket}' \`
  -Region '${region}' \`
  -SiteUrl '${siteUrl}'${password ? ` \`\n  -Password '${password}'` : ''}
\`\`\`

若提示脚本被禁止运行，前面加上执行策略绕过：

\`\`\`powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1 -SecretId '${secretId}' -SecretKey '${secretKey}' -Bucket '${bucket}' -Region '${region}' -SiteUrl '${siteUrl}'${password ? ` -Password '${password}'` : ''}
\`\`\`

脚本会写配置、注册每 5 分钟运行一次的计划任务、立即跑第一次发布，并打印日志末尾。

## 第 4 步：等待首次发布

**第一次会很久。** 它要上传这台电脑上的全部历史录音，可能几百 MB 到几 GB，
取决于用户积累了多少。按上传带宽算，几十分钟到几小时都属正常，不是卡死。

窗口关掉不影响，任务在后台继续。上传中断也不浪费：已完成的部分会记录下来，
下次从断点续传。

想让它只发布文字、先跳过录音，编辑 \`$env:APPDATA\\recorder-site\\config.json\`，
把 \`uploadAudio\` 改成 \`false\`，重跑一次即可；之后改回 \`true\` 再补传录音。

## 第 5 步：验证

\`\`\`powershell
Get-Content -Wait "$env:LOCALAPPDATA\\recorder-site\\publish.log"
\`\`\`

出现下面这样一行，说明已经全部同步完成：

\`\`\`
笔记 N 条 | 待上传 0 | 待删除 0 | 未变 M
\`\`\`

然后打开 ${siteUrl} 确认。${password ? `页面会要求输入口令，用上表里的那个。` : ''}

网站显示「还没有记录」是正常状态，说明 voicenote 尚未处理过任何录音，
让用户插上录音笔跑一次即可。

## 装好之后

用户不需要做任何操作。插上录音笔，voicenote 一分钟内开始处理，处理完最多再等
五分钟，网站自动更新。开机自动运行，无需登录后手动启动。

## 排障

三个入口：

- 完整日志：\`Get-Content "$env:LOCALAPPDATA\\recorder-site\\publish.log" -Tail 50\`
- 立即重试并当场看输出（比等计划任务下一轮快）：
  \`Set-Location "$env:LOCALAPPDATA\\recorder-site\\app"; bun src\\publish.ts\`
- 改配置：直接编辑 \`$env:APPDATA\\recorder-site\\config.json\`，改完重跑即可，
  不需要重新注册计划任务

常见错误：

| 现象 | 原因与处理 |
| --- | --- |
| \`未找到 workspace\` | voicenote 没配置好，先让 \`vn doctor\` 通过 |
| \`ECONNRESET\` / 连接被重置 | 这台电脑挂了代理或 VPN，腾讯云请求被拦截。关闭代理，或在代理规则里放行 \`*.myqcloud.com\`。注意：环境变量里的代理必须在启动程序前清掉，程序内部改不了 |
| \`The specified bucket does not exist\` | 桶名或地域填错，核对上表 |
| \`Access Denied\` | 密钥权限问题，本机解决不了，让用户联系提供方 |
| 计划任务不执行 | \`Get-ScheduledTask recorder-site \\| Get-ScheduledTaskInfo\` 看上次结果和下次运行时间 |
| 网站打不开或证书报错 | 服务端问题，本机解决不了，让用户联系提供方 |

表里没有的错误自行排查。只有两件事不要自己决定：**密钥的 \`Access Denied\`** 和
**网站域名无法访问**，这两项在服务端，本机改不了，请让用户联系提供方。

## 手动操作

\`\`\`powershell
cd "$env:LOCALAPPDATA\\recorder-site\\app"
bun src\\publish.ts              # 立即发布一次
bun src\\publish.ts --dry-run    # 只看会上传什么，不实际上传
bun src\\publish.ts --force      # 忽略记录，全部重传
\`\`\`

## 升级

\`\`\`powershell
cd "$env:LOCALAPPDATA\\recorder-site\\app"
Invoke-WebRequest -Uri "${repo}/archive/refs/heads/main.zip" -OutFile "$env:TEMP\\rs.zip"
# 解压覆盖后重新 bun install，配置和上传记录都会保留
\`\`\`

## 卸载

\`\`\`powershell
Unregister-ScheduledTask -TaskName recorder-site -Confirm:$false
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\recorder-site", "$env:APPDATA\\recorder-site"
\`\`\`

卸载只停止发布，已经上传到网站的内容不受影响，本地笔记也不受影响。

## 需要告知用户的两件事
${password ? '' : `
1. **网站没有访问口令**，知道网址的人都能打开全部内容。这是提供方的选择，不是遗漏。
   如果用户希望加口令，让他联系提供方，不要自行修改。
`}
${password ? '1.' : '2.'} **录音文件不加密**，存放在不可猜测的哈希路径下。拿到具体链接的人可以播放，
   但无法枚举或搜索到它们。

源码：${repo}
`)
