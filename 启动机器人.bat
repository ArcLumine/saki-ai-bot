@echo off
chcp 65001 >nul
title QQ AI 机器人
cd /d "%~dp0"

set "NODE_EXE=%~dp0node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

if not exist "node_modules" (
    echo 首次运行，正在安装依赖...
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo.
        echo 依赖安装失败。请确认已安装 Node.js 且网络正常。
        pause
        exit /b 1
    )
)

echo ============================================
echo   QQ AI 机器人启动中...
echo   停止请按 Ctrl+C
echo   日志：logs\bot.log
echo ============================================
echo.

rem ── ⚠️⚠️ 保留历史日志（沿用 _run-bot.bat 已验证的写法）──────────────
rem    为什么不直接 "> logs\bot.log"：那样窗口就**看不到日志**了，
rem    而窗口输出正是排查连接问题的主要手段。
rem    所以改为：窗口照常显示，同时让 src/log.js 落盘（SAKIBOT_LOG_FILE）。
rem    ⚠️ 清理旧日志**不准**改回 `for /f` 包重定向 —— 那个坑在 .bat 里踩过不止一次
rem       （`2^>nul` 的脱字符会被吃掉一层，cmd 把整串当成一条命令的名字）。
rem    ⚠️ 时间戳只取 %TIME% 并去掉冒号和点（纯数字，免得文件名/编码问题）；
rem       %DATE% 带中文（"周日"），在 bat 里容易踩编码坑，所以不用它。
set "STAMP=%TIME::=%"
set "STAMP=%STAMP:.=%"
if exist "logs\bot.log" move /y "logs\bot.log" "logs\bot-%STAMP%.log" >nul 2>&1
rem 只留最近 10 份：`dir /o-d` 按修改时间倒序，skip=10 跳过最新的十个，剩下的删掉
set "OLDLOG=%TEMP%\_qqbot_oldlogs.txt"
dir /b /o-d "logs\bot-*.log" > "%OLDLOG%" 2>nul
for /f "skip=10 delims=" %%f in (%OLDLOG%) do del "logs\%%f" >nul 2>&1
del "%OLDLOG%" >nul 2>&1

set "SAKIBOT_LOG_FILE=%~dp0logs\bot.log"

"%NODE_EXE%" src/index.js

echo.
echo 机器人已退出。
pause
