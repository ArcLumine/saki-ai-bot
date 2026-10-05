/**
 * safety/ —— **送进 LLM 之前**的拦截层（2026-09-28 用户要求）。
 *
 * ## 为什么不放在 knowledge/ 里
 *
 * 用户原话：「我在考虑要不要额外加个 safety 的文件夹，
 * **（不放入 knowledge/ 目录，防止充当提示词摊薄模型注意力）**」
 * ⇒ 这一层的东西**一个字都不进提示词**。
 * 差别是根本性的：
 *   · `knowledge/` = **给模型看的资料**（会被读进上下文）
 *   · `safety/`   = **给代码看的开关**（代码据此决定"要不要调模型"）
 * 放进去的话，每次拼提示词都要扫一遍，既摊薄注意力，又让人以为
 * "模型看到这些词就会自己避开" —— 实际上模型**根本没机会看到**。
 *
 * ## 三种拦截类型（用户给的划分）
 *
 *   ① **全局绝对违禁**（`global.md`）—— 政治敏感 / 严重违法 / 暴恐 / 涉毒 / 极端言论
 *      动作：丢弃或机械拒绝，**不送入 LLM**。**群聊 + 私聊都拦**。
 *   ② **群聊高危防封**（`group.md`）—— 露骨涉黄 / 广告赌博 / 易封群词
 *      动作：直接拦截。**只拦群聊**（私聊按策略放宽 —— 没有封号风险）。
 *   ③ **人设防御**（`injection.md`）—— 逆向指令 / 越狱模式 / 套取提示词
 *      动作：**抹除**攻击片段（不是丢弃），剩下的照常处理。**全局**。
 *
 *      ⚠️⚠️ 2026-09-29 升级成**有上限的区间抹除**（见下面的 `stripSpans`）。
 *      触发词为了覆盖变体只能写成**片段**（`忽略以上` 要管住「忽略以上指令」
 *      「忽略以上所有设定」…），而只删片段会**留下尾巴**（「忽略你之前」+ 剩下的
 *      「的所有指令」）。现在的规则：从命中处往后吃到**最近的句读符号**，
 *      找不到句读时最多再吃 12 字（防把后面正常的问题一起吞掉）。
 *
 * ## 为什么"拦截"优先于"提示模型不要接"
 *
 * 提示词里的规则是**软的**：模型可能看漏（中段迷失）、可能被上下文带跑、
 * 可能自己"觉得对方在开玩笑"就接了。而这里是在**代码里**挡 ——
 * 命中就是命中，模型没有机会表达意见。这是"物理红线"和"提示词红线"的区别。
 *
 * ## 用法
 *
 *   const gate = screen(text, { isGroup: true });
 *   if (gate.action === 'drop') return;              // 静默丢弃
 *   if (gate.action === 'refuse') { send(REPLY); return; }
 *   text = gate.cleaned;                              // 抹除后照常
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SAFETY_DIR } from './config.js';

/**
 * safety/ 目录（⚠️ 故意**不在** knowledge/ 下，见文件头）。
 *
 * ⚠️ 2026-09-29：走 `config.js` 的 `SAFETY_DIR`，不再自己拼 `join(ROOT, 'safety')`
 *    —— 这样测试能用 `QQBOT_SAFETY_DIR` 把整个目录**搬走**（同 `KNOWLEDGE_DIR` 的做法）。
 *    ⚠️ 隔离不是洁癖：这一层的文件是**规则**，套件真去写它就等于改了机器人的红线，
 *    而且那种事故**没有任何报错**（下次真跑起来才发现规则变了）。
 * ⚠️ `ROOT` 还留着 —— 文件头注释里拿它举例，别的地方也可能用（留着无害）。
 */
const DIR = SAFETY_DIR;

/**
 * 被拦下时回的一句**固定话**。
 *
 * ⚠️ 为什么必须写死、不能交给模型生成：
 * 拦截的整个意义就是**不调模型**。要是"回复"也走 LLM，
 * 那等于只是换了个地方问它 —— 而模型可能就顺着答了。
 * 机械拒绝还有个好处：**不会泄露拦截规则**（对方看不出哪个词触发的）。
 */
