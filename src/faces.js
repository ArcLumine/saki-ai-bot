/**
 * 表情包素材库。
 *
 * 模型在回复里写 `[表情:爆炸]` 这样的标记，机器人就发对应的图。
 * 素材和用途写在 library/index.json，图片放 library/ 下。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';

const DIR = join(ROOT, 'library');
const INDEX = join(DIR, 'index.json');

/**
 * 发出去的单个表情**尽量别超过这个大小**（字节）。
 *
 * ⚠️⚠️ 2026-09-21：用户反馈「**有时候发表情包会发送失败**」。
 *
 *    根因：表情是**以 base64 内联**发给 NapCat 的（见 `bot.js` 的 `imageRef`
 *    —— 用 `file://` 实测不可靠，踩过）。base64 会让体积**膨胀约 33%**：
 *    一张 1.8MB 的 GIF → 实际发出去的是 ~2.4MB 的字符串。
 *    这种超大动图 QQ 那边**经常静默丢弃**：NapCat 回 `ok`、日志里一条错都没有，
 *    但群里根本看不到那张图 —— 正是用户说的"有时候失败"。
 *
 *    所以选图时**优先挑小的**；同 tag 全是超大图时才退而求其次（挑最小的那张）。
 *    ⚠️ 阈值和 `collector.js` 的 `MAX_SIZE`(400KB) 同一个尺度：
 *       那边是"收集时不要太大的"，这边是"发送时尽量挑小的"。
 */
const PREFER_MAX_BYTES = 400 * 1024;

