/**
 * **日账** —— 「她自己这两天说过的事」（2026-11-12 按交接文档 `daybook-handoff.md` 实现）
 *
 * ## 要解决的事（有实证）
 *   群里问「今天吃什么」，她答「早上刚在校门口跟睦分着吃过一包」——
 *   被追问「什么东西那么辣」时，她**绕开了**，继续讲「辣得我直灌水」。
 *   核心名词从头到尾空着：**那件事本来就不存在** —— 她把两个真实元素拼在一起，
 *   加了「一包」这个量词，内容没填。**感官细节好编，名词不好编，一追问就露。**
 *
 *   ⚠️ 关键约束：群友不知道那是编的，会当真。
 *   ⇒ 问题不是「编」，是「**编了收不住**」。
 *
 * ## 三种内容，三个来源（别混）
 *
 * | 类型 | 例子 | 来源 | 存不存 |
 * |---|---|---|---|
 * | 现在时 | 在吃饭、困、下雨 | 现场生成 | 不存 |
 * | 今天/明天/昨天 | 今天去了哪、明天要补课 | 现场生成 + **写进日账** | **存，只留 3 天** |
 * | 长期经历 | 老家、以前做什么 | 角色设定池（`life-events.md`） | 池子本身 |
 *
 *   ⚠️ **为什么不都丢进池子**：池子是「这个人的过去」（静态母题），日账是
 *   「这两天干了什么」（一直在变）。混在一起，池子会被日常灌满，过去的母题被冲掉，
 *   人设反而变薄；而且池子会被聊空（200 条事件天天说话撑不过两个月）。
 *
 * ## 这一版做了什么（交接文档 §十一 的第 1 步）
 *
 *   **只做「存 + 带进提示词」** —— 纯正则兜底，**不做 `[记:…]` 标记**。
 *   先验证一致性有没有改善；有效果再加标记（第 2 步），最后才调提示词措辞（第 3 步）。
 *   ⚠️ **别一开始三样全上** —— 分不清是哪一步起的作用。
 *
 * ## 三条硬边界（交接文档 §八）
 *   ① **只存她自己说的话** —— 装群友的聊天就变成监控日志了 ✗
 *   ② **不是长期记忆** —— 3 天就忘。要记更久的是设定池和人设的事 ✗
 *   ③ **别变成「每条都要说点自己的生活」** —— 那会把池子耗干，也不真实 ✗
 *
 * ## 落盘
 *   `state/daybook.json`（`QQBOT_DAYBOOK_FILE` 可改，测试用），原子写。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, stateDir, zonedParts, getTimeZone } from './config.js';
import { log } from './log.js';

/** 只留最近几天（交接文档：超过 3 天删掉） */
const KEEP_DAYS = 3;
/** 最多留几条（交接文档：只留最近 8 条，约 300 字） */
const MAX_ITEMS = 8;
/** 单条最长（防她一口气讲一大段） */
const MAX_TEXT = 120;
/** 单条最短（「今天吃了面」只有 5 个字，但确实是一件事 —— 门槛别设太高） */
const MIN_TEXT = 4;
/** 一条回复里最多记几条（多了就不是"顺口提到"，是在写日记） */
const MAX_PER_REPLY = 2;

/** 时间词 —— 只有出现这些，才可能在说"今天/明天"的事 */
const TIME_WORDS = /今天|昨天|明天|前天|后天|刚才|刚刚|今早|今晚|昨晚|明早|明晚|早上|上午|中午|下午|傍晚|晚上|夜里|周末/;
/** 动作词 —— 时间词 + 动作词才像"一件事"，光说"今天好热"不算 */
const ACTION_WORDS = /吃|喝|去|来|买|做|要|见|送|补|上|睡|起|回|待|陪|练|写|看|打|开|拿|分|聊|约|玩|跑|逛|洗|晾|煮|点|赶|坐|走/;
/** 条件句 / 反问 —— 不是"发生了的事"，别记 */
const SKIP_PATTERNS = /要是|如果|假如|万一|不然|要不要|是不是|有没有|能不能|会不会|可不可以/;

const file = () =>
  process.env.QQBOT_DAYBOOK_FILE
    ? join(ROOT, process.env.QQBOT_DAYBOOK_FILE)
    : join(stateDir(), 'daybook.json');

function loadRaw() {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8'));
    return Array.isArray(j?.items) ? j.items : [];
  } catch {
    return [];
  }
}

/** 原子写（先写 .tmp 再改名 —— 进程被杀不会留半截 JSON） */
function saveRaw(items) {
  const p = file();
  try { mkdirSync(stateDir(), { recursive: true }); } catch { /* ignore */ }
  const payload = JSON.stringify({ items }, null, 2);
  const tmp = p + '.tmp';
  writeFileSync(tmp, payload, 'utf8');
  try { renameSync(tmp, p); } catch { writeFileSync(p, payload, 'utf8'); }
}

