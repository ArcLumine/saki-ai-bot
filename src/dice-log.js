/**
 * 跑团记录（海豹的 log）—— **独立一个分支**，和 `observe/`、`storyline/` 并列。
 *
 * ## 为什么独立（用户 2026-09-30 明确要求）
 *   · `observe/`   记的是「**这个人**什么样」（性格、群里的关系）
 *   · `storyline/` 记的是「**她自己**经历过什么」（生活小事、主线剧情）
 *   · 跑团 log     记的是「**这一局**发生了什么」（谁掷了什么骰、检定结果、剧情推进）
 *   ⚠️ 混进 `observe/` 的话，观察总结会把剧情当成"群友性格"——
 *     跑得越久偏得越歪，而且那种错**看不出来**（读起来还挺通顺）。
 *
 * ## 机制照抄 observe / storyline（用户要求：「和 observe 还有压缩剧情线类似的机制，
 *   读取上下文然后精简 log」）
 *   1. `note()` 攒**原始条目**（拉一批海豹 log，落盘）
 *   2. `compress()` 让模型把流水账**改写成章节**（一章 = 一件事）
 *   3. `promptBlock()` 把章节喂进提示词
 *   4. `compressIfDue()` 按间隔自动触发
 *
 * ⚠️ 与 storyline 的关键差别：它压缩时"锁定条目一条不许删"是因为主线剧情；
 *   而骰子结果**同样不许删**，但理由不同 —— 删掉某次检定，
 *   后面"他刚才那个 1 算大成功还是失败"就没法答了。见下面 COMPRESS_PROMPT。
 *
 * ## 落点
 *   `state/dice-logs.json`（**程序状态**，不是 md）。
 *   ⚠️ 为什么不像 `observe/` 用 md：那份是"给人看、给模型读的散文"，
 *     而 log 要**按 id 去重 / 增量读 / 整批替换**，混进 md 会被重写冲掉。
 *
 * ## 增量读（重要）
 *   海豹的 log 表 `log_one_items` 有**自增主键 id**（实测确认），
 *   所以记「读到哪个 id 了」就不会重复吃同一段。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, config } from './config.js';
import { log } from './log.js';
import * as sealdice from './sealdice.js';

const STATE_DIR = join(ROOT, 'state');
const FILE = process.env.QQBOT_DICE_LOG_FILE
  ? join(ROOT, process.env.QQBOT_DICE_LOG_FILE)
  : join(STATE_DIR, 'dice-logs.json');

const cfg = () => config.diceLog ?? {};

export function enabled() {
  // ⚠️ 默认**关**（不是 `!== false`）—— 用户 2026-09-30「先写出来但是不启用」。
  // 这里和 config.js 的 `enable === true` 保持一致，别两处判据不同。
  return cfg().enable === true;
}

/** `群号 -> { cursor, items:[], chapters:[], lastCompressAt, lastNoteAt }` */
let groups = {};
/** 同一群上一次压缩还没跑完时防重入 */
const compressing = new Set();

/**
 * 从盘读回来。
 *
 * ⚠️⚠️ 2026-10-23 补（用户问「她读了多少」时查出的一串问题之一）：
 *    原来**只有 `save()` 没有 `load()`** —— `groups` 从空对象开始，
 *    进程一重启就"忘了"读过什么，而第一次 `note()` 结束时 `save()`
 *    又会把**整个文件覆盖**成只有新拉的那点内容 ⇒ 历史记录被吃 ✗
 *    （`index.js` 的 `diceLog.reload()` 也因为没这个函数直接抛
 *      `TypeError: diceLog.reload is not a function`，连带**定时拉取没注册上**。）
 */
function load() {
  try {
    groups = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) groups = {};
  } catch (e) {
    log.debug(`跑团记录读盘失败（按空处理）：${e.message}`);
    groups = {};
  }
}

/** 配置热重载 / 启动时调（`index.js` 的接线；缺了它定时器整段起不来） */
export function reload() {
  load();
  log.debug(`[跑团记录] 状态已重载：${Object.keys(groups).length} 个群`);
}

// ⚠️ 模块加载时先读一次 —— 否则第一次 note() 从空开始，save() 会把历史覆盖掉
load();

export const stats = { noteRuns: 0, compressRuns: 0, lastError: '' };

const gk = (g) => String(g ?? '').trim();

