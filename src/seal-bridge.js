/**
 * 骰桥 —— 夹在「真协议端」和「海豹」中间的一层 OneBot 转接（2026-10-20 加）。
 *
 * ## 为什么需要它
 *
 * 用户要的效果：**海豹正常接 IM（按真实 QQ 号区分人、存角色卡数据）**，
 * 但**海豹发出去的话要由小祥来发**（原样一行 + 再加一句符合人设的吐槽）。
 *
 * 两条捷径都试过、都不通：
 *   · ① 让海豹照常发、小祥"看见后补一句" —— **协议端不回推自己号发的消息**，
 *        小祥日志里 `[收到] …（机器人自己的号）：` 命中 0，她根本看不见 ✗
 *   · ② 轮询海豹的 `/sd-api/dice/recentMessage` —— 那只返回 **HTTP 端点（UIEndpoint）**
 *        的队列，海豹接 IM 后走的是 gocq 适配器，压根不进那个队列 ✗
 *
 * ## 它做什么
 *
 * ```
 * 真协议端 (203.0.113.5:3001)  ←→  【本文件】  ←→  海豹（addGocqSeparate 连本机 38021）
 *                                       │
 *                                       └─ 海豹的 send_* 不往上游发，转给小祥去说
 * ```
 *
 * - **上游 → 海豹**：`post_type` 事件原样转发（海豹靠它认人、记数据）。
 * - **海豹 → 上游（查询类）**：`get_login_info` / `get_group_list` / `get_msg` …原样转发，
 *   把上游的响应按 `echo` 回给海豹。
 * - **海豹 → 上游（发送类）**：`send_group_msg` / `send_private_msg` / `send_msg`
 *   **拦下**，转给小祥的 `/api/seal-say`；对海豹回一个假的成功响应（它只要 `retcode: 0`）。
 *
 * ⚠️ 小祥发出去的那条会再被上游广播回来 → 也转给海豹 → 海豹自己会丢弃同号消息
 *   （`platform_adapter_gocq.go` 里 `msg.Sender.UserID == ep.UserID` 那条），**不构成回路**。
 *
 * ## 跑法
 *
 * ```
 * node src/seal-bridge.js
 * ```
 * 环境变量（可选）：`SEAL_BRIDGE_UP`（上游 ws，默认读 accounts 的 onebot.url）、
 * `SEAL_BRIDGE_PORT`（本地监听，默认 **38021**）、`SEAL_SAY_URL`（小祥接口，默认 3099）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import yaml from 'js-yaml';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 日志：**自己写文件**，不依赖 `cmd` 的重定向。
 *
 * ⚠️ 2026-10-20 踩过：第一版用 WMI 起 `cmd /c cd … && node src\seal-bridge.js >> logs\__bridge.log`，
 *    结果 cmd 一收到信号就把 node 一起带走了（日志里只剩一个 `^C`），
 *    海豹随后连 3002 失败、重试 5 次后**主动放弃**（"连接重试次数过多，先行中断"）✗
 *    ⇒ 现在改成：node 自己追加日志 + 用 `start /min` 起，进程不再挂在 cmd 底下。
 */
const LOG_FILE = path.join(ROOT, 'logs', '__bridge.log');
const log = (...a) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* 写不了文件也别让桥挂掉 */
  }
  console.log(line);
};

/** 从 accounts/<主号>.yml 读上游地址和 token（不打印 token） */
function upstreamConfig() {
  const cfgPath = path.join(ROOT, 'config.yml');
  const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) ?? {};
  const main = String(cfg.mainAccount ?? cfg.botQQ ?? '').trim();
  const acctPath = main ? path.join(ROOT, 'accounts', `${main}.yml`) : '';
  let ob = {};
  if (acctPath && fs.existsSync(acctPath)) {
    ob = (yaml.load(fs.readFileSync(acctPath, 'utf8')) ?? {}).onebot ?? {};
  }
  const url = String(process.env.SEAL_BRIDGE_UP ?? ob.url ?? '').trim();
  const token = String(ob.accessToken ?? '').trim();
  if (!url) throw new Error('没有上游地址：accounts/<主号>.yml 的 onebot.url 是空的');
  return { url, token };
}

/** 这些是「海豹要往外说话」的 action —— 一律拦下，交给小祥 */
const SEND_ACTIONS = new Set(['send_group_msg', 'send_private_msg', 'send_msg', 'send_group_forward_msg']);

const { url: UP_URL, token: UP_TOKEN } = upstreamConfig();
// ⚠️⚠️ 2026-10-20 换过两次默认端口，都是**撞上了真进程**，记在这里免得再试：
//    · 3002 —— 一开始用的，用户说容易被别的东西占；
//    · 4001 —— 实测被 **QQ.exe**（`<QQ安装目录>\QQ.exe`）占着 ⇒ EADDRINUSE，
//      桥起来就崩（日志只有一行"骰桥启动"）。
//    ⇒ 现在用 **38021**（高位、不落在 QQ / 常用服务那一段）。
//    仍然可以用环境变量 `SEAL_BRIDGE_PORT` 覆盖。
//    ⚠️ 换端口之后**海豹那边的端点也要一起改**（`connectUrl` 指向新端口），
//       否则它连的还是旧端口 —— 步骤见 `SealDice/NOTES.md`。
const PORT = Number(process.env.SEAL_BRIDGE_PORT) || 38021;
const SAY_URL = String(process.env.SEAL_SAY_URL ?? 'http://127.0.0.1:3099').replace(/\/+$/, '');

