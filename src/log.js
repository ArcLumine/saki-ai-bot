import fs from 'node:fs';
import path from 'node:path';
// ⚠️⚠️ 必须用 `fs/promises` 的 appendFile —— 回调版的 `fs.appendFile(path, data, 'utf8')`
//    第三个参数是 **callback**，传 'utf8' 会直接抛
//    `The "cb" argument must be of type function. Received type string ('utf8')` ✗
//    （2026-10-03 我自己踩的：改异步那天开始，按天日志从 01:15 起**整整断了**，
//      因为 `diskBroken` 一置位就"只输出到控制台"，而控制台在 %TEMP% 里）
import { appendFile } from 'node:fs/promises';
import { config, ROOT, CONFIG_FILE, ACCOUNT } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 日志落盘：**两套并存**（2026-10-04 合并上游）。
 *
 * ⚠️ 本地原来只有一个 `SAKIBOT_LOG_FILE` 环境变量：设了就写，不设就**完全不碰文件系统**。
 *    但本机**只有一个入口**设了它（`启动机器人.bat`）——
 *    `_run-bot.bat` / `启动机器人（后台）.bat` / `start-all.ps1` / 看门狗**都不设**
 *    ⇒ 走那些入口启动时日志**一条都不落盘** ✗
 *    （而看门狗恰恰是日常最常用的启动方式 ⇒ 排障时"翻日志"经常什么都翻不到。）
 *
 * ⚠️ 上游那边是另一套：`logs/bot-YYYY-MM-DD.log` 按天一个文件、**异步**追加，
 *    日期交给 `new Date()` 算（bat 里那套取日期在隐藏窗口/非交互启动下会失败，
 *    实测写进了 `bot-unknown.log` ⇒ 等于没分天）。
 *
 * ⇒ 合并后的判据：**有环境变量就听环境变量**（本地前台启动行为一字不变），
 *    没有就回落到上游的按天文件。两者**不叠加**（见 `logFile()`），不会写两份。
 */
const LOG_FILE = process.env.SAKIBOT_LOG_FILE || '';

const LOG_DIR = path.join(ROOT, 'logs');
let diskBroken = false;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  /* 建不了一会在 writeDisk 里报 */
}

function logFile() {
  // ⚠️⚠️ 2026-10-09 加：**显式指定日志文件**（回归套件用，优先级最高）。
  //
  //    下面那段"测试隔离"的判据（配置名里含 `test`）**漏了一半**：
  //    `test/run-all.js` **故意不动 `QQBOT_CONFIG`**（它自己的注释：指向一个不存在的
  //    文件会让 `config.js` 拿不到配置）⇒ 那些套件里 `spawn` 起来的**真机器人**，
  //    用的还是 `config.yml` 这个名字 ⇒ 假号（`999000098`、`10000020` 这些）的日志
  //    全灌进**真实的** `bot-<日期>.log`。
  //
  //    后果（2026-10-09 真踩）：用户那条"主号怎么变成别人的人设了"我查日志时，
  //    满屏「不回复的机器人名单」重复九次，**差点把测试日志当成"机器人在崩溃重启循环"**；
  //    而且真实会话的行和假会话的行交错，根本分不清哪句是群里真发生的。
  //
  //    ⇒ 由 `run-all.js` 给每个套件注入一个独立文件。显式指定 > 靠名字猜。
  if (process.env.QQBOT_LOG_FILE) return path.join(ROOT, String(process.env.QQBOT_LOG_FILE));
  // 本地前台启动显式指定的日志路径继续优先于按天日志。
  if (LOG_FILE) return LOG_FILE;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // ⚠️⚠️ **测试隔离**（和 `tic.js` 的 `stateFile()` 同一个判据）：
  //    十几个套件都会 spawn 真实的 `src/index.js`，而它们**本来就都设了**
  //    `QQBOT_CONFIG=config.*-test.yml` ⇒ 配置名带 test 就写到 `__test-*.log`，
  //    绝不往真实的按天日志里灌假日志（那份是我用来查"用户刚才那条为什么没回"的 ✗）。
  const cfgName = path.basename(CONFIG_FILE ?? '');
  if (/test/i.test(cfgName)) {
    return path.join(LOG_DIR, `__test-${cfgName.replace(/\.ya?ml$/i, '')}.log`);
  }
  // ⚠️ 2026-10-07 多 QQ 号：**非主号**写到带号后缀的文件（`bot-<日期>-<QQ>.log`），
  //    免得两个进程的行交错在一起 —— 排障时"这一句到底是谁说的"必须一眼看出来。
  //    主号（也是默认那个号）**保持老文件名**，用户翻日志的习惯不变。
  const suffix = ACCOUNT.id && !ACCOUNT.isMain ? `-${ACCOUNT.id}` : '';
  return path.join(
    LOG_DIR,
    `bot-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${suffix}.log`,
  );
}

/**
 * ⚠️⚠️ 2026-10-03：**改成异步写**（原来是 `appendFileSync`）。
 *
 * 现场（`logs/bot-2026-10-03.log`）：
 *   `01:03:48 拼提示词 5565 ms（71604 字）` / `01:06:00 拼提示词 6148 ms（71569 字）`
 * 而 `buildSystemPrompt` **没有 await、没有读文件、没有任何重活**（我用探针
 * 把它的几个子模块都量过：knowledge / holiday / names / recent 全是 0~0.8 ms）。
 * 唯一"重"的就是它里面有 **14 处 `log.*`** —— 而每一处都在**同步写盘**，
 * 这个项目又整个放在 **OneDrive 目录**里（同步写小文件在这儿特别贵）。
 * 加上 `_run-bot.bat` 还把 stdout 重定向到 `logs\bot-console.log`（也在 OneDrive）
 * ⇒ 一条日志 = **两次同步写 + 云同步**。
 *
 * ⇒ 日志绝不该拖慢回复：改成**串行 promise 链 + 异步 append**（顺序照旧、不阻塞）。
 * ⚠️ 顺序必须保住，否则日志行会乱序 —— 排障时最恨这个。
 */
let chain = Promise.resolve();

function writeDisk(line) {
  if (diskBroken) return;
  // ⚠️ 换行在这里补（`emit()` 不再自己带 `\n`，免得控制台那边要多一道 `replace`）
  const data = String(line).replace(/\r?\n$/, '') + '\n';
  chain = chain.then(() => appendFile(logFile(), data, 'utf8')).catch((e) => {
    diskBroken = true;
    // 只能用 console 报 —— log 自己坏了
    console.error(`[日志] 写文件失败，之后只输出到控制台：${e.message}`);
  });
}

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
  const line = `[${ts()}] ${tag} `;
const text = line + args.map(String).join(' ');
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(text);
  // ⚠️ 换行交给 `writeDisk` / `appendFile` 补，不在 `text` 里带 ——
  //    否则控制台那边要先 `replace(/\n$/,'')` 才能不打多余空行，两处口径容易打架。
  writeDisk(text);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};

/** 给测试/排障看：这次会写到哪个文件 */
export function currentLogFile() {
  return logFile();
}