function bucket(gid, create = false) {
  const k = gk(gid);
  let b = groups[k];
  if (!b && create) {
    // ⚠️ 2026-10-23 加 `summary`（粗压梗概）：
    //    实测一局能到 11 万字，压成章节约 4000 字 —— 塞不进提示词，
    //    所以分两层：summary（1500 字，进提示词）+ chapters（细压，存档）。
    b = { cursor: 0, items: [], chapters: [], summary: '', lastCompressAt: 0, lastNoteAt: 0, lastSummaryAt: 0 };
    groups[k] = b;
  }
  return b ?? null;
}

function save() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(groups ?? {}, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (e) {
    log.debug(`跑团记录写盘失败：${e.message}`);
  }
}

/**
 * 拉一批海豹 log 存进来。
 *
 * ⚠️ **只增量读**：靠 `cursor`（海豹 `log_one_items` 的自增 id）跳过已吃过的。
 *    不做增量的话每轮都把同一段再喂模型一次 —— 白花钱，而且模型会重复总结。
 *
 * @param {{groupId:string|number, pageSize?:number, force?:boolean}} opts
 */
export async function note(opts = {}) {
  if (!enabled()) return { ok: false, added: 0, reason: '跑团记录没开' };
  if (!sealdice.enabled()) return { ok: false, added: 0, reason: '海豹没启用' };
  const gid = gk(opts.groupId);
  if (!gid) return { ok: false, added: 0, reason: '没给群号' };

  const minInterval = Math.max(0, Number(cfg().minIntervalMs) || 5 * 60 * 1000);
  const b = bucket(gid, true);
  if (!opts.force && b.lastNoteAt && Date.now() - b.lastNoteAt < minInterval) {
    return { ok: false, added: 0, reason: '距上次拉取不到间隔' };
  }

  // ── 两级：海豹的 log 是「群 → 局 → 消息」三层 ──────────────
  // ⚠️⚠️ 一开始我只调了 `logs/page` 就去读 `x.message` —— 那个接口返回的是
  //    **局列表**（id/name/groupId/createdAt/size），压根没有 message 字段，
  //    于是记进去的全是空字符串。这个坑读源码才看出来（api/story/items/page 才是消息）。
  // ⚠️⚠️ 2026-10-23 修（用户：「我记得有 1000 条吧」—— 实测那局 size=1125，
  //    之前只拉了第一页 200 条）：
  //    `story/items/page` 是**分页**的，只传 `pageNum: 1` 就永远只吃前 200 条。
  //    ⇒ 现在按 `pageSize=500` 翻页拉到最后一页（上限 10 页 = 5000 条，够一整局）。
  //    ⚠️ 判据用「这一页比 pageSize 少」而不是 `total` —— 海豹没有可靠的 total。
  const size = Math.min(200, Math.max(1, Number(opts.pageSize) || Number(cfg().pageSize) || 50));
  const pageSize = Math.min(500, Math.max(1, Number(cfg().pageSize) || 200));
  const { list: games } = await sealdice.storyLogs({ pageNum: 1, pageSize: size, groupId: gid });
  stats.noteRuns++;
  if (!games.length) return { ok: false, added: 0, reason: '这个群还没有跑团记录' };

  // ⚠️ 按 `updatedAt` 倒序（海豹那边就是这个顺序）⇒ 先读最近的那局。
  //    一次只读一局：多局混读会把不同局的剧情接在一起，那比读不到更糟。
  const game = games[0];
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await sealdice.storyItems({
      groupId: gid,
      logName: game.name,
      pageNum: page,
      pageSize,
    });
    if (!batch.length) break;
    items.push(...batch);
    if (batch.length < pageSize) break;
  }
  if (!items.length) return { ok: false, added: 0, reason: '这一局还没有内容' };

  let added = 0;
  let skippedOoc = 0;
  for (const it of items) {
    const id = Number(it.id) || 0;
    // ⚠️⚠️ 2026-10-23 加（用户给的 PL 存档实测：场外发言占 52%）：
    //    压缩前就剔掉 —— `（我开枪行不行）` 这种对剧情零价值，白白烧 token。
    //    同时去掉图片 / 引用标记（`[图片]`、`[mirai:quote:...]`）。
    const raw = String(it.message ?? '').trim();
    const text = raw
      .replace(/\[图片\]/g, '')
      .replace(/\[mirai:quote:[^\]]*\]/g, '')
      .trim();
    const ooc = /^[（(]/.test(text);
    if (ooc || !text) {
      if (ooc) skippedOoc++;
      // ⚠️ 即使跳过也要推进 cursor，否则下次又把同一批拉一遍
      if (id > b.cursor) b.cursor = id;
      continue;
    }
    // ⚠️ 有 id 就按 id 去重；没有 id 退回「文本+时间」去重（接口不保证每条都有 id）
    const dup = id
      ? b.items.some((x) => Number(x.id) === id)
      : b.items.some((x) => x.text === text && x.at === (Number(it.time) || 0));
    if (dup) continue;
    b.items.push({
      id,
      at: Number(it.time) || Date.now(),
      who: String(it.nickname ?? ''),
      text,
      // ⚠️ `isDice` = 那是骰子输出而不是人说的话。压缩时两类要分开处理：
      //    骰子输出是「判定结果」，**不能当剧情改写**（数字不许动）。
      dice: !!it.isDice,
      // ⚠️ 记下这局名：下次读**新开的一局**时要能认出「换局了」。
      game: String(game.name ?? ''),
    });
    if (id > b.cursor) b.cursor = id;
    added++;
  }
  b.game = String(game.name ?? '');
  b.lastNoteAt = Date.now();
  if (added || skippedOoc) save();
  return { ok: true, added, skippedOoc, total: b.items.length, game: b.game };
}

