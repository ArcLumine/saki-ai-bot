/**
 * 骰娘模式 —— 进入之后她**只应答骰点**，别的全程静默。
 *
 * ## 用户需求（2026-09-30 原话）
 *   「小祥日常的时候依旧回话，只有通过某些触发词才会触发骰娘模式，
 *     并且在当骰娘的时候全程静默」
 *   「进入骰娘模式，别人发 ra 之类的指令，她只会回复骰点结果。
 *     其他的情况下全程静默」
 *
 * ⚠️⚠️ 注意后半句：**骰娘模式不是"全哑"**，是"只做骰子这一件事"。
 *   一开始我按"全哑"理解，用户澄清后才对 —— 差别很大：全哑的话没人算骰，
 *   那一局根本没法跑；只应答骰点才是"她在当骰娘"的意思。
 *
 * ## 与「安静指令」的区别（两者容易混，务必分清）
 *   · 安静指令 = **什么都不说**（连骰点也不答），时长可设、可解除
 *   · 骰娘模式 = **只说骰点**，其它一律静默，可解除 + 可超时
 *   所以这里**不复用** `quiet` 那套状态，另存一份 —— 否则两个开关会互相覆盖。
 *
 * ## 为什么单独一个文件（而不是塞进 bot.js）
 *   `bot.js` 已经 7000+ 行，而且它同时是「消息进来」和「决定说不说话」的地方。
 *   这个模式要在**三个地方**各插一刀（见 `bot.js` 里的 `diceMode` 标记），
 *   逻辑本身独立 ⇒ 独立文件更好读，也更好测（纯状态，不依赖 bot 实例）。
 *
 * ## 权限
 *   复用**安静指令同一条**判据（`canTeach()`：owner / admin / teachers 白名单）。
 *   用户 2026-09-30 明确「权限和安静指令一致」。
 *
 * ## 落盘
 *   `state/dice-mode.json`。⚠️ **重启后一律回日常**（用户要求）——
 *   所以启动时**不读**这个文件，只在需要时写；`loadDiceMode()` 只在
 *   WebUI 展示和「恢复上次状态」这类显式场景才调用。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, config } from './config.js';
import { log } from './log.js';

const STATE_DIR = join(ROOT, 'state');
const FILE = process.env.QQBOT_DICE_MODE_FILE
  ? join(ROOT, process.env.QQBOT_DICE_MODE_FILE)
  : join(STATE_DIR, 'dice-mode.json');

/** `群号 -> { at, until, by, byName }`（**只有开了的群在里面**，关掉就删掉那一条） */
let modes = {};

const cfg = () => config.diceMode ?? {};

