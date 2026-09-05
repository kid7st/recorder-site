@echo off
REM Double-clickable entry point. PowerShell blocks unsigned .ps1 files by
REM default, so the customer cannot just right-click install.ps1.
REM chcp 65001 first: the default GBK console renders the script's Chinese
REM output as mojibake, which reads exactly like a crash to a non-technical user.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
