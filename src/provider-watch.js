/**
 * 协议端自愈 —— 3001 连不上了就把协议端重新拉起来（2026-10-06 用户要求）。
 *
 * ## 为什么加
 *
 * 实测（2026-10-06 凌晨）：SnowLuma 跑了约 2 小时后**短暂抖了 1 分钟** ——
 * 那段时间 3001 没人听，机器人只能 `ECONNREFUSED` 反复重连；而协议端**进程还在**
 * （内存 105 MB、日志还在写），只是不再监听端口了。
 * 用户当时正在等回话，「为什么机器人不回」有一半就是它。
 *
 * ## ⚠️⚠️ 三条安全线（都别改）
 *
 * ① **只探端口，绝不杀任何进程。**
 *    要"找出哪个进程是协议端"就得按命令行匹配 —— 而那条路**会打中 DSH 的 runner 自己**
 *    （项目里踩过两次，见 AGENTS 的硬规矩）。所以这里**只启动、不杀**：
 *    万一旧进程其实还活着，新起的会因端口占用自己退出（无害，日志里能看到）。
 * ② **连续失败到阈值才动手**（默认 3 次 × 30 秒 ≈ 90 秒）—— 单次抖动不许碰它，
 *    否则我们会变成"抖动放大器"。
 * ③ **动手之后给足冷却**（默认 5 分钟）—— 协议端起来 + 登录本身要几十秒，
 *    冷却期内不许再打扰它。
 *
 * ⚠️ 拉起走 `provider.launcherPath()`（配置里的 launcher，SnowLuma 是那个
 *   `_start-hidden.vbs`）—— **不许自己拼命令**（NapCat 时代那个"注入根本没发生"的坑）。
 *
 * ⚠️ 还有一条**不做**的事：**不在这里重启 QQ 登录**。协议端自己会处理它自己的登录态；
 *   我们只负责"把它拉起来"。要不要扫码是它的事，**这里不下任何结论**。
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { log } from './log.js';
import * as provider from './provider.js';

const watchdog = () => config.provider?.watch ?? {};

/** 连续失败计数（每次探测成功清零） */
let fails = 0;
/** 上次动手的时间（冷却用） */
let lastReviveAt = 0;
/** 上次探测成功的时间 */
let lastOkAt = Date.now();
/** 总共拉起过几次（给界面看） */
let reviveCount = 0;
/** 远端协议端"刚断了"只提醒一次（通了会自动复位） */
let remoteWarned = false;
let timer = null;

/** 测试专用：替换探测实现（不然测试就得真开端口） */
let probeImpl = null;

/** 允许的探测超时 */
const probeTimeout = () => {
  const v = Number(watchdog().probeTimeoutMs);
  return Number.isFinite(v) && v > 0 ? v : 3000;
};

/** 连续几次失败才动手 */
const maxFails = () => {
  const v = Number(watchdog().maxFails);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 3;
};

/** 动手之后的冷却 */
const cooldownMs = () => {
  const v = Number(watchdog().cooldownMs);
  return Number.isFinite(v) && v >= 0 ? v : 5 * 60 * 1000;
};

/** 探测间隔 */
const intervalMs = () => {
  const v = Number(watchdog().intervalMs);
  return Number.isFinite(v) && v >= 5000 ? v : 30000;
};

/**
 * 探一下这个端口能不能连上（TCP 握手）。
 *
 * ⚠️ 2026-10-20 加 `host` 参数（默认本机）—— 原来**写死 127.0.0.1**，
 *    而协议端可以挂在**另一台机器**上（用户现在就 `ws://203.0.113.5:3001`）。
 *    写死本机的结果：WebSocket 明明连着、日常事件照发，这里每 30 秒报一次
 *    「3001 连不上」，还去拉本地根本不存在的 launcher ⇒ 日志全被它刷满。
 *
 * @returns {Promise<boolean>}
 */
export function probePort(port, timeoutMs = 3000, host = '127.0.0.1') {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        s.destroy();
      } catch {}
      resolve(ok);
    };
    const s = net.connect({ host, port });
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/**
 * 从 `onebot.url` 里抠主机名（`ws://203.0.113.5:3001` → `203.0.113.5`）。
 * 抠不到就当本机 —— 老配置（只写端口那种）行为不变。
 */
