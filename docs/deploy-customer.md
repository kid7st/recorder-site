# 交付给客户

客户机器上已经装好 voicenote 并跑通。这里只加发布环节：你在腾讯云上把桶和域名配好，打一个包给客户，客户双击安装。

客户机器不需要 bun、git、node_modules，也不需要联网装依赖。安装包里是一个自带运行时的 exe。

## 一、腾讯云侧（你操作，约 20 分钟）

### 1. 建桶

一个客户一个桶。地域按客户所在地和域名备案情况选：

- 客户在国内，域名已备案：`ap-guangzhou` / `ap-shanghai`，访问快。
- 域名没备案：`ap-hongkong`，国内能访问，慢一些。

权限设为**私有读写**。开启静态网站，索引文档 `index.html`。

### 2. 绑自定义域名

必须做。2024 年 1 月之后创建的桶，用腾讯云自己的域名访问会强制下载文件，网页打不开，音频也放不了。

在桶的 **域名与传输管理 → 自定义源站域名** 添加域名，**源站类型选「静态网站」**，然后按提示加 CNAME 解析。国内地域要求该域名已完成 ICP 备案。

配好后用浏览器打开 `https://你的域名/`，应该看到 404 而不是下载框，说明链路通了。

### 3. 建子账号密钥

**这一步不能省。** 密钥会以明文写在客户机器上的 `config.json` 里，客户能读到。用主账号密钥意味着客户拿到了你整个腾讯云账号。

CAM 控制台 → 新建子用户（仅编程访问）→ 新建自定义策略，按策略语法创建，粘贴下面的内容，替换 `APPID`、`REGION`、`BUCKET`：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "name/cos:PutObject",
        "name/cos:DeleteObject",
        "name/cos:InitiateMultipartUpload",
        "name/cos:ListMultipartUploads",
        "name/cos:ListParts",
        "name/cos:UploadPart",
        "name/cos:CompleteMultipartUpload",
        "name/cos:AbortMultipartUpload"
      ],
      "resource": ["qcs::cos:REGION:uid/APPID:BUCKET-APPID/*"]
    }
  ]
}
```

只有写和删，没有读，没有列桶，也碰不到别的桶。最坏情况是客户删掉自己的数据。

分块上传那几项是必需的，音频文件超过 5MB 就会走分块路径。

## 二、打包（你操作，一条命令）

```bash
COS_SECRET_ID=AKID... \
COS_SECRET_KEY=... \
SITE_PASSWORD='客户打开网站要输的口令' \
./scripts/pack.sh 客户名 桶名 地域 https://客户域名
```

产出 `dist/客户名.zip`，约 38MB。里面是 exe、`install.bat`、填好的 `config.json` 和一份中文说明。

**口令单独发给客户**，不要和安装包放在同一封邮件或同一个群里。安装包里的 `config.json` 含明文口令和密钥，等同于凭证。

## 三、客户操作（三步）

1. 解压到任意位置
2. 双击 `install.bat`
3. 等窗口显示上传进度

装完可以删掉解压出来的文件夹，程序已经复制到 `%LOCALAPPDATA%\recorder-site\`。

之后每 5 分钟自动检查一次，voicenote 处理完的新录音会自动发布。

**首次安装会上传全部历史录音**，取决于数据量和带宽，可能要几十分钟到几小时。窗口关掉不影响，任务在后台继续。

## 四、验收

客户机器上（PowerShell）：

```powershell
Get-Content -Wait "$env:LOCALAPPDATA\recorder-site\publish.log"
```

正常输出是 `笔记 N 条 | 待上传 0 | 待删除 0 | 未变 M`。

浏览器打开客户域名，输口令，应该看到全部记录。

## 常见问题

**双击没反应 / 闪退**：Windows 可能拦截未签名的 exe。在解压出的文件夹上右键 → 属性 → 勾选「解除锁定」，再双击。

**日志里 `The specified bucket does not exist`**：桶名或地域填错了，重新打包。

**日志里 `Access Denied`**：子账号策略的 action 或 resource 写错了，对照上面的 JSON 检查 APPID 和桶名。

**网页打开变成下载文件**：自定义域名没绑，或者源站类型选成了「默认源站」而不是「静态网站」。

**日志里 `未找到 workspace`**：客户机器上的 voicenote 没配置好，先让 `vn doctor` 通过。
