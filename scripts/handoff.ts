#!/usr/bin/env bun
/** Emits the handoff prompt for a customer's AI agent. Invoked by pack.sh. */
const e = process.env
const secretId = e.COS_SECRET_ID!
const secretKey = e.COS_SECRET_KEY!
const bucket = e.BUCKET!
const region = e.REGION!
const siteUrl = e.SITE_URL!
const password = e.SITE_PASSWORD || ''

const passwordArg = password ? ` \`\n                -Password '${password}'` : ''

console.log(`# 任务：安装录音笔记发布工具

你是这台 Windows 电脑上的 AI 助手。请帮用户完成一个后台工具的安装。
全程只需要 PowerShell，不需要联网安装任何依赖。

## 背景

这台电脑已经装好并运行着 voicenote（命令 \`vn\`）：录音笔插上电脑后，它会自动
把录音转写成文字并生成摘要，存到本地一个工作目录里。

现在要装的这个工具负责最后一步：把 voicenote 生成的笔记和录音发布成一个网站，
用户在任何设备打开 ${siteUrl} 就能看到全部内容。

两者各自独立运行，互不干扰。

## 前置检查

1. 确认 voicenote 正常：运行 \`vn doctor\`，应当通过。若不通过，先解决它再继续，
   否则发布工具找不到笔记目录。
2. 找到用户收到的安装包（一个 zip），解压到任意位置，例如桌面。
   解压后应当包含 \`recorder-site.exe\`、\`install.ps1\`、\`install.bat\`。

## 安装

在解压出的文件夹内打开 PowerShell，执行（配置值已填好，直接用）：

\`\`\`powershell
.\\install.ps1 \`
  -SecretId '${secretId}' \`
  -SecretKey '${secretKey}' \`
  -Bucket '${bucket}' \`
  -Region '${region}' \`
  -SiteUrl '${siteUrl}'${passwordArg}
\`\`\`

如果提示脚本被禁止运行，改用：

\`\`\`powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1 -SecretId '${secretId}' -SecretKey '${secretKey}' -Bucket '${bucket}' -Region '${region}' -SiteUrl '${siteUrl}'
\`\`\`

脚本会写入配置、注册一个每 5 分钟运行一次的计划任务、立即执行第一次发布，
并打印日志末尾。

## 首次运行会很慢

第一次发布要上传这台电脑上**全部历史录音**，可能是几百 MB 到几 GB，
取决于用户攒了多少。按上传带宽估算，几十分钟到几小时都正常。

窗口关掉不影响，任务在后台继续。上传中断也不会白费：已传的部分会被记住，
下次从断点继续，不会重传。

## 验证

\`\`\`powershell
Get-Content -Wait "$env:LOCALAPPDATA\\recorder-site\\publish.log"
\`\`\`

看到这样一行就说明已经全部同步完成：

\`\`\`
笔记 N 条 | 待上传 0 | 待删除 0 | 未变 M
\`\`\`

然后用浏览器打开 ${siteUrl} 确认能看到记录列表。

如果网站显示「还没有记录」，说明 voicenote 尚未处理过任何录音，
这是正常的，插上录音笔跑一次即可。

## 日常使用

装好之后没有任何需要操作的地方。用户把录音笔插到电脑上，
voicenote 一分钟内开始处理，处理完最多再等五分钟，网站自动更新。

## 故障排查

安装过程中出现的问题请你直接诊断并解决，不要把报错原样转给用户。三个入口：

- 看完整错误：\`Get-Content "$env:LOCALAPPDATA\\recorder-site\\publish.log" -Tail 50\`
- 立即重试并在当前窗口看输出（比等计划任务下一轮快）：
  \`& "$env:LOCALAPPDATA\\recorder-site\\recorder-site.exe"\`
- 改配置：直接编辑 \`$env:APPDATA\\recorder-site\\config.json\`，改完重跑即可，
  不需要重新注册计划任务

| 日志里的错误 | 原因与处理 |
| --- | --- |
| \`未找到 workspace\` | voicenote 没配置好，先跑 \`vn doctor\` |
| \`The specified bucket does not exist\` | 桶名或地域填错，核对上面的命令 |
| \`Access Denied\` | 密钥权限问题，联系提供方 |
| \`ECONNRESET\` / 连接被重置 | 这台电脑挂了代理（VPN），腾讯云请求被拦截。关闭代理，或在代理规则中放行 \`*.myqcloud.com\` |
| exe 双击闪退 | Windows 拦截了未签名程序。右键文件夹 → 属性 → 勾选「解除锁定」 |

表里没有的错误，自行排查。两件事不要自己决定，请让用户联系提供方：
密钥报 \`Access Denied\`，以及网站域名打不开。这两项在服务端，本机改不了。

## 卸载

\`\`\`powershell
Unregister-ScheduledTask -TaskName recorder-site -Confirm:$false
Remove-Item -Recurse "$env:LOCALAPPDATA\\recorder-site", "$env:APPDATA\\recorder-site"
\`\`\`

## 注意

上面的密钥请只写入配置文件，不要贴到聊天记录、代码仓库或任何在线文档里。
它只能向这一个存储桶写入，读不了任何东西，但仍应当作凭证对待。
${password ? '' : `
本站点未设置访问口令，知道网址的人都能打开。这是提供方的选择，不是遗漏。`}`)
