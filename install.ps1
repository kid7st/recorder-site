# Installs the scheduled task that republishes the site after voicenote
# processes new recordings. Idempotent: re-run to update the binary, the
# configuration, or the interval.
#
# Configuration can be passed as parameters (preferred: the installer package
# ships without credentials, which arrive separately):
#
#   .\install.ps1 -SecretId AKID... -SecretKey ... -Bucket name-123 `
#                 -Region ap-hongkong -SiteUrl https://example.com
#
# With no parameters it reuses an existing config, or falls back to a template.
param(
  [string]$SecretId,
  [string]$SecretKey,
  [string]$Bucket,
  [string]$Region = 'ap-hongkong',
  [string]$SiteUrl,
  [string]$Password = '',
  [bool]$UploadAudio = $true,
  [int]$Interval = 300
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Task = 'recorder-site'
$ConfigDir = Join-Path $env:APPDATA 'recorder-site'
$Config = Join-Path $ConfigDir 'config.json'
$State = Join-Path $env:LOCALAPPDATA 'recorder-site'
$Log = Join-Path $State 'publish.log'

New-Item -ItemType Directory -Force -Path $State, $ConfigDir | Out-Null

# Two modes, decided by what sits next to this script:
#   recorder-site.exe present -> customer install, no toolchain needed
#   otherwise                 -> development checkout, runs the sources via bun
$BundledExe = Join-Path $Root 'recorder-site.exe'
if (Test-Path $BundledExe) {
  # Copy into a stable location so the unpacked folder can be deleted after.
  $Exe = Join-Path $State 'recorder-site.exe'
  Copy-Item $BundledExe $Exe -Force
  $Program = $Exe
  $ProgramArgs = ''
} else {
  $Bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if (-not $Bun) { throw '未找到 bun，也未找到 recorder-site.exe' }
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) { Push-Location $Root; & $Bun install; Pop-Location }
  $Program = $Bun
  $ProgramArgs = " `"$Root\src\publish.ts`""
}

if ($SecretId -and $SecretKey -and $Bucket) {
  $cfg = [ordered]@{
    password    = $Password
    cos         = [ordered]@{ secretId = $SecretId; secretKey = $SecretKey; bucket = $Bucket; region = $Region }
    siteUrl     = $SiteUrl
    uploadAudio = $UploadAudio
  }
  # UTF8 without BOM: the publisher parses this as JSON and a BOM breaks it.
  [IO.File]::WriteAllText($Config, ($cfg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
  Write-Host "已写入配置 $Config"
} elseif (-not (Test-Path $Config)) {
  Copy-Item (Join-Path $Root 'config.example.json') $Config
  Write-Host "已创建配置模板 $Config —— 填好 cos 后再运行本脚本"
  exit 0
} else {
  Write-Host "沿用现有配置 $Config"
}

# cmd.exe wrapper only exists to append stdout/stderr to the log; Task Scheduler
# cannot redirect on its own the way launchd's StandardOutPath does.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"`"$Program`"$ProgramArgs >> `"$Log`" 2>&1`"" `
  -WorkingDirectory $State
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Seconds $Interval) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
# IgnoreNew matches launchd: the first run ships every recording ever made and
# must not be re-entered by the next tick.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $Task

Write-Host ''
Write-Host "已安装：每 $Interval 秒检查一次，有新内容就发布"
Write-Host '正在执行首次发布，请稍候…'

# Show whether it actually worked, rather than leaving the user to find a log.
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline -and -not (Test-Path $Log)) { Start-Sleep -Seconds 2 }
if (Test-Path $Log) {
  Start-Sleep -Seconds 5
  Write-Host ''
  Get-Content $Log -Tail 15
} else {
  Write-Host "尚未产生日志，稍后查看：$Log"
}
Write-Host ''
if ($SiteUrl) { Write-Host "站点：$SiteUrl" }
Write-Host "查看进度：Get-Content -Wait `"$Log`""
Write-Host "卸载：Unregister-ScheduledTask -TaskName $Task -Confirm:`$false"
