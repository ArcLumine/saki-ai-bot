/**
 * 学习档案：机器人被教到的知识。
 *
 * ⚠️⚠️ **2026-09-27 彻底重构（用户拍板的 B 方案）** —— 原来是 `knowledge/learned.md`
 *    这**一个全局单文件**，于是「A 群教的东西，B 群和私聊全都看得到」。
 *    现在改成**按作用域分片**，一个 scope 一份：
 *
 *      scope                      落点                        谁看得到
 *      ─────────────────────────  ──────────────────────────  ──────────────────
 *      `global`                   `knowledge/global.md`       **所有群 + 所有私聊**
 *      `group:<群号>`             `knowledge/groups/<群号>.md` 只有那一个群
 *      `dm:<QQ号>`                `knowledge/dm/<QQ号>.md`     只有跟那个人私聊时
 *
 *    **归属是权限驱动的**（用户 2026-09-27 定）：
 *      · 发送者是 **owner（服主）** → `global`（他教的到处都适用）
 *      · 别人在群里教 → `group:<那个群>`
 *      · 别人在私聊里教 → `dm:<那个人>`
 *
 *    为什么 `global` 能全局注入而 groups/dm 不行 —— 这就是"服主的规则"和
 *    "某个群的梗"的区别：后者带到别的群去讲会让群友觉得莫名其妙。
 *
 * 设计要点（这些是从老版本继承的，没动）：
 *   - 内容插在 `<!-- LEARNED:BEGIN -->` 和 `<!-- LEARNED:END -->` 之间
 *   - 每个条目是一个 `## 主题`，教同一主题会**覆盖**旧的（群主选的行为）
 *   - 但它**不会删除**原文，而是在提示词里声明「learned 优先级更高」来实现覆盖
 *   - 每次改动都在「修改记录」里留一行 + 保存被覆盖的旧内容，教错了能回滚
 *
 * ⚠️ **读写都直接走磁盘，不走 `groupFiles` 缓存** —— 那份缓存要等 `reload()` 才更新，
 *    而「记住：xxx」之后**下一秒就要能答上来**，走缓存会慢一拍（表现为"教了但没记住"）。
 *    反过来注入时要 strip 掉 LEARNED 区，免得 `groups/<群号>.md` 的内容里带一遍、
 *    这里又带一遍（见 `stripLearned()`）。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { ROOT, KNOWLEDGE_DIR } from './config.js';
import { log } from './log.js';
// ⚠️ 2026-09-28：新建骨架的标题要用「主人」的真称呼（从 identity 填），不再写死旧叫法
import { callOwner } from './persona.js';
import { backupKnowledge } from './backup.js';

/** 全局层（owner 教的，所有群和私聊都读） */
const GLOBAL = join(KNOWLEDGE_DIR, 'global.md');
const BEGIN = '<!-- LEARNED:BEGIN -->';
const END = '<!-- LEARNED:END -->';
/** 单条知识最大长度，防止有人灌长文 */
const MAX_FACT = 2000;

/**
 * 这个 scope 的知识存在哪个文件。
 * @param {string} [scope] `global`（默认）/ `group:<群号>` / `dm:<QQ号>`
 */
export function fileForScope(scope = 'global') {
  const s = String(scope ?? 'global').trim() || 'global';
  if (s.startsWith('group:')) {
    const gid = s.slice(6).trim();
    if (gid) return join(KNOWLEDGE_DIR, 'groups', `${gid}.md`);
  } else if (s.startsWith('dm:')) {
    const uid = s.slice(3).trim();
    if (uid) return join(KNOWLEDGE_DIR, 'dm', `${uid}.md`);
  }
  return GLOBAL;
}

/** 这个 scope 的给人看的路径（日志/回执用） */
function scopeLabel(scope) {
  const s = String(scope ?? 'global').trim() || 'global';
  if (s.startsWith('group:')) return `groups/${s.slice(6).trim()}.md`;
  if (s.startsWith('dm:')) return `dm/${s.slice(3).trim()}.md`;
  return 'global.md';
}