export function enabled() {
  return cfg().enable !== false;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/** 认「进 / 出骰娘模式」指令。**返回 `{act:'on'|'off'}` 或 null**。 */
export function matchTrigger(text, cfg2 = {}) {
  const c = cfg2.enable === false ? {} : (cfg2 ?? {});
  const t = String(text ?? '').trim();
  if (!t) return null;
  const norm = (x) => String(x ?? '').trim().replace(/\s+/g, '');
  // ⚠️ 必须**整句相等**：这是状态开关，不是关键词。
  //    若用 includes，「今天散场了吧」这种闲聊会误触发 —— 而它还有权限检查，
  //    误触发的后果是「她莫名进/退骰娘模式」，比误判安静指令更糟（那个只是闭嘴）。
  const on = (Array.isArray(c.enterKeys) ? c.enterKeys : []).map(norm).filter(Boolean);
  const off = (Array.isArray(c.exitKeys) ? c.exitKeys : []).map(norm).filter(Boolean);
  const n = norm(t);
  if (on.includes(n)) return { act: 'on' };
  if (off.includes(n)) return { act: 'off' };
  return null;
}

/**
 * 这个群现在是骰娘模式吗？
 *
 * ⚠️ 私聊**永远不算**：骰娘模式是"群里那一局的规矩"，不是一个人的状态。
 * ⚠️ 超时自动退：到点自己醒并**顺手清掉那条**（别让文件越攒越多）。
 */
export function isOn(event) {
  if (!enabled()) return false;
  if (event?.message_type !== 'group') return false;
  const gid = String(event.group_id ?? '');
  if (!gid) return false;
  const m = modes[gid];
  if (!m) return false;
  if (m.until && Date.now() >= m.until) {
    delete modes[gid];
    save();
    log.info(`[骰娘] 群 ${gid} 到点自动退出骰娘模式`);
    return false;
  }
  return true;
}

/** 这个群因为超时/未开而不在模式里 —— 但**有人下令过**（用于 UI 显示） */
export function stateOf(groupId) {
  return modes[String(groupId ?? '')] ?? null;
}

/** 当前开着骰娘模式的群号列表 */
export function onGroups() {
  return Object.keys(modes);
}

/** 进入（`durationMs` 0 = 到解除为止） */
export function turnOn(event, durationMs = 0) {
  const gid = String(event?.group_id ?? '');
  if (!gid) return null;
  const byName = String(
    event?.sender?.card || event?.sender?.nickname || event?.user_id || '',
  );
  const dur = Math.max(0, Number(durationMs) || 0);
  modes[gid] = {
    at: Date.now(),
    until: dur > 0 ? Date.now() + dur : 0,
    by: String(event?.user_id ?? ''),
    byName,
    since: todayKey(),
  };
  save();
  log.info(`[骰娘] 群 ${gid} 由 ${byName} 进入骰娘模式（${dur > 0 ? `${Math.round(dur / 60000)} 分钟` : '到解除为止'}）`);
  return modes[gid];
}

/** 退出。⚠️ 之前没开过就返回 false（调用方据此决定要不要回一句） */
export function turnOff(event) {
  const gid = String(event?.group_id ?? '');
  const was = modes[gid];
  if (!was) return null;
  delete modes[gid];
  save();
  log.info(`[骰娘] 群 ${gid} 退出骰娘模式`);
  return was;
}

function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(modes ?? {}, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    log.debug(`骰娘模式状态写盘失败：${e.message}`);
  }
}

/**
 * 从磁盘读回状态（**默认不调用**）。
 *
 * ⚠️ 用户要求「重启之后回归日常」，所以正常启动路径**不调它**。
 *   留着这个函数是给两处用的：① WebUI 展示「上次是哪个群开的」；
 *   ② 将来想加"跨重启续上"时的唯一入口。
 * ⚠️ 读进来**不写回内存**，除非调用方显式调用 `restore()`。
 */
export function peekFile() {
  try {
    if (!existsSync(FILE)) return {};
    return JSON.parse(readFileSync(FILE, 'utf8')) ?? {};
  } catch (e) {
    log.debug(`读骰娘模式状态失败：${e.message}`);
    return {};
  }
}

/**
 * 这条消息**是不是骰点指令**（决定她在骰娘模式下该不该开口）。
 *
 * ⚠️ 判据是「海豹能算的指令」——前导点 + 命令名。海豹的命令很多（`.r`/`.ra`/`.rb`/
 *   `.rc`/`.rd`/`.st`…），**不在这里穷举**：穷举必然漏，而且海豹升级会加新命令。
 *   所以做成「**默认是**，但可以配一个不认的前缀黑名单」，把维护成本降到最低。
 *
 * @returns {boolean} 该不该把这句转给海豹
 */
export function isDiceCommand(text, cfg2 = {}) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  const skip = (Array.isArray(cfg2.skipDiceKeys) ? cfg2.skipDiceKeys : []).map((x) => String(x).trim());
  if (skip.includes(t)) return false;
  // 海豹的指令一律以 `.` 或 `/` 开头（`.ra`/`.r`）。**至少要有一个前缀符号**，
  // 否则「今天心情不错」会被当成指令转给海豹 —— 那是噪声，还会白花一次网络往返。
  if (!/^[./]/.test(t)) return false;
  // ⚠️ 后面必须**跟着命令词**，否则 `.`（单点）、`。`（中文句号）、`/help me` 这类会被误转。
  return /^[./][a-zA-Z一-龥]/.test(t);
}