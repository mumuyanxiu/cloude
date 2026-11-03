@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-workspace.ps1"
if not errorlevel 1 exit /b
echo 启动失败，请检查上面的错误信息。
pause
