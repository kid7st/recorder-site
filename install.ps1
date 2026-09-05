# Registers the scheduled task that republishes the site after voicenote
# processes new recordings. Idempotent: re-run to update the binary or interval.
#
# Two modes, decided by what sits next to this script:
#   recorder-site.exe present -> customer install, no toolchain needed
#   otherwise                 -> development checkout, runs the sources via bun
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Task = 'recorder-site'
$Interval = if ($env:PUBLISH_INTERVAL) { [int]$env:PUBLISH_INTERVAL } else { 300 }
$ConfigDir = Join-Path $env:APPDATA 'recorder-site'
$Config = Join-Path $ConfigDir 'config.json'
$State = Join-Path $env:LOCALAPPDATA 'recorder-site'
$Log = Join-Path $State 'publish.log'

New-Item -ItemType Directory -Force -Path $State, $ConfigDir | Out-Null

# Install the binary into a stable location so the unpacked folder can be deleted.
$BundledExe = Join-Path $Root 'recorder-site.exe'
if (Test-Path $BundledExe) {
  $Exe = Join-Path $State 'recorder-site.exe'
  Copy-Item $BundledExe $Exe -Force
  $Program = $Exe
  $ProgramArgs = ''
} else {
  $Bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if (-not $Bun) { throw '未找到 bun，请先安装：powershell -c "irm bun.sh/install.ps1 | iex"' }
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) { Push-Location $Root; & $Bun install; Pop-Location }
  $Program = $Bun
  $ProgramArgs = " `"$Root\src\publish.ts`""
}

if (-not (Test-Path $Config)) {
  $Seed = if (Test-Path (Join-Path $Root 'config.json')) { Join-Path $Root 'config.json' } else { Join-Path $Root 'config.example.json' }
  Copy-Item $Seed $Config
  if ($Seed -like '*config.example.json') {
    Write-Host "已创建配置模板 $Config —— 填好 password 和 cos 后再运行本脚本"
    exit 0
  }
  Write-Host "已写入配置 $Config"
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
Write-Host "已安装：每 ${Interval} 秒检查一次，有新内容就发布"
Write-Host "正在执行首次发布，请稍候…"

# Show the customer whether it actually worked, rather than leaving them to find
# a log file. The first run uploads every recording, so it will still be going.
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
Write-Host "查看进度：Get-Content -Wait `"$Log`""
Write-Host "卸载：Unregister-ScheduledTask -TaskName $Task -Confirm:`$false"
