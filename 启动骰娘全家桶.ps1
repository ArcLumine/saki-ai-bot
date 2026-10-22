<#
  一键拉起「小祥 + 骰桥 + 海豹」—— 2026-10-20 用户要求。

  ## 顺序（固定，别改）

    ① 小祥（node src/index.js）    —— 只连远端协议端，先起它没问题
    ② 骰桥（node src/seal-bridge.js）—— 连协议端 + 监听 127.0.0.1:38021
    ③ 海豹（sealdice-core.exe）    —— **连的是骰桥的 38021**，所以必须在桥之后

  ## 用法

    双击 `启动骰娘全家桶.bat`
    或  powershell -NoProfile -ExecutionPolicy Bypass -File 启动骰娘全家桶.ps1
    加 -NoStart 只打印计划、不动任何进程（排查用）

  ## ⚠️ 三条硬规矩（都是真踩过的）

    1. **停进程只按「端口 / 进程名」**，绝不用 CommandLine 匹配 ——
       那种写法会打中 DSH 的 runner（它自己的命令行里就带着整段脚本）。
    2. **骰桥必须绑 127.0.0.1**（`WebSocketServer({port})` 默认监听 `::`，
       IPv4 客户端会被 `socket hang up`，海豹永远卡在 state=2）。
    3. **海豹端点的 account 必须是真实号**（不是 config.yml 里的旧 botQQ）——
       这个脚本**不自动重建端点**，只在状态不对时把排查方向打出来。
#>
param(
  [switch]$NoStart,
  [int]$WaitSec = 40
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$sealDir = Join-Path (Split-Path $root -Parent) 'SealDice'

# ── 小工具 ────────────────────────────────────────────────
function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Test-Port($port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
  } catch { return $false }
}

function Wait-Port($port, $sec, $label) {
  $deadline = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $port) { Say ("  ✓ {0} 已监听（{1}）" -f $label, $port) 'Green'; return $true }
    Start-Sleep -Milliseconds 500
  }
  Say ("  ✗ {0} 等了 {1} 秒还没监听（{2}）" -f $label, $sec, $port) 'Red'
  return $false
}

# 按端口停：**只认端口**，不碰命令行
function Stop-ByPort($port, $label) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { Say ("  · {0}（{1}）本来就没在跑" -f $label, $port); return }
    $pids = @($conns | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($p in $pids) {
      $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
      if ($proc) {
        Say ("  · 停掉 {0}（{1}）：PID {2} {3}" -f $label, $port, $p, $proc.ProcessName)
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
      }
    }
  } catch { Say ("  ! 停 {0} 出错：{1}" -f $label, $_.Exception.Message) 'Yellow' }
}

# ── 0. 路径检查 ──────────────────────────────────────────
Say ''
Say '=== 骰娘全家桶：小祥 → 骰桥 → 海豹 ===' 'Cyan'

$node = Join-Path $root 'node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
$bridgeJs = Join-Path $root 'src\seal-bridge.js'
$botJs = Join-Path $root 'src\index.js'
$sealExe = Join-Path $sealDir 'sealdice-core.exe'

foreach ($p in @($bridgeJs, $botJs)) {
  if (-not (Test-Path $p)) { Say ("✗ 缺文件：{0}" -f $p) 'Red'; exit 1 }
}
if (-not (Test-Path $sealExe)) { Say ("✗ 找不到海豹：{0}" -f $sealExe) 'Red'; exit 1 }

if ($NoStart) {
  Say ''
  Say '[-NoStart] 只打印计划，不动任何进程：' 'Yellow'
  Say ("  ① 停：3099（小祥）/ 38021（骰桥）/ sealdice-core（海豹）")
  Say ("  ② 起小祥：{0} {1}" -f $node, $botJs)
  Say ("  ③ 等 3099")
  Say ("  ④ 起骰桥：{0} {1}" -f $node, $bridgeJs)
  Say ("  ⑤ 等 38021")
  Say ("  ⑥ 起海豹：{0} /hide-ui" -f $sealExe)
  Say ("  ⑦ 等 3211 + 查端点 state")
  exit 0
}