/**
 * 一个**空档案**该长什么样（第一次被教时用）。
 * ⚠️ 骨架要跟 observe 那边分得开（`patchFile` 里也建骨架）—— 人一眼能看出这是学来的知识。
 */
function skeleton(scope) {
  const s = String(scope ?? 'global');
  const head = s.startsWith('dm:')
    ? '# 私聊里学到的（跟这个人有关的）\n'
    : s.startsWith('group:')
      ? '# 这个群教我的（只在这个群算数）\n'
      // ⚠️ 2026-09-28：原来写死「服主教的知识」—— 那是上一代的叫法（生分、且是身份不是称呼）。
      //    现在从 `identity.address.owner` **填进来**：换称呼只改那一处，这里跟着变。
      : `# ${callOwner() || '主人'}教的知识（所有群、所有私聊都算数）\n`;
  return `${head}\n> ⚠️ 下面两个 \`<!-- LEARNED:* -->\` 标记不能删 —— 代码靠它们定位条目，\n>     删了整个文件的解析就废了（\`test/learned-edit.js\` 会报错）。\n\n${BEGIN}\n${END}\n\n## 修改记录\n\n<!-- 每次新增/覆盖都会在这里留一行，方便回滚。最新的在最上面。 -->\n`;
}

/**
 * 读某个 scope 的正文。
 *
 * ⚠️ 文件不存在 → 返回**骨架**（含 BEGIN/END），不是空串 —— 否则 `learn()` 会
 *    报「缺少标记行，已被破坏」，而用户看到的是"我教了它没反应"，极难查。
 * ⚠️ 文件存在但没有标记区（比如 `groups/<群号>.md` 只有 observe 的 AUTO-OBSERVE 区）
 *    → 由 `ensureBlock()` 补一对标记，同样不能报错。
 */
function read(scope) {
  const f = fileForScope(scope);
  try {
    return readFileSync(f, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return skeleton(scope);
    log.error(`读取 ${basename(f)} 失败: ${e.message}`);
    return '';
  }
}

/** 文件里没有 LEARNED 标记区就补一对（observe 先建的骨架就属于这种） */
function ensureBlock(text, scope) {
  const t = String(text ?? '');
  if (t.includes(BEGIN) && t.includes(END)) return t;
  if (!t.trim()) return skeleton(scope);
  return `${t.trimEnd()}\n\n## 学到的知识（群主教的）\n\n${BEGIN}\n${END}\n`;
}

function write(content, scope) {
  const f = fileForScope(scope);
  // ⚠️ 改之前先备份 —— 教错了 / 模型抽错了没法回滚
  //    （真实踩过：把分享卡片里的玩笑话抽成了知识）。
  try {
    mkdirSync(dirname(f), { recursive: true });
  } catch (e) {
    log.warn(`建目录 ${dirname(f)} 失败（写盘那步会再报一次）：${e.message}`);
  }
  backupKnowledge(f);
  // 先写临时文件再改名，避免写一半断电留下坏文件
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, f);
}

/** 取出两个标记之间的正文 */
function extractBlock(text) {
  const i = text.indexOf(BEGIN);
  const j = text.indexOf(END);
  if (i === -1 || j === -1 || j < i) return '';
  return text.slice(i + BEGIN.length, j);
}

