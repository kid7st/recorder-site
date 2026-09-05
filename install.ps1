# Windows counterpart of install.sh: registers the scheduled task that
# republishes the site after voicenote processes new recordings.
# Idempotent: re-run after moving the repo or changing the interval.
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Task = 'recorder-site'
$Interval = if ($env:PUBLISH_INTERVAL) { [int]$env:PUBLISH_INTERVAL } else { 300 }
$Config = Join-Path $env:APPDATA 'recorder-site\config.json'
$State = Join-Path $env:LOCALAPPDATA 'recorder-site'
$Log = Join-Path $State 'publish.log'

$Bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $Bun) { throw '未找到 bun，请先安装：powershell -c "irm bun.sh/install.ps1 | iex"' }

New-Item -ItemType Directory -Force -Path $State, (Split-Path $Config) | Out-Null
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  Push-Location $Root; & $Bun install; Pop-Location
}

if (-not (Test-Path $Config)) {
  Copy-Item (Join-Path $Root 'config.example.json') $Config
  Write-Host "已创建配置模板 $Config —— 填好 password 和 cos 后再运行本脚本"
  exit 0
}

# cmd.exe wrapper only exists to append stdout/stderr to the log; Task Scheduler
# cannot redirect on its own the way launchd's StandardOutPath does.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"`"$Bun`" `"$Root\src\publish.ts`" >> `"$Log`" 2>&1`"" `
  -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Seconds $Interval) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
# IgnoreNew matches launchd: the first run ships ~1GB of audio and must not be
# re-entered by the next tick.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $Task

Write-Host "已安装：每 ${Interval}s 检查一次并发布变更"
Write-Host "日志：Get-Content -Wait $Log"
Write-Host "卸载：Unregister-ScheduledTask -TaskName $Task -Confirm:`$false"