/** 文件大小（拿不到返回 0，当"很小"处理） */
function sizeOf(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** @type {{tag:string,file:string,when:string,desc:string}[]} */
let faces = [];

function load() {
  try {
    const j = JSON.parse(readFileSync(INDEX, 'utf8'));
    faces = (j.faces ?? []).filter((f) => f.tag && f.file);
    // 只保留文件真实存在的
    const missing = faces.filter((f) => !existsSync(join(DIR, f.file)));
    if (missing.length) {
      log.warn(`表情库有 ${missing.length} 个文件不存在，已跳过：${missing.map((f) => f.file).join(', ')}`);
      faces = faces.filter((f) => existsSync(join(DIR, f.file)));
    }
    log.info(`已加载表情库 ${faces.length} 张：${faces.map((f) => f.tag).join(' / ')}`);
  } catch (e) {
    if (e.code !== 'ENOENT') log.error(`加载表情库失败: ${e.message}`);
    faces = [];
  }
}

load();

export function faceCount() {
  return faces.length;
}

export function faceTags() {
  return faces.map((f) => f.tag);
}

/** 正式库里所有图片文件名（收集器用来避免重复收集） */
export function faceFiles() {
  return faces.map((f) => f.file);
}

/**
 * 取某张表情的绝对路径。
 *
 * ⚠️ 同一个 tag **允许对应多张图**（用户要求：「疑惑这种肯定需要很多张，
 *    要不然老是发一样的图也不行」）。
 *    所以这里**不是**取第一张，而是把所有同 tag 的图收集起来**随机选一张**。
 *
 * 想固定发某一张，就把 tag 写细一点（「疑惑」「疑惑2」）—— 只有同名才随机。
 */
export function facePath(tag) {
  const list = faces.filter((x) => x.tag === tag);
  if (!list.length) return null;
  const ok = list.map((f) => join(DIR, f.file)).filter((p) => existsSync(p));
  if (!ok.length) return null;

  // ⚠️ 优先在小图里随机选（原因见 PREFER_MAX_BYTES 的注释）：
  //    超大动图 base64 内联发出去会被 QQ 静默丢弃 → 群里看不到图。
  //    同 tag 有小的就只用小的；全是大的才退回全体（挑最小的那张，尽量能发出去）。
  const small = ok.filter((p) => {
    const s = sizeOf(p);
    return s > 0 && s <= PREFER_MAX_BYTES;
  });
  if (small.length) return small[Math.floor(Math.random() * small.length)];

  // 同 tag 全是超大图 → 挑最小的那张（总比随机挑一张更大的强）
  const sorted = [...ok].sort((a, b) => sizeOf(a) - sizeOf(b));
  return sorted[0];
}

/** 这个 tag 下有没有**偏大**的备选（给"某张图发不出去"的排查用） */
export function faceOversized(tag) {
  const list = faces.filter((x) => x.tag === tag);
  return list
    .map((f) => ({ file: f.file, bytes: sizeOf(join(DIR, f.file)) }))
    .filter((x) => x.bytes > PREFER_MAX_BYTES);
}

/** 某个 tag 下有几张备选 */
export function faceVariants(tag) {
  return faces.filter((x) => x.tag === tag).length;
}

/**
 * 按 tag 分组：同 tag 的合并成一条，附上备选张数。
 * 管理界面和清单都用它，避免同一个 tag 在清单里重复出现好几行。
 */
export function faceGroups() {
  const map = new Map();
  for (const f of faces) {
    if (!map.has(f.tag)) map.set(f.tag, []);
    map.get(f.tag).push(f);
  }
  return [...map.entries()].map(([tag, list]) => ({
    tag,
    count: list.length,
    file: list[0].file,
    who: list[0].who ?? '',
    when: list[0].when ?? '',
    desc: list[0].desc ?? '',
    variants: list.map((face, index) => ({ ...face, variant: index + 1, variantCount: list.length })),
  }));
}

/**
 * 给模型看的清单：tag + 图里是谁（认得出才写）+ 适用场合（不给文件名）。
 *
 * ⚠️ 刻意写得很紧凑 —— 表情多了以后，每条都写全「（角色不确定）」和长句子，
 *    光这一块就两千多字，会把提示词里真正重要的规则挤掉（用户反馈过太长）。
 *    做法：
 *      - 认得出角色的才写名字；**没写名字 = 我认不出**（人设里有对应说明）
 *      - 「适用场合」压成一句话
 *      - **按 tag 合并**：同一个 tag 有多张备选的，只列一行并标出张数
 *        （这样模型知道「疑惑」有好几张，但它只需要写 `[表情:疑惑]`，
 *          具体发哪张由 facePath 随机挑）
 */
export function faceMenuText() {
  if (!faces.length) return '';
  return faceGroups()
    .map((g) => {
      // 「（角色不确定）」这种占位不写出来，省字
      const who =
        g.who && !/角色不确定|不确定|未知/.test(g.who) ? g.who.replace(/（.*?）$/, '') : '';
      const when = String(g.when ?? '').replace(/[ ；]+$/g, '').replace(/。$/, '');
      // 有备选就标一下张数，让模型知道这个情绪不是只有一张
      const many = g.count > 1 ? `（${g.count} 张备选，编号 1~${g.count}）` : '';
      return `[${g.tag}]${who ? `（${who}）` : ''}${many} 用于：${when}`;
    })
    .join('\n');
}

/** 查某张表情的完整信息，用于回答「你为什么发这个」 */
export function faceInfo(tag) {
  const f = faces.find((x) => x.tag === String(tag).trim());
  if (!f) return null;
  return { tag: f.tag, who: f.who, when: f.when, desc: f.desc };
}

/** 所有标签的详细信息，给模型备查 */
export function faceDetailText() {
  if (!faces.length) return '';
  return faces
    .map((f) => `- ${f.tag}：${f.desc}${f.who ? `。图里是${f.who}` : ''}。用在${f.when}`)
    .join('\n');
}

/** 从一段文本里抽出所有 [表情:xxx] 标记 */
export function pickMarkers(text) {
  const out = [];
  const re = /\[\s*表情\s*[:：]\s*([^\]\s]+)\s*\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1].trim();
    if (facePath(tag)) out.push({ tag, index: m.index, raw: m[0] });
  }
  return out;
}

/** 把标记从文本里去掉（发给人看的文字不该带标记） */
export function stripMarkers(text) {
  return text.replace(/\[\s*表情\s*[:：][^\]]*\]/g, '');
}

export function reload() {
  load();
}