# ── 1. 先停旧的（按端口 / 进程名，不按命令行）─────────────
Say ''
Say '[1/4] 停掉旧实例' 'Cyan'
Stop-ByPort 3099 '小祥'
Stop-ByPort 38021 '骰桥'
$oldSeal = Get-Process -Name 'sealdice-core' -ErrorAction SilentlyContinue
if ($oldSeal) {
  foreach ($p in @($oldSeal)) { Say ("  · 停掉海豹：PID {0}" -f $p.Id); Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
} else { Say '  · 海豹本来就没在跑' }
Start-Sleep -Seconds 3

# ── 2. 小祥 ──────────────────────────────────────────────
Say ''
Say '[2/4] 起小祥' 'Cyan'
Start-Process -FilePath $node -ArgumentList 'src\index.js' -WorkingDirectory $root -WindowStyle Hidden
if (-not (Wait-Port 3099 $WaitSec '小祥管理界面')) {
  Say '  小祥没起来 —— 看 logs\bot-<日期>.log 或 %TEMP%\saki-bot-console.log' 'Red'
  exit 1
}

# ── 3. 骰桥 ──────────────────────────────────────────────
Say ''
Say '[3/4] 起骰桥（海豹要连它的 38021）' 'Cyan'
Start-Process -FilePath $node -ArgumentList 'src\seal-bridge.js' -WorkingDirectory $root -WindowStyle Hidden
if (-not (Wait-Port 38021 $WaitSec '骰桥')) {
  Say '  骰桥没起来 —— 看 logs\__bridge.log（最常见：端口被别的程序占了，换 SEAL_BRIDGE_PORT）' 'Red'
  exit 1
}

# ── 4. 海豹 ──────────────────────────────────────────────
Say ''
Say '[4/4] 起海豹' 'Cyan'
Start-Process -FilePath $sealExe -ArgumentList '/hide-ui' -WorkingDirectory $sealDir -WindowStyle Hidden
if (-not (Wait-Port 3211 $WaitSec '海豹 WebUI')) {
  Say '  海豹没起来 —— 看 SealDice\data\main.log' 'Red'
  exit 1
}

# ── 5. 查海豹端点状态（只查，不自动重建）──────────────────
Say ''
Say '检查海豹的 OneBot 端点…' 'Cyan'
Start-Sleep -Seconds 4
try {
  $diceYaml = Join-Path $sealDir 'data\dice.yaml'
  $raw = Get-Content $diceYaml -Raw -ErrorAction Stop
  $m = [regex]::Match($raw, 'accessTokens:\s*\r?\n\s*-\s*(\S+)')
  if (-not $m.Success) { throw 'dice.yaml 里没有 accessTokens' }
  $tk = $m.Groups[1].Value.Trim("'`"")
  $list = Invoke-RestMethod -Uri 'http://127.0.0.1:3211/sd-api/im_connections/list' -Headers @{ token = $tk } -TimeoutSec 8
  $arr = @($list)
  if (-not $arr.Count) {
    Say '  ⚠ 海豹里**一个端点都没有** —— 要建一个：connectUrl=ws://127.0.0.1:38021/、account=真实号' 'Yellow'
  } else {
    foreach ($e in $arr) {
      $state = if ($e.state -eq 1) { '已连接' } elseif ($e.state -eq 2) { '连接中' } elseif ($e.state -eq 3) { '连接失败' } else { '断开' }
      $color = if ($e.state -eq 1) { 'Green' } else { 'Yellow' }
      Say ("  · {0}  state={1}（{2}） userId={3}" -f $e.id.Substring(0, 8), $e.state, $state, $e.userId) $color
      if ($e.state -ne 1) {
        Say '    → 连接中/失败 = 桥没起、端口不对，或者端点 account 不是真实号' 'Yellow'
      }
    }
  }
} catch {
  Say ("  ! 查端点失败（不影响使用）：{0}" -f $_.Exception.Message) 'Yellow'
}

Say ''
Say '=== 完成 ===' 'Green'
Say '  小祥   http://127.0.0.1:3099'
Say '  骰桥   ws://127.0.0.1:38021/'
Say '  海豹   http://127.0.0.1:3211'
Say ''
Say '三个都是隐藏窗口起的，关掉这个窗口不影响它们。' 'Gray'