/** `11-12` / `18:30`（按机器人自己的时区，不是机器时区） */
function stamp(ts) {
  const p = zonedParts(new Date(ts), getTimeZone());
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${pad(p.month)}-${pad(p.day)}`,
    at: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/** 去重用的归一化（标点/空白不参与比较） */
const norm = (s) => String(s).replace(/[\s，。！？、,.!?~～…—–-]/g, '');

/** 删掉超过 KEEP_DAYS 的条目，返回留下的 */
export function prune(items = loadRaw()) {
  const cut = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  const kept = items.filter((x) => Number.isFinite(Number(x?.ts)) && Number(x.ts) >= cut);
  if (kept.length !== items.length) {
    log.info(`[日账] 清掉 ${items.length - kept.length} 条超过 ${KEEP_DAYS} 天的`);
    saveRaw(kept);
  }
  return kept;
}

/**
 * 从一段回复里**抽**出「她说了自己这两天的事」的句子（纯正则兜底，不上模型）。
 *
 * ⚠️ 宁可粗：这一版故意只做"存"，漏抓的多抓的少都不怕 ——
 *    目标是先量出「一致性有没有改善」，不是把它做全。
 *
 * @param {string} text 已经剥过标记的回复正文
 * @returns {string[]} 候选句子（原文，未改一个字）
 */
export function extract(text) {
  const raw = String(text ?? '')
    // 标记万一漏剥了，别把 `[表情:x]` 当内容存下来
    .replace(/\[(?:表情|工具|记)\s*:[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return [];

  // 按句切开（逗号不切 —— 「早上跟睦分了包辣条，辣得灌水」是一件事，得整句留着）
  const parts = raw.split(/(?<=[。！？!?；;…\n])/);
  const out = [];
  for (const one of parts) {
    const s = String(one).trim().replace(/^[，,、]+|[。！？!?；;…]+$/g, '').trim();
    if (s.length < MIN_TEXT || s.length > MAX_TEXT) continue;
    // 问句不是"发生的事"（带问号，或者以「吗」收尾）
    if (/[？?]/.test(one) || /吗[。！!]?$/.test(s)) continue;
    // 对着别人说的（「你别忘了明天…」）—— 那是提醒，不是她的生活
    if (/^(你|您|你们|大家|各位)/.test(s)) continue;
    // 条件/反问句
    if (SKIP_PATTERNS.test(s)) continue;
    if (!TIME_WORDS.test(s) || !ACTION_WORDS.test(s)) continue;
    out.push(s);
    if (out.length >= MAX_PER_REPLY) break;
  }
  return out;
}

/**
 * 记一条回复里的事。**每条回复发出后调用一次**。
 *
 * @param {string} text 回复正文（`stripMarkers(full).trim()`）
 * @returns {number} 实际记了几条
 */
export function record(text) {
  let cands = [];
  try {
    cands = extract(text);
  } catch (e) {
    log.debug(`[日账] 抽取失败（不影响聊天）：${e.message}`);
    return 0;
  }
  if (!cands.length) return 0;

  const items = prune();
  const seen = new Set(items.map((x) => norm(x.text)));
  const now = Date.now();
  let added = 0;
  for (const s of cands) {
    const key = norm(s);
    if (!key || seen.has(key)) continue;
    const { date, at } = stamp(now);
    items.push({ ts: now, date, at, text: s });
    seen.add(key);
    added++;
  }
  if (!added) return 0;

  // 超上限丢最老的
  const kept = items.slice(-MAX_ITEMS);
  saveRaw(kept);
  log.info(`[日账] +${added} 条：${cands.slice(0, added).map((s) => s.slice(0, 30)).join(' ｜ ')}`);
  return added;
}

/** 读（自动清理），按时间**正序**（老的在前 —— 交接文档的示例就是这个顺序） */
export function list({ limit = MAX_ITEMS } = {}) {
  const items = prune().sort((a, b) => Number(a.ts) - Number(b.ts));
  return items.slice(-limit);
}

/**
 * 给提示词用的文本块。
 *
 * ⚠️ 空的时候返回 `''`（别塞「（暂无）」—— 那会被当成"真的什么都没有"到处复述）
 * ⚠️ **放在「最近两天发生的事」那段旁边**，不另开一整段（交接文档 §十② 的倾向）
 */
export function block({ maxChars = 600 } = {}) {
  const items = list();
  if (!items.length) return '';
  const lines = [];
  let used = 0;
  for (const x of items) {
    const line = `- ${x.date} ${x.at} ${x.text}`;
    if (used + line.length > maxChars) break;
    used += line.length + 1;
    lines.push(line);
  }
  if (!lines.length) return '';
  return [
    '# 【你这两天自己说过的事】',
    '',
    ...lines,
    '',
    '⚠️ 这是**你自己说过的话**，不是别人告诉你的。',
    '✅ 再聊到的时候，里面提到的具体东西必须对得上：吃过什么、谁、在哪、什么时候。',
    '   🚫 忘了就说「记不清了」，别换一个说法糊过去。',
    '🚫 不用主动拿出来讲 —— 别人问起、或者正好聊到才用。',
  ].join('\n');
}

/** 给自检 / 界面看 */
export function status() {
  const items = prune();
  return {
    total: items.length,
    keepDays: KEEP_DAYS,
    maxItems: MAX_ITEMS,
    file: file(),
    oldest: items.length ? items[0].text : '',
    items: items.map((x) => ({ date: x.date, at: x.at, text: x.text })),
  };
}

/** 测试用：清空 */
export function __clear() {
  saveRaw([]);
}

export const _consts = { KEEP_DAYS, MAX_ITEMS, MIN_TEXT, MAX_TEXT, MAX_PER_REPLY };