/** 攒了多少（界面显示用） */
export function statsOf(groupId) {
  const b = bucket(groupId);
  return {
    items: b?.items.length ?? 0,
    chapters: b?.chapters.length ?? 0,
    cursor: b?.cursor ?? 0,
    lastNoteAt: b?.lastNoteAt ?? 0,
    lastCompressAt: b?.lastCompressAt ?? 0,
  };
}

export function recent(groupId, n = 20) {
  const b = bucket(groupId);
  return [...(b?.items ?? [])].sort((a, x) => a.at - x.at).slice(-n);
}

/**
 * 手动改写章节（WebUI 的「跑团记录 → 她实际读到的」那块的保存）。
 *
 * ⚠️ 2026-10-23 加：压缩结果允许人肉修正（模型偶尔把骰子数值说错，删掉一句比重跑便宜）。
 * ⚠️ 只改 `chapters`，**不动 `items`**（原始流水账留着，下次压缩还能用）。
 */
export function setChapters(groupId, texts) {
  const gid = gk(groupId);
  const b = bucket(gid, true);
  b.chapters = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .map((text) => ({ at: Date.now(), text }));
  save();
  return { ok: true, chapters: b.chapters.length };
}

/** 粗压梗概（WebUI 显示用） */
export function summaryOf(groupId) {
  return String(bucket(groupId)?.summary ?? '');
}

/** 全部细压章节（WebUI 显示用） */
export function chaptersOf(groupId) {
  const b = bucket(groupId);
  return (b?.chapters ?? []).map((c) => String(c?.text ?? '')).filter(Boolean);
}

/** 当前压的是哪一局（WebUI 判断「用户选的局是不是已压的那局」用） */
export function gameOf(groupId) {
  return String(bucket(groupId)?.game ?? '');
}

/** 喂进提示词的段落：**粗压梗概 + 最近 2 章细压**。
 *
 * ⚠️⚠️ 2026-10-23 改（用户：「粗压和细压」+ PL 存档实测「一局能到 11 万字」）：
 *    原来只拼章节 → 一局压出几千字，提示词预算塞不下，只能截尾巴 ⇒ 开局全丢。
 *    现在两层：
 *      · `summary`（粗压，约 1500 字）= 整局梗概，永远排前面
 *      · 最近 2 章（细压，约 400 字）= 补「刚才发生了什么」
 */
export function promptBlock(groupId, maxChars = 2200) {
  const b = bucket(groupId);
  if (!b) return '';
  const parts = [];
  if (b.summary) parts.push('## 这一局的梗概', b.summary);
  const recent = (b.chapters ?? []).slice(-2).map((c) => `- ${c.text}`).join('\n');
  if (recent) parts.push('## 最近的进展（最近两章）', recent);
  if (!parts.length) return '';
  const body = parts.join('\n\n');
  return body.length > maxChars ? body.slice(0, maxChars) : body;
}

/**
 * 把原始记录压缩成章节。
 *
 * ⚠️ 压缩后**原始条目清空**（storyline 也是这么做的：不然后面每轮都在压同一批）。
 *   章节才是长期记忆，原始条目只是"待消化的料"。
 *
 * ⚠️ 模型调用是**注入的**（`config.diceLog.__runner`），本模块不 import llm.js
 *    —— 那会拉进一整条依赖链，套件也难跑。`index.js` 负责接上。
 *
 * @param {{force?:boolean, groupId:string|number}} [opts]
 */