/** 海豹那边的连接（正常只有一个） */
const diceClients = new Set();
/** 已转发给上游、还没回来的 echo → { from } —— 回来时按 echo 送回去 */
const pending = new Map();
/** 我们自己发出去的 echo 前缀，用来和"上游主动推送的事件"区分 */
let seq = 0;

// ════════════════════════════════════════════════════════════
// ① 连上游（真协议端）
// ════════════════════════════════════════════════════════════
let up = null;
let upReady = false;

function connectUpstream() {
  up = new WebSocket(UP_URL, {
    headers: UP_TOKEN ? { Authorization: `Bearer ${UP_TOKEN}` } : {},
  });

  up.on('open', () => {
    upReady = true;
    log(`已连上上游 ${UP_URL}`);
  });

  up.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    // 有 echo 且是我们转发的 → 送回给发起它的海豹连接
    if (msg.echo && pending.has(msg.echo)) {
      const { from } = pending.get(msg.echo);
      pending.delete(msg.echo);
      try {
        from.send(JSON.stringify(msg));
      } catch {}
      return;
    }
    // 没有 echo（上游主动推送的事件）→ 广播给海豹
    const text = JSON.stringify(msg);
    for (const c of diceClients) {
      try {
        c.send(text);
      } catch {}
    }
  });

  up.on('close', () => {
    upReady = false;
    log('上游断开，3 秒后重连…');
    setTimeout(connectUpstream, 3000);
  });

  up.on('error', (e) => {
    log(`上游出错：${e.message}`);
  });
}

// ════════════════════════════════════════════════════════════
// ② 本地服务端（海豹连过来）
// ════════════════════════════════════════════════════════════
// ⚠️⚠️ 2026-10-20 修（换到 4001 之后海豹一直 state=2 连不上）：
//    原来 `new WebSocketServer({ port })` 监听的地址是 **`::`（IPv6）**，
//    而海豹连的是 **`ws://127.0.0.1`（IPv4）** —— 这台机器上 IPv4 连 `::` 直接被挂断：
//      · `ws://127.0.0.1:4001/` → `socket hang up` ✗
//      · `ws://localhost:4001/` / `ws://[::1]:4001/` → OK ✓
//    ⇒ **显式绑 IPv4**（海豹那一侧的 connectUrl 也是 127.0.0.1，两边口径一致）。
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

wss.on('listening', () => log(`骰桥在听 ws://127.0.0.1:${PORT}/  （海豹用 addGocqSeparate 连这里）`));

wss.on('connection', (ws) => {
  diceClients.add(ws);
  log('海豹已连上');

  ws.on('message', (raw) => {
    let req;
    try {
      req = JSON.parse(String(raw));
    } catch {
      return;
    }
    const action = String(req.action ?? '');
    const echo = req.echo ?? `b${++seq}`;

    // ── 发送类：拦下来交给小祥 ──
    if (SEND_ACTIONS.has(action)) {
      const p = req.params ?? {};
      const gid = p.group_id ?? p.user_id ?? '';
      const text = extractText(p);
      const isGroup = action === 'send_group_msg' || action === 'send_group_forward_msg' || !!p.group_id;
      log(`拦截海豹的 ${action} → 群/人 ${gid}：${String(text).slice(0, 60)}`);
      relayToBot({ group_id: isGroup ? String(gid) : '', user_id: isGroup ? '' : String(gid), text })
        .catch((e) => log(`交给小祥失败：${e.message}`));
      // 对海豹回一个"成功"（它只看 retcode，不信的话会重试/报错）
      try {
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 0 }, echo }));
      } catch {}
      return;
    }

    // ── 查询类 / 其它：转发给上游，回来的响应按 echo 送回 ──
    if (!upReady) {
      try {
        ws.send(JSON.stringify({ status: 'failed', retcode: 100, data: null, echo, wording: '上游未连接' }));
      } catch {}
      return;
    }
    const outEcho = `up${++seq}`;
    pending.set(outEcho, { from: ws });
    try {
      up.send(JSON.stringify({ ...req, echo: outEcho }));
    } catch (e) {
      pending.delete(outEcho);
      log(`转发 ${action} 失败：${e.message}`);
    }
  });

  ws.on('close', () => {
    diceClients.delete(ws);
    log('海豹断开（等它自己重连）');
  });
  ws.on('error', (e) => log(`海豹连接出错：${e.message}`));
});

/** 从 OneBot 的 message/messages 里取纯文本（够用即可：海豹发的都是文本） */
function extractText(p) {
  const seg = p.message ?? p.messages ?? '';
  if (typeof seg === 'string') return seg;
  if (Array.isArray(seg)) {
    return seg.map((s) => (s?.type === 'text' ? String(s?.data?.text ?? '') : `[${s?.type ?? '?'}]`)).join('');
  }
  return '';
}

/** 把海豹的原文交给小祥：小祥负责「原样发 + 补一句吐槽」 */
async function relayToBot({ group_id, user_id, text }) {
  const res = await fetch(`${SAY_URL}/api/seal-say`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id, user_id, text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

connectUpstream();
log('骰桥启动');
