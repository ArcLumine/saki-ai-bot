@echo off
chcp 65001 >nul
title 启动骰娘全家桶（小祥 → 骰桥 → 海豹）
cd /d "%~dp0"

rem ⚠️ 参数原样透传（`-NoStart` 只看计划、不动进程）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动骰娘全家桶.ps1" %*

if errorlevel 1 (
  echo.
  echo 启动过程中有失败，看上面红字。
  pause >nul
)