export function hostOf() {
  const u = String(config.onebot?.url ?? '').trim();
  try {
    const h = new URL(u).hostname;
    if (h) return h.replace(/^\[|\]$/g, '');
  } catch {}
  // 没写协议头（`127.0.0.1:3001` / `//host:port`）也要认
  const m = u.match(/(?:\/\/)?([^/:?#]+)(?::\d{2,5})/);
  return m ? m[1] : '127.0.0.1';
}

/** 这个 host 是不是"本机"（只有本机的协议端才归本机 launcher 管） */
export function isLocalHost(h) {
  const s = String(h ?? '').toLowerCase();
  return s === '127.0.0.1' || s === 'localhost' || s === '::1' || s === '0.0.0.0' || s === '';
}

/** 从 `onebot.url` 里抠端口（`ws://127.0.0.1:3001` → 3001）；抠不到就用 3001 */
export function portOf() {
  const u = String(config.onebot?.url ?? '');
  const m = u.match(/:(\d{2,5})(?!\d)/);
  return m ? Number(m[1]) : 3001;
}

/** 状态（给界面 / 日志用） */
export function status() {
  const host = hostOf();
  return {
    enable: watchdog().enable !== false,
    host,
    port: portOf(),
    /** ⚠️ 远端协议端（别的机器）本机管不了：界面/日志都按这个区分 */
    remote: !isLocalHost(host),
    fails,
    maxFails: maxFails(),
    intervalMs: intervalMs(),
    cooldownMs: cooldownMs(),
    reviveCount,
    lastOkAt,
    lastReviveAt,
    lastOkAgoMs: lastOkAt ? Date.now() - lastOkAt : null,
    /** 能不能自动拉起（launcher 配了且文件在） */
    canLaunch: provider.can('launch'),
    launcher: provider.launcherPath(),
    provider: provider.name(),
  };
}

/**
 * 用正牌的 launcher 把协议端拉起来（**独立进程**：我们这条命令马上要结束，
 * 被拉起的协议端必须活过它 —— 所以 `detached` + `cmd /c start` + `unref()`）。
 */
function launch() {
  const l = provider.launcherPath();
  if (!l) {
    log.warn('[协议端自愈] 没有配 launcher（config.yml 的 provider.dir / provider.launcher）→ 没法自动拉起');
    return false;
  }
  try {
    // ⚠️ 和 `webui.js` 的「重启机器人」同一个套路：交给一个**独立进程**去做，
    //    别在这个进程里等它（协议端起来要几十秒，等它会把机器人自己也拖住）。
    const child = spawn('cmd.exe', ['/c', 'start', '', '/min', l], {
      detached: true,
      stdio: 'ignore',
      cwd: provider.dir() || undefined,
    });
    // ⚠️⚠️ 必须接 `error`：`spawn` 的 ENOENT 是**异步事件**，try/catch 抓不到。
    //    2026-10-20 实测：本地根本没有那个 launcher 目录时，这里每次抛
    //    `spawn cmd.exe ENOENT` 的**未捕获异常**（日志里一条红字，还可能带崩进程）。
    child.on('error', (e) => log.error(`[协议端自愈] 拉起失败（${l}）：${e.message}`));
    child.unref();
    log.warn(`[协议端自愈] 已尝试拉起协议端：${l}`);
    return true;
  } catch (e) {
    log.error(`[协议端自愈] 拉起失败：${e.message}`);
    return false;
  }
}

/**
 * 探一次（定时器每 `intervalMs` 调它）。**导出来是为了测试能直接驱动它。**
 * @returns {Promise<{ok:boolean, acted:boolean, reason:string}>}
 */
export async function tick() {
  if (watchdog().enable === false) return { ok: false, acted: false, reason: '关了' };
  const host = hostOf();
  const port = portOf();
  const remote = !isLocalHost(host);
  const probe = probeImpl ?? probePort;
  // ⚠️ 第三个参数是 **host** —— 原来只传端口，探测目标写死 127.0.0.1。
  const ok = await probe(port, probeTimeout(), host);
  if (ok) {
    if (fails > 0) log.info(`[协议端自愈] ${host}:${port} 又通了（之前连续失败 ${fails} 次）`);
    fails = 0;
    lastOkAt = Date.now();
    remoteWarned = false;
    return { ok: true, acted: false, reason: '通' };
  }

  fails += 1;
  const need = maxFails();
  const gap = Date.now() - lastReviveAt;

  // ⚠️⚠️ 远端协议端（挂在另一台机器上时）：**本机的 launcher 管不到它**。
  //    这里必须提前返回 —— 否则会去 spawn 一个本机根本不存在的路径
  //    （2026-10-20 实测：日志每 30 秒一条 warn，还抛 `spawn cmd.exe ENOENT` 未捕获异常）。
  //    而且它断没断、什么时候回来，只有那台机器知道 ⇒ 本机最多记一条"刚断了"。
  if (remote) {
    if (!remoteWarned) {
      remoteWarned = true;
      log.warn(
        `[协议端自愈] 远端协议端 ${host}:${port} 连不上（它在别的机器上，本机不拉起，等它自己回来）`,
      );
    } else {
      log.debug(`[协议端自愈] ${host}:${port} 仍连不上（第 ${fails} 次）`);
    }
    if (fails >= need) fails = 0; // 计数别无限涨
    return { ok: false, acted: false, reason: '远端协议端（本机不拉起）' };
  }

  log.warn(`[协议端自愈] ${host}:${port} 连不上（第 ${fails}/${need} 次）`);
  if (fails < need) return { ok: false, acted: false, reason: `还没到阈值（${fails}/${need}）` };

  if (lastReviveAt && gap < cooldownMs()) {
    const left = Math.ceil((cooldownMs() - gap) / 1000);
    log.warn(`[协议端自愈] 到阈值了，但 ${Math.ceil(gap / 1000)}s 前刚拉过（冷却中，还有 ${left}s）→ 这次不动`);
    // ⚠️ 冷却期里**把计数清零**（重新数）—— 不然日志会打成「第 4/3 次」「第 5/3 次」，
    //    读起来像阈值算错了（第一版就是这样）。
    fails = 0;
    return { ok: false, acted: false, reason: `冷却中（还有 ${left}s）` };
  }

  // ⚠️ 动手前把头一句说清楚：**发生了什么、我要做什么、没做什么**
  log.error(
    `[协议端自愈] ${port} 连续 ${fails} 次连不上（约 ${Math.round((fails * intervalMs()) / 1000)}s）` +
      ` → 判定协议端没在听，尝试拉起（⚠️ 只启动、不杀任何进程；也没重启 QQ 登录）`,
  );
  const acted = launch();
  lastReviveAt = Date.now();
  if (acted) reviveCount += 1;
  fails = 0; // 重新数，别在冷却期内一直堆
  return { ok: false, acted, reason: acted ? '已尝试拉起' : '拉不起来（没配 launcher）' };
}

/** 启动定时探测（`index.js` 里调一次） */
export function start() {
  if (watchdog().enable === false) {
    log.info('协议端自愈：已关闭（config.yml 的 provider.watch.enable）');
    return null;
  }
  if (timer) return timer;
  const every = intervalMs();
  const host = hostOf();
  const remote = !isLocalHost(host);
  timer = setInterval(() => {
    tick().catch((e) => log.debug(`[协议端自愈] 出错：${e.message}`));
  }, every);
  timer.unref?.();
  log.info(
    `协议端自愈：每 ${Math.round(every / 1000)}s 探一次 ${host}:${portOf()}` +
      (remote
        ? '（远端协议端：只管探活、不会去拉起它）'
        : `，连续 ${maxFails()} 次连不上就拉起（冷却 ${Math.round(cooldownMs() / 60000)} 分钟；` +
          `能自动拉起=${provider.can('launch') ? '是' : '否（没配 launcher）'}）`),
  );
  return timer;
}

/** 停掉定时器（测试/重启用） */
export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 重置计数（测试用） */
export function __reset() {
  fails = 0;
  lastReviveAt = 0;
  lastOkAt = Date.now();
  reviveCount = 0;
  remoteWarned = false;
  probeImpl = null;
}

/** 测试专用：替换探测实现 */
export function __setProbe(fn) {
  probeImpl = fn;
}