export async function compress(opts = {}) {
  if (!enabled()) return { ok: false, reason: '跑团记录没开' };
  if (!sealdice.enabled()) return { ok: false, reason: '海豹没启用' };
  const gid = gk(opts.groupId);
  const b = bucket(gid);
  if (!b || !b.items.length) return { ok: false, reason: '没有待整理的原始记录' };
  if (compressing.has(gid)) return { ok: false, reason: '上一次还在压' };

  const minEntries = Math.max(2, Number(cfg().compress?.minEntries) || 8);
  if (b.items.length < minEntries) {
    return { ok: false, reason: `条数太少（${b.items.length}/${minEntries}）` };
  }
  const minInterval = Number(cfg().compress?.minIntervalMs) || 30 * 60 * 1000;
  if (!opts.force && b.lastCompressAt && Date.now() - b.lastCompressAt < minInterval) {
    return { ok: false, reason: '距上次压缩不到间隔' };
  }
  const runner = cfg().__runner;
  if (typeof runner !== 'function') return { ok: false, reason: '没注入压缩用的模型调用' };

  compressing.add(gid);
  stats.compressRuns++;
  try {
    const rows = [...b.items]
      .sort((a, x) => a.at - x.at)
      .map((it) => `[id=${it.id} ${it.dice ? '骰子' : '人言'}] ${it.who}：${it.text}`);

    // ⚠️⚠️ 2026-10-23 改（用户：「粗压和细压」）：
    //    原来一次性把全部条目塞给模型 —— 一局能到 11 万字，输出上限只有 2000 字左右，
    //    中间的细节直接被砍 ✗。现在**每批 600 条**各压一次，章节累加。
    const BATCH = Math.max(100, Number(cfg().compress?.batch) || 600);
    const chapters = [];
    let failed = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const batchNo = Math.floor(i / BATCH) + 1;
      const raw = await runner(
        COMPRESS_PROMPT,
        `跑团记录（本批 ${chunk.length} 条 / 共 ${rows.length} 条，第 ${batchNo} 批）：\n\n${chunk.join('\n')}`,
      );
      const parsed = parseJson(raw);
      if (!parsed) {
        failed++;
        // ⚠️ 原始输出要留一点在日志里 —— 不然下次只看到一句"作废"，
        //    分不清是"被截断"还是"格式错"（storyline 那次就卡在这）。
        log.warn(
          `[跑团记录] 群 ${gid} 第 ${batchNo} 批压缩作废` +
            `（原始输出 ${String(raw).length} 字；末尾：…${String(raw).slice(-160).replace(/\s+/g, ' ')}）`,
        );
        continue;
      }
      chapters.push(
        ...(Array.isArray(parsed.chapters) ? parsed.chapters : [])
          .map((c) => ({ at: Date.now(), text: String(c?.text ?? '').trim() }))
          .filter((c) => c.text),
      );
    }
    if (!chapters.length) {
      stats.lastError = failed ? '所有批次都没压出可解析的 JSON' : '模型没给出章节';
      return { ok: false, reason: stats.lastError };
    }
    b.chapters.push(...chapters);
    b.items = [];
    b.lastCompressAt = Date.now();
    save();
    log.info(
      `[跑团记录] 群 ${gid} 压出 ${chapters.length} 章` + (failed ? `（${failed} 批失败）` : ''),
    );
    return { ok: true, chapters: chapters.length, failed };
  } finally {
    compressing.delete(gid);
  }
}

/**
 * 粗压：把**已整理章节**再合成一份梗概（约 1500 字），给提示词用。
 *
 * ⚠️ 2026-10-23 加（用户：「做两个吧，粗压和细压」）：
 *    细压章节一局能到 4000 字，塞不进提示词；梗概是专给提示词的那一份。
 *    ⚠️ 输入用 `b.chapters`（**不是**原始 items —— 那压完就清空了，梗概要能反复重算）。
 */