/** 把正文按 `## 主题` 切成条目 */
function parseEntries(block) {
  const entries = [];
  const re = /^##\s+(.+?)\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(block)) !== null) {
    marks.push({ title: m[1].trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  for (let k = 0; k < marks.length; k++) {
    const end = k + 1 < marks.length ? marks[k + 1].start : block.length;
    entries.push({
      title: marks[k].title,
      body: block.slice(marks[k].bodyStart, end).trim(),
    });
  }
  return entries;
}

function renderEntries(entries) {
  if (!entries.length) return '';
  return (
    '\n' +
    entries
      .map((e) => `## ${e.title}\n\n${e.body}`)
      .join('\n\n') +
    '\n\n'
  );
}

/**
 * 读某个 scope 的全部条目。
 * @param {string} [scope] `global`（默认）/ `group:<群号>` / `dm:<QQ号>`
 */
export function listEntries(scope = 'global') {
  const text = ensureBlock(read(scope), scope);
  return parseEntries(extractBlock(text));
}

/**
 * 把某个 scope 里 `<!-- LEARNED:BEGIN/END -->` 那一段**从文件正文里摘掉**。
 *
 * ⚠️ 为什么需要：`groups/<群号>.md` / `dm/<QQ号>.md` 是 **observe（群友观察）和 learned
 *    共用**的两个文件，两块内容各有一对标记。注入提示词时走的是两条路：
 *      · 文件整份内容 → `groupFiles` 缓存（observe 的世界）
 *      · 这里的 learned 条目 → `learnedText()` 按需挑（learned 的世界）
 *    不 strip 的话，同一个群的 learned 条目**会被带两遍**（探针那种"塞两遍"的重复）。
 *
 * @param {string} text 文件正文
 * @returns {string} 摘掉 LEARNED 区之后的正文
 */
export function stripLearned(text) {
  const t = String(text ?? '');
  const i = t.indexOf(BEGIN);
  const j = t.indexOf(END);
  if (i === -1 || j === -1 || j < i) return t;
  const after = j + END.length;
  // 连同后面紧跟的换行一起摘，别留下一大段空白
  let end = after;
  while (end < t.length && (t[end] === '\r' || t[end] === '\n')) end++;
  return (t.slice(0, i) + t.slice(end)).replace(/\n{3,}/g, '\n\n');
}

/**
 * 这条知识跟当前这句话沾不沾边。
 *
 * 判据：**标题的连续片段出现在消息里**。
 * 标题就是主题名（「OP获取链接」「大坝豆圣别名」「上浮的含义」），本身就带着查它的那个词。
 *
 * ⚠️⚠️ 2026-09-17：**第一版按标点拆标题，中文标题拆不开，等于没用**。
 *    探针抓到的：「大坝豆圣是谁」对不上标题「大坝豆圣别名」
 *    —— 因为它不含"大坝豆圣别名"这一整串，而我的拆分只得到这一整串。
 *    所以改成**滑窗**：把标题切成所有 3~6 字的连续片段，任一命中就算沾边。
 *
 * ⚠️ 从 **2 字**起滑窗（第一版从 3 字起，探针立刻抓到：「上浮是什么意思」对不上标题
 *    「上浮的含义」—— 因为"上浮"只有 2 字，3 字起的滑窗全落空了）。
 *    代价是「机器人应答风格」这类标题里的"机器"会经常误命中，但那**只多带一条**
 *    （约 200 字）；而漏掉一条她会**直接答错**。两边代价不对称，所以取宽的。
 *    **宁可多带一条，也不能漏。**
 */
function entryMatches(entry, text) {
  const hay = String(text).toLowerCase();
  const title = String(entry.title ?? '').trim();
  if (title.length < 2) return false;
  // 标题本身很短（2~3 字）时直接整串比，别滑窗
  if (title.length <= 3) return hay.includes(title.toLowerCase());

  for (let len = Math.min(6, title.length); len >= 2; len--) {
    for (let i = 0; i + len <= title.length; i++) {
      if (hay.includes(title.slice(i, i + len).toLowerCase())) return true;
    }
  }
  return false;
}

/** 把一条知识渲染成给模型看的样子 */
const fmtEntry = (e) => `## ${e.title}\n\n${e.body}`;

/**
 * 给模型看的正文（只有条目部分，不含注释和维护说明）。
 *
 * ⚠️⚠️ 2026-09-17：**加了"按需挑"**（原来是无条件全带上，那份 12.4K）。
 *
 *    用户的担心是「上下文太长偶尔会漏掉某一条规则」—— 一份 12.4K 的补充知识
 *    一直挂在提示词里，既稀释了真正该看的规则，也容易让话题被带偏。
 *    而且它是**最高优先级、会覆盖别人**的，一直挂着反而会压住更该说的话。
 *
 *    · **给了 `text`** → 只带**沾边**的那几条（一条都不沾边就返回空串）；
 *    · **没给 `text`** → 照旧全带上（兼容老调用点和界面预览）。
 *
 * @param {string} [text] 对方说的话（用来挑相关条目）
 * @param {string} [scope] 哪一份：`global`（默认）/ `group:<群号>` / `dm:<QQ号>`
 */
export function learnedText(text = '', scope = 'global') {
  const entries = listEntries(scope);
  if (!entries.length) return '';

  const t = String(text ?? '').trim();
  // 没给文本 = 老行为（全带）。⚠️ 界面上的"预览/统计"就是靠这条路径。
  if (!t) return entries.map(fmtEntry).join('\n\n');

  const hit = entries.filter((e) => entryMatches(e, t));
  // ⚠️ 一条都没命中就返回空串 —— 返回全部的话，这次改造等于白做。
  if (!hit.length) return '';
  return hit.map(fmtEntry).join('\n\n');
}

/**
 * 新增或覆盖一个主题。
 * @param {string} topic 主题名（同名的会被覆盖）
 * @param {string} fact 内容
 * @param {{by?:string, byName?:string, where?:string, scope?:string}} meta
 *   来源信息 + **归属**：`scope` 决定落进哪份文件（缺省 `global`）。
 *   归属该填什么由调用方（`saveKnowledge()`）按权限判 —— owner→global、
 *   群聊→group:<群号>、私聊→dm:<QQ号>。
 * @returns {{ok:boolean, replaced:boolean, error?:string, topic:string}}
 */
export function learn(topic, fact, meta = {}) {
  const t = String(topic ?? '').trim();
  const f = String(fact ?? '').trim();
  const scope = String(meta.scope ?? 'global').trim() || 'global';

  if (!t) return { ok: false, error: '主题为空', topic: t };
  if (!f) return { ok: false, error: '内容为空', topic: t };
  if (t.length > 60) return { ok: false, error: '主题太长（限 60 字）', topic: t };
  if (f.length > MAX_FACT) return { ok: false, error: `内容太长（限 ${MAX_FACT} 字）`, topic: t };

  // ⚠️ 这里**不要**直接用 `read()`：文件可能是 observe 先建的骨架（没有 LEARNED 区），
  //    那种情况要补标记区继续写，而不是报错让用户以为文件坏了。
  const text = ensureBlock(read(scope), scope);
  if (!text.includes(BEGIN) || !text.includes(END)) {
    return { ok: false, error: `${scopeLabel(scope)} 缺少标记行，已被破坏`, topic: t };
  }

  const block = extractBlock(text);
  const entries = parseEntries(block);

  // 同名主题覆盖；否则追加
  const idx = entries.findIndex((e) => e.title === t);
  const replaced = idx !== -1;
  const oldBody = replaced ? entries[idx].body : '';

  const stamped = `${f}\n\n> 由 ${meta.byName ?? meta.by ?? '未知'} 于 ${now()} 通过 ${
    meta.where ?? '群聊'
  } 教学录入。`;
  const entry = { title: t, body: stamped };

  if (replaced) entries[idx] = entry;
  else entries.push(entry);

  // 重建文件
  let out = text.slice(0, text.indexOf(BEGIN) + BEGIN.length);
  out += renderEntries(entries);
  out += text.slice(text.indexOf(END));

  // 记一笔修改记录（插在「修改记录」标题后面，最新的在最上面）
  const logLine = `- ${now()} **${replaced ? '覆盖' : '新增'}**「${t}」 by ${
    meta.byName ?? meta.by ?? '?'
  }${oldBody ? `\n  - 被覆盖的旧内容：${oldBody.split('\n')[0].slice(0, 120)}` : ''}`;
  out = insertChangeLog(out, logLine);

  try {
    write(out, scope);
    log.info(`${scopeLabel(scope)} ${replaced ? '覆盖' : '新增'}主题「${t}」（${f.length} 字）`);
    return { ok: true, replaced, topic: t };
  } catch (e) {
    log.error(`写入 ${scopeLabel(scope)} 失败: ${e.message}`);
    return { ok: false, error: e.message, topic: t };
  }
}

function insertChangeLog(text, line) {
  const marker = '## 修改记录';
  const i = text.indexOf(marker);
  if (i === -1) return text + '\n' + line + '\n';
  const after = i + marker.length;
  return text.slice(0, after) + '\n\n' + line + text.slice(after);
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/**
 * 校验一份 `learned.md` 的**正文能不能被解析**（给管理界面直接编辑用）。
 *
 * ⚠️ 为什么必须校验（2026-09-14 用户要求「learned.md 也能修改」）：
 *
 *    这个文件**和别的知识库不一样** —— 它不是纯给模型读的散文，
 *    而是**代码在解析和维护**的：条目必须是 `## 主题`，
 *    而且必须有 `<!-- LEARNED:BEGIN -->` / `END` 两个标记。
 *
 *    界面上一旦把这些改坏（比如标记被删了、`##` 被改成 `#`），
 *    `learn()` / `forget()` / `listEntries()` 会**静默失效**：
 *    `learn()` 会直接返回「learned.md 缺少标记行，已被破坏」，
 *    而群主在群里说「记住：xxx」就没反应了 —— 很难查。
 *
 *    所以保存前先校验，不合格就**拒绝保存并说清原因**，
 *    总比让用户存进去、过几天发现"教了但没记住"要好。
 *
 * @param {string} text 整份文件内容
 * @returns {{ok:boolean, error?:string, entries?:number}}
 */
export function validateFile(text) {
  const t = String(text ?? '');
  const i = t.indexOf(BEGIN);
  const j = t.indexOf(END);
  if (i === -1) return { ok: false, error: `缺少 ${BEGIN} 这一行（这是代码用来定位条目的标记，不能删）` };
  if (j === -1) return { ok: false, error: `缺少 ${END} 这一行` };
  if (j < i) return { ok: false, error: `${END} 跑到 ${BEGIN} 前面了` };

  const block = t.slice(i + BEGIN.length, j);
  const entries = parseEntries(block);

  // ⚠️ 「有内容但没有一条 `## 主题`」= 解析器眼里的**空档案** —— 内容全丢了，
  //    但文件看着还有字，最容易骗过肉眼。
  if (!entries.length && block.replace(/\s/g, '')) {
    return {
      ok: false,
      error: 'BEGIN/END 之间只有文字，但没有一条 `## 主题` —— 这样代码解析不出任何条目（等于内容丢了）。每条知识都要以 `## 主题` 开头',
    };
  }
  const noBody = entries.find((e) => !e.body);
  if (noBody) return { ok: false, error: `条目「${noBody.title}」下面是空的` };
  const badTitle = entries.find((e) => e.title.includes('#'));
  if (badTitle) return { ok: false, error: `主题名里有 #：「${badTitle.title}」` };

  return { ok: true, entries: entries.length };
}

/**
 * 删掉某个主题（群主可以用「忘记：xxx」）。
 * @param {string} topic 主题名
 * @param {string} [scope] 从哪一份里删（默认 `global`）
 */
export function forget(topic, scope = 'global') {
  const t = String(topic ?? '').trim();
  const text = ensureBlock(read(scope), scope);
  const entries = parseEntries(extractBlock(text));
  const idx = entries.findIndex((e) => e.title === t);
  if (idx === -1) return { ok: false, error: `没有找到主题「${t}」` };

  const removed = entries.splice(idx, 1)[0];
  let out = text.slice(0, text.indexOf(BEGIN) + BEGIN.length);
  out += renderEntries(entries);
  out += text.slice(text.indexOf(END));
  out = insertChangeLog(out, `- ${now()} **删除**「${t}」`);
  write(out, scope);
  log.info(`${scopeLabel(scope)} 删除主题「${t}」`);
  return { ok: true, topic: t, removed: removed.body };
}

/**
 * 这个 scope 有没有对应的知识文件（**还没被教过就没有**）。
 * @param {string} [scope]
 */
export function fileExists(scope = 'global') {
  return existsSync(fileForScope(scope));
}