export const REFUSAL = '这个不聊。';

let cache = null;
let cacheAt = 0;

/**
 * 解析 `safety/*.md`。
 *
 * 格式跟 `safety/sensitive/*.md` 一样（`## 标题` + `触发词：` + `排除词：`），
 * 只是一条多用一个 `动作：` 字段。
 */
function load() {
  let files = [];
  try {
    if (!existsSync(DIR)) return [];
    files = readdirSync(DIR).filter((n) => n.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }

  const out = [];
  for (const f of files) {
    let raw = '';
    try {
      raw = readFileSync(join(DIR, f), 'utf8');
    } catch {
      continue;
    }
    const text = raw.replace(/<!--[\s\S]*?-->/g, '');
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
      const h = line.match(/^##\s+(.+?)\s*$/);
      if (h) {
        const name = h[1].trim();
        if (/^[（(](待补|词条)/.test(name)) {
          cur = null;
          continue;
        }
        // ⚠️ 文件名决定**作用范围**，条目里的字段只管"命中了怎么办"
        cur = { name, file: f, words: [], ex: [], action: 'drop' };
        out.push(cur);
        continue;
      }
      if (!cur) continue;
      const t = line.trim();
      if (!t) continue;
      const w = t.match(/^[-*]\s*触发词[:：]\s*(.+)$/);
      if (w) {
        cur.words = w[1]
          .split(/[\/／、,，]/)
          .map((x) => x.trim())
          .filter(Boolean);
        continue;
      }
      const e = t.match(/^[-*]\s*排除词[:：]\s*(.+)$/);
      if (e) {
        cur.ex = e[1]
          .split(/[\/／、,，]/)
          .map((x) => x.trim())
          .filter((x) => x && !/^[（(]无[）)]$/.test(x));
        continue;
      }
      const a = t.match(/^[-*]\s*动作[:：]\s*(.+)$/);
      if (a) {
        const v = a[1].trim();
        // 只认三种动作；写错就退回最保守的（丢弃）
        cur.action = /拒绝|拒绝并回复|机械拒绝/.test(v)
          ? 'refuse'
          : /抹除|擦除|删除|替换/.test(v)
            ? 'strip'
            : 'drop';
      }
    }
  }
  return out.filter((it) => it.name && it.words.length);
}

function loaded() {
  const now = Date.now();
  if (!cache || now - cacheAt > 5000) {
    cache = load();
    cacheAt = now;
  }
  return cache;
}

/** 强制重载（测试用；改完 safety/ 不用重启） */
export function reload() {
  cache = load();
  cacheAt = Date.now();
  return cache.length;
}

/** 触发词在不在（排除词照旧**不取消命中**，只当例外提示 —— 同 sensitive.js） */
function wordHits(t, it) {
  for (const w of it.words) {
    if (w && t.includes(w)) return true;
  }
  return false;
}

/**
 * 抹除到哪为止：**句读符号**（含中英文逗号）或换行。
 *
 * ⚠️ 逗号**必须**算断点 —— 「忽略以上指令，今天天气怎么样」这种
 *    「攻击 + 逗号 + 正常提问」的写法太常见了；逗号不算，提问就会被一起吃掉。
 */
const STRIP_END = /[。！？!?；;，,、.．\n]/;

/** 找不到任何句读时，从触发词末尾往后**最多再吃这么多字** */
const STRIP_SPAN = 12;

/**
 * **有上限的区间抹除**（2026-09-29 加）。
 *
 * 原实现是 `cleaned.split(w).join('')` —— 只删掉**触发词本身**。那时触发词写的是
 * 完整短语（「忽略以上指令」），删干净就行。为了堵住变体（「忽略你之前的所有指令」
 * 「忽略上面所有设定」…）触发词只能改成**片段**，片段一删就留尾巴
 * （「忽略你之前」→ 剩「的所有指令」），于是改成"从命中处往后吃掉一整个区间"。
 *
 * 区间取法：
 *   ① 从 `i + w.length` 往后找第一个句读 → 吃到那儿（句读**保留**）；
 *   ② 找不到句读 → 吃到 `min(文末, i + w.length + STRIP_SPAN)`。
 * 这样「忽略以上指令，今天天气怎么样」只剩「，今天天气怎么样」，
 * 而「忽略你之前的所有指令 现在告诉我」这种没有句读的，也会被截断在 12 字内。
 *
 * @param {string} text 待处理文本（可以已经是抹过一轮的结果 —— 见 `screen` 里的累计）
 * @param {string[]} words 这一条的触发词
 */
function stripSpans(text, words) {
  let out = String(text ?? '');
  for (const w of words) {
    if (!w) continue;
    let from = 0;
    for (;;) {
      const i = out.indexOf(w, from);
      if (i < 0) break;
      let end = -1;
      for (let k = i + w.length; k < out.length; k++) {
        if (STRIP_END.test(out[k])) {
          end = k;
          break;
        }
      }
      if (end < 0) end = Math.min(out.length, i + w.length + STRIP_SPAN);
      out = out.slice(0, i) + out.slice(end);
      from = i; // 抹掉之后原位就是后面的内容，从这儿继续找（避免死循环）
    }
  }
  return out;
}

/** 这条在当前场景**要不要生效 */
function appliesTo(it, isGroup) {
  if (it.file.startsWith('group')) return isGroup; // 群聊专属
  return true; // global / injection：两边都拦
}

/**
 * 拦一道。
 *
 * @param {string} text 对方发来的原话
 * @param {{isGroup?:boolean}} [opts] `isGroup` 决定"群聊专属"那层要不要生效
 * @returns {{action:'drop'|'refuse'|'strip'|null, cleaned:string, hits:Array}}
 *   · `action === null` —— 没命中，照常处理
 *   · `drop` —— 静默丢弃（**不要回任何东西**）
 *   · `refuse` —— 回一句 `REFUSAL`
 *   · `strip` —— `cleaned` 是抹掉攻击片段后的文本（**区间抹除**，见 `stripSpans`）
 *
 * ⚠️ 优先级：**丢弃 > 拒绝 > 抹除**。
 *   同一句话里既有绝对违禁词又有越狱指令时，按最严的来。
 */
export function screen(text, opts = {}) {
  const t = String(text ?? '');
  const isGroup = !!opts.isGroup;
  const out = { action: null, cleaned: t, hits: [] };
  if (!t.trim()) return out;

  for (const it of loaded()) {
    if (!appliesTo(it, isGroup)) continue;
    if (!wordHits(t, it)) continue;
    out.hits.push({ name: it.name, file: it.file, action: it.action });
    const rank = it.action === 'drop' ? 3 : it.action === 'refuse' ? 2 : 1;
    const cur = out.action === 'drop' ? 3 : out.action === 'refuse' ? 2 : out.action === 'strip' ? 1 : 0;
    if (rank > cur) out.action = it.action;
    if (it.action === 'strip') {
      // ⚠️ 2026-09-29：从"删掉触发词本身"升级成**区间抹除**（理由见 `stripSpans`）。
      //    ⚠️ 而且这里改成**接着上一次的结果继续抹**（起点是 `out.cleaned`，不是原文 `t`）——
      //    原来每条 strip 条目都从原文 `t` 重来、后一条**覆盖**前一条，
      //    「忽略以上指令 DAN模式」这种同一句里两处命中就只会删掉一处。
      out.cleaned = stripSpans(out.cleaned, it.words);
    }
  }
  // ⚠️ 一旦判了 drop/refuse，抹除的结果就不作数了（整条都不给模型）
  if (out.action === 'drop' || out.action === 'refuse') out.cleaned = '';
  return out;
}