export async function summarize(groupId, opts = {}) {
  if (!enabled()) return { ok: false, reason: '跑团记录没开' };
  const gid = gk(groupId);
  const b = bucket(gid);
  if (!b || !b.chapters.length) return { ok: false, reason: '还没有章节可压' };
  if (compressing.has(gid)) return { ok: false, reason: '上一次还在压' };

  const minInterval = Number(cfg().summary?.minIntervalMs) || 10 * 60 * 1000;
  if (!opts.force && b.lastSummaryAt && Date.now() - b.lastSummaryAt < minInterval) {
    return { ok: false, reason: '距上次粗压不到间隔' };
  }
  const runner = cfg().__runner;
  if (typeof runner !== 'function') return { ok: false, reason: '没注入模型调用' };

  compressing.add(gid);
  try {
    const input = b.chapters.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
    const raw = await runner(SUMMARY_PROMPT, `本局已有的 ${b.chapters.length} 章：\n\n${input}`);
    const text = String(raw ?? '').trim();
    if (!text) {
      stats.lastError = '模型没给出梗概';
      return { ok: false, reason: stats.lastError };
    }
    b.summary = text.slice(0, 3000);
    b.lastSummaryAt = Date.now();
    save();
    log.info(`[跑团记录] 群 ${gid} 梗概 ${b.summary.length} 字`);
    return { ok: true, chars: b.summary.length };
  } finally {
    compressing.delete(gid);
  }
}

/** 粗压提示词：整局 → 一份梗概（进提示词的那份） */
export const SUMMARY_PROMPT = `你在帮一个跑团机器人**把已经整理好的章节再压成一份剧情梗概**。

## 目标
输出 1200~1800 字的梗概，让她只看这一段就知道「这一局到底发生了什么」。

## 必须保留
- **人物**：谁是 PC、谁在行动、谁死了 / 疯了 / 离队
- **地点与时间**：故事从哪开始、走到哪
- **剧情主线**：发生了什么、为什么、最后怎么样了
- **关键骰子结果**：大成功 / 大失败、关键检定的数字（**原样保留，一个都不许改**）
- **悬念**：这一局留下的钩子

## 必须砍掉
- 场外讨论、玩家玩笑
- 重复描述、无关闲聊
- 除关键检定以外的数值细节

## 格式
只输出正文，**不要标题、不要列表编号、不要解释你做了什么**。`;

/** 到点自动压一次（`index.js` 里定时调） */
export async function compressIfDue() {
  if (!enabled()) return;
  for (const gid of Object.keys(groups)) {
    try {
      const r = await compress({ groupId: gid });
      // ⚠️ 2026-10-23：压出新章节后顺手重算梗概（粗压）
      //    —— 否则提示词里的 summary 永远是第一次那版
      if (r?.ok) await summarize({ groupId: gid });
    } catch (e) {
      log.debug(`[跑团记录] 群 ${gid} 自动压缩出错：${e.message}`);
    }
  }
}

/** 从模型输出里抠 JSON（照抄 storyline 的两段式 —— 模型很爱包 ```json） */
export function parseJson(raw) {
  let t = String(raw ?? '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  const body = t.slice(i, j + 1);
  try {
    return JSON.parse(body);
  } catch {}
  try {
    return JSON.parse(body.replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r'));
  } catch {}
  return null;
}

export const COMPRESS_PROMPT = `你在帮一个跑团机器人**整理它的跑团记录**。

这些是**一局 TRPG 跑下来**的真实流水：谁说了什么、掷了什么骰、检定结果如何、剧情推到哪。
你的任务：把流水账**改写成轻小说式的章节** —— **一章 = 一件事**。
这样以后她被问到「我们上次那局怎么样」时能答得准，也更省地方。

⚠️⚠️ 四条铁律：

1. **掷骰结果必须保留，数值不许改。**
   那是后面所有判断的依据 ——「他刚才那个 1 是大成功还是失败」「还剩几点理智」全靠它。
   **只能改写叙述方式，不许改动数字、不许把失败写成成功。**
   ⚠️ 标了「骰子」的行就是判定输出，照着写，别自己另编一个结果。
2. **一章 = 一件事**。把讲同一件事的连续几段合成一章；
   **不同的事、隔了好几天的不许硬凑** —— 每章都要经得起「这是哪一天、哪一件事」。
3. **正文里不要写日期**，日期由系统按真实时间加。
4. **纯灌水直接删**：与剧情无关的闲聊、与检定无关的吐槽不要。
   ⚠️ 判据：**这条以后能让她答得更准吗？** 能 → 并进章节；不能 → 丢。

输出格式（**只要 JSON，不要别的**）：
{"chapters":[{"text":"这一章讲了什么"}]}`;
