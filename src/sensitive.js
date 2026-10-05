/**
 * 敏感词库（`safety/sensitive/*.md`，2026-09-29 从 `knowledge/sensitive/` 搬来）—— **总规则常驻 + 词条撞库**。
 *
 * ## 用户要求（2026-09-28）
 *
 *   「敏感词库改成撞库吧」「总规则得常驻，撞库进行复用逻辑新写一个 sensitive.js」
 *
 * 改之前（`knowledge.js` 里）它是**整份无条件全局注入** —— 68 行 / 每条消息都带，
 * 占 4.4 万字提示词里的一大块，而绝大多数消息**根本没提任何敏感词**。
 *
 * ## 现在拆成两半
 *
 *   · **总规则**（"只认不接""调戏→冷淡装傻岔开""排除词防误伤"）
 *     → `sensitiveRules()`，**无条件注入**，一直都在她眼前。
 *   · **17 个具体词条** → `sensitiveFor(text)`，**撞到才注入**
 *     （涉政/毒品/暴恐不在本文件 —— 那三类由 `safety/` 硬拦截 `drop`，2026-09-29 ④b 去重）。
 *
 * ## 为什么"总规则"必须常驻、词条可以按需
 *
 * 总规则是**方法论**（「只认不接」），不依赖具体是哪个词；
 * 词条是**词典**，没命中就是纯占位。撞库之后 99% 的消息不带那 68 行。
 *
 * ⚠️⚠️ 关于"撞库会不会来不及"（`knowledge.js` 原来那句注释担心：
 *    「等消息里出现敏感词才临时补，模型早就已经顺着接下去了」）：
 *    **不成立** —— 提示词是**同步拼完再发**的，不存在"模型已经接了才补规则"
 *    的时序。梗库一直是这么干的（`memes.js` 的 `memesFor`），运行正常。
 *
 * ## 与 `memes.js` 的关系：**刻意重复，不共用**
 *
 * 解析和匹配逻辑是照着 `memes.js` 抄的（**同一个文件格式**：`## 标题` +
 * `触发词：` / `类别：` / `排除词：` / `怎么处理：`）。但有三处**故意不同**：
 *
 *   ① **不加"玩梗信号"那一层**（`memes.js` 的 `hasSignal()`：复读/语气词/两梗同现）。
 *      那层是为"别把『这是经典案例』当梗"设计的 —— 敏感词不一样：
 *      「今天被老婆骂了」就是真敏感，加旁证判断反而会**漏判**。
 *   ② **不设档位**。梗库命中后要判 ★/★★/★★★；敏感类恒为「只认不接」。
 *   ③ 输出的引导语不同（见 `sensitiveFor`）。
 *
 * ⚠️ 不共用代码是刻意的：动 `memes.js` 的内部结构有回归风险（它正稳定服务着
 *   梗库），而这里只是 60 行、逻辑独立。等两边都跑稳了再考虑合并。
 *
 * 用法：
 *   import { sensitiveRules, sensitiveFor } from './sensitive.js';
 *   knowledge.js  → unconditional: sensitiveRules()
 *   bot.js        → if (sensitiveFor(currentText)) parts.push(...)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SAFETY_DIR } from './config.js';

/**
 * ⚠️ 2026-09-29：词库**搬家**了 —— 从 `knowledge/sensitive/` 搬到 `safety/sensitive/`
 *    （用户要求把「敏感」和「safety」合成一个安全模块，见 `config.js` 的 `SAFETY_DIR`）。
 *    这一层仍然是**软**的（拼进提示词给模型看），跟 `safety/*.md` 那层硬拦截是两回事。
 * ⚠️ 走 `SAFETY_DIR` 而不是 `join(ROOT, 'safety')`：测试能用 `QQBOT_SAFETY_DIR`
 *    整份搬走（`run-all.js` 会给每个套件一份副本）。
 */
const DIR = join(SAFETY_DIR, 'sensitive');

let cache = null;
let cacheAt = 0;

/** 读盘并解析所有 `sensitive/*.md`（失败/没有 → 空） */
function load() {
  let names = [];
  try {
    if (!existsSync(DIR)) return { rules: '', items: [] };
    names = readdirSync(DIR).filter((n) => n.toLowerCase().endsWith('.md'));
  } catch {
    return { rules: '', items: [] };
  }

  const rules = [];
  const items = [];
  for (const file of names) {
    let raw = '';
    try {
      raw = readFileSync(join(DIR, file), 'utf8');
    } catch {
      continue;
    }
    // 看的人用的说明（HTML 注释）解析时丢掉
    const text = raw.replace(/<!--[\s\S]*?-->/g, '');
    // ⚠️ 2026-09-28：改成**下标循环** —— 「怎么处理」是**多行**字段
    //    （首行 + 缩进续行），要把续行一并收进 `cur.how` 就得能跳行（`i = k`），
    //    `for...of` 迭代的是值、跳不了行。
    const lines = text.split(/\r?\n/);
    let cur = null;
    let curIsRule = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const h = line.match(/^##\s+(.+?)\s*$/);
      if (h) {
        const name = h[1].trim();
        // ⚠️ 空槽位不算条目：「（待补…）」/「（梗名）」等占位模板
        if (/^[（(](待补|梗名)/.test(name)) {
          cur = null;
          continue;
        }
        // ⚠️ 「总规则」这一节是**方法论**，不是词典条目 —— 它常驻，不参与撞库
        curIsRule = /总规则/.test(name);
        cur = { name, words: [], ex: [], category: curIsRule ? '规则' : '调戏', body: [], how: [] };
        (curIsRule ? rules : items).push(cur);
        continue;
      }
      if (!cur) continue;
      const t = line.trim();
      if (!t) continue;
      // - 触发词：社保        （没有触发词的段落后面会被过滤掉）
      const w = t.match(/^[-*]\s*触发词[:：]\s*(.+)$/);
      if (w) {
        cur.words = w[1]
          .split(/[\/／、,，]/)
          .map((x) => x.trim())
          .filter(Boolean);
        continue;
      }
      // - 排除词：奈良 / 奈奈    ← 命中这些**长词**时不算（防误伤的核心）
      const e = t.match(/^[-*]\s*排除词[:：]\s*(.+)$/);
      if (e) {
        cur.ex = e[1]
          .split(/[\/／、,，]/)
          .map((x) => x.trim())
          // ⚠️ 文件里写「（无）」表示"这条没有排除词" —— 别把它当成一个真词
          .filter((x) => x && !/^[（(]无[）)]$/.test(x));
        continue;
      }
      const c = t.match(/^[-*]\s*类别[:：]\s*(.+)$/);
      if (c) {
        cur.category = c[1].trim();
        continue;
      }
      // ⚠️⚠️ 2026-09-28：「怎么处理」提成**独立字段**，不再混进 `body`。
      //
      //    为什么必须提：它常是**多行**（首行 + 缩进续行），而且里面的措辞
      //    取决于**当前场景允不允许接这一档** —— 撒娇那条写的是「可以接一下」，
      //    但在**没进白名单**的群里，这句是**错的**。
      //    混在 `body` 里 = 数据里的话无条件生效，于是提示词里会同时出现
      //    「亲密言语一律不接」和「撒娇：可以接一下」—— **两套相反的话**，
      //    模型只能二选一，而它通常挑措辞更硬的那条 ⇒ 主人的私聊尺度就废了。
      //    ⇒ 提成字段后，由 `renderItem` 按「这档能不能接」**决定渲不渲染它**，
      //    不可接时换成通用那句 ⇒ 提示词里**永远不会出现两套相反的话**。
      const how = t.match(/^[-*]\s*怎么处理[:：]\s*([\s\S]*)$/);
      if (how) {
        cur.how.push(how[1]);
        for (let k = i + 1; k < lines.length; k++) {
          const nx = lines[k];
          if (!nx.trim()) break; // 空行 → 这段字段结束了
          if (!/^\s{2,}/.test(nx)) break; // 没缩进 → 已经是下一段
          if (/^[-*]\s*\S+[:：]/.test(nx.trim())) break; // 缩进但其实是新字段
          cur.how.push(nx.trim());
          i = k;
        }
        continue;
      }
      cur.body.push(t);
    }
  }
  // ⚠️ 没有触发词的不算词典条目（纯说明段，如「敏感类·调戏（统一策略）」）
  return {
    rules: rules.map((r) => [`## ${r.name}`, '', ...r.body].join('\n')).join('\n\n'),
    items: items.filter((it) => it.name && it.words.length),
  };
}

/** 取内存里的解析结果（带 5 秒缓存，避免一轮对话里反复读盘） */
function loaded() {
  const now = Date.now();
  if (!cache || now - cacheAt > 5000) {
    cache = load();
    cacheAt = now;
  }
  return cache;
}

/** 强制重载（测试用；界面热重载也可以调） */
export function reload() {
  cache = load();
  cacheAt = Date.now();
  return cache.items.length;
}

/**
 * 触发词在 `t` 里算不算命中。
 *
 * ⚠️⚠️⚠️ 2026-09-28 用户要求：「**敏感词宁可误中不回也不能放**」
 *
 *    ⇒ **排除词不再用来"取消命中"，只用来"标注例外"。**
 *
 *    原设计（照抄 `memes.js`）是"触发词落在排除词内部 → 不算命中"，
 *    那是**防误伤**方向 —— 宁可漏也不错。敏感词不能这样：
 *    漏掉的代价（她顺着接了）是**不可逆的**，误中的代价只是**答得生硬一点**。
 *
 *    所以现在：**只要触发词出现在句子里就算命中**，哪怕它整个落在排除词里。
 *    会误中一些 ——「我今天打雷了」命中「大雷/小雷」、「社保卡怎么查」命中「社保」。
 *    **这是刻意的**：宁可多提醒一句"这可能是雷"，也不能漏。
 *    真被误伤时怎么答，交给每条自己的「⚠️ 不算梗」那行 + 注入段里
 *    "只有列出的情况才按字面答" —— **判断权交给模型，不交给代码**。
 *
 *    ⇒ 代码这层只负责**绝不漏**；"是不是真雷"由提示词里的规则决定。
 *
 *    （梗库 `memes.js` **保持原样** —— 玩梗误中的代价是"抖机灵抖错了"，
 *      量级完全不同，而且用户当初的原话是「不要把所有同一种词都当玩梗」。）
 */
function wordHits(t, it) {
  for (const w of it.words) {
    if (w && t.includes(w)) return true;
  }
  return false;
}

/**
 * 这句话里出现了哪些敏感词条。
 *
 * ⚠️ 2026-09-28：判据**只看触发词在不在**（理由见 `wordHits` 上面）。
 *    排除词不再参与判定，只在渲染时作为"**例外**"提示带出去。
 */
export function hitsFor(text) {
  const t = String(text ?? '');
  if (!t) return [];
  return loaded().items.filter((it) => wordHits(t, it));
}

/**
 * 常驻的那一段（总规则）—— **无条件注入**。
 *
 * ⚠️ 由 `knowledge.js` 的 `knowledgeText()` 单独 push（不走 `picked` ——
 *    那张表是文件名，会被读盘，把词典也带进来）。
 *    拿不到内容时返回 ''（调用方自己跳过）。
 */
export function sensitiveRules() {
  return String(loaded().rules ?? '');
}

/**
 * ⚠️⚠️ **禁区层**的类别（2026-09-28 用户要求：「涉政和赌毒暴恐之类的…这五项绝对不能碰」）。
 *
 * ## 为什么只认这四个，而不是按档数分类
 *
 * 数据层是**细分**的（撒娇/调戏/色情/涉政/赌博/毒品/暴恐，各自在文件里独立成节，
 * 方便以后单独加词条、单独微调）；但**处置只有两种**：
 *   · 亲密言语（撒娇/调戏/色情）→ 冷淡 / 装傻 / 岔开
 *   · 禁区（下面这四个）→ **一个字都不要评论**，比前者硬得多
 * 拆成七个分支只会让每加一档就多一处要改的地方，所以**代码只认"是不是禁区"**
 * 这个二分。将来你决定把"血腥"也升成禁区，往这个数组里加一项就行。
 *
 * ⚠️ 亲密言语那三档之间的差别**不写死在代码里** —— 每一档的处置由文件里
 * 词条自己的「怎么处理」那行决定（那是人话，改数据即生效，代码不介入）。
 */
const REDLINE = ['涉政', '赌博', '毒品', '暴恐'];

/** 这一条属不属于禁区 */
export function isRedline(category) {
  return REDLINE.includes(String(category ?? '').trim());
}

/**
 * 亲密言语三档的**顺序**（由轻到重）。索引越大 = 越露骨。
 *
 * ⚠️ 数据里的类别名必须跟这里**一字不差**对得上，否则那档永远落在
 *    "未授权"（`tierAllowed` 返回 false）—— 表现为"白名单加了也没用"，
 *    而且不报错，最难查。所以改类别名时**记得回来改这里**。
 */
const TIERS = ['撒娇', '调戏', '擦边'];

/**
 * 「这一档在当前场景能不能接」的天花板。
 *
 * ⚠️⚠️ 2026-09-28 用户定的授权模型 —— **每个场景一个天花板，进白名单就解锁到天花板**：
 *
 *   | 场景            | 撒娇 | 调戏 | 擦边 |
 *   |-----------------|------|------|------|
 *   | 群聊·白名单内   |  ✅  |  ❌  |  ❌  |
 *   | 群聊·白名单外   |  ❌  |  ❌  |  ❌  |
 *   | 私聊·白名单内   |  ✅  |  ✅  |  ❌  |
 *   | 私聊·主人      |  ✅  |  ✅  |  ✅  |
 *
 *   · 群聊**各给各的**（`groupParams.<群号>.sensitive.allowUsers`），**只到撒娇**
 *   · 私聊（`sensitive.allowUsers`）**到调戏**（给主人以外的人）
 *   · 擦边**只给主人**，而且**只在私聊** —— 群里是公开场合，擦边 = 封号风险
 *   · 两个名单**默认都是空的** ⇒ 现阶段**谁都拿不到**，符合"还没想好"
 *
 * ⚠️ 2026-09-29：**公开版另有收紧**（`PUBLIC_POLICY`，见那个常量的注释）：
 *    公开构建里 `ownerOnly === true` ⇒ 白名单那格**整个关掉**，
 *    且天花板被 `clampCeiling` 钳到**撒娇** ⇒ 表里只剩「群聊·主人 → 撒娇」和
 *    「私聊·主人 → 撒娇」两格活着。开发仓库 `PUBLIC_POLICY === null` ⇒ 上表照旧。
 *
 * @param {string} category 词条的「类别」
 * @param {string} ceiling   'none' | '撒娇' | '调戏' | '擦边'
 * @returns {boolean}
 */
export function tierAllowed(category, ceiling) {
  const c = String(category ?? '').trim();
  const idx = TIERS.indexOf(c);
  // ⚠️ 不在 TIERS 里的（历史遗留的旧类别名等）→ 一律**不放开**。
  //    宁可收紧：认不出来的类别直接给"不接"，别赌它属于哪一档。
  if (idx < 0) return false;
  const top = TIERS.indexOf(String(ceiling ?? '').trim());
  if (top < 0) return false; // ceiling = 'none' 或没给
  return idx <= top;
}

/**
 * ⚠️⚠️ **公开版的收紧策略**（2026-09-29 用户要求：「公开出去的版本只有主人 + 只到撒娇」）。
 *
 * ## 这个常量在本仓库**故意是 `null`**
 *
 * `null` = **不收紧**。开发仓库（也就是主人这台机器）要的正是这个：
 * 主人的私聊本来就该到擦边，别因为"以后要发公开版"就把自己静默降级
 * ⇒ `test/sensitive-hit.js` 有一条断言专门钉住「开发仓库必须还是 null」。
 *
 * ## 公开副本怎么收紧
 *
 * `SakiBot_Public/update-public.mjs` 在同步快照时，把那**一整行**替换成
 *   `PUBLIC_POLICY = { ceiling: '撒娇', ownerOnly: true }`（前面照样有 `export const `）。
 * （门禁④ 会验：公开副本里收紧那行**恰好一次**、且 `PUBLIC_POLICY = null` 那行**归零**。）
 * ⚠️ 那两处计数用的是**行首锚定**的正则，不是 `includes` —— 因为**这份注释里**
 *    也会提到这两个常量，裸子串匹配会把注释也算一次（实测踩到过）。
 *
 * ⚠️ 为什么做成"同步时改写"而不是"公开版跑另一套分支"：
 *    那样公开版就成了一份**没人跑过**的代码。现在 `clampCeiling` 和 `ownerOnly`
 *    都是**吃参数**的纯函数，本仓库的套件把公开策略**喂进来**验一遍
 *    ⇒ 公开版的规则在**这个仓库就有真覆盖**。
 *
 * ⚠️ 为什么不用环境变量（`QQBOT_PUBLIC=1`）：公开版是**发出去的源码**，
 *    策略必须是**代码里的常量**才防得住"忘了设环境变量"。
 */
export const PUBLIC_POLICY = { ceiling: '撒娇', ownerOnly: true };
/**
 * 把天花板**钳到策略允许的最高档**。
 *
 * @param {string} ceiling 算出来的天花板（'none' | '撒娇' | '调戏' | '擦边'）
 * @param {{ceiling?:string, ownerOnly?:boolean}|null} [policy] 省略 = 用 `PUBLIC_POLICY`
 * @returns {string} 收紧后的天花板（`policy` 为 null 时**原样返回**）
 *
 * ⚠️ 两个方向的"认不出"都**收到最严**（`'none'`），不赌：
 *    · `ceiling` 是空/没给/不在 `TIERS` 里 ⇒ 按最严处理（本来就该没人能接）
 *    · `policy.ceiling` 写坏了 ⇒ 也按最严（宁可紧，别漏）
 */
export function clampCeiling(ceiling, policy = PUBLIC_POLICY) {
  if (!policy) return ceiling; // 开发仓库：一字不改
  const cur = TIERS.indexOf(String(ceiling ?? '').trim());
  if (cur < 0) return 'none';
  const cap = TIERS.indexOf(String(policy.ceiling ?? '').trim());
  if (cap < 0) return 'none';
  return cur > cap ? TIERS[cap] : ceiling;
}

/**
 * 公开版是不是**只给主人**（白名单在这种构建下不生效）。
 *
 * ⚠️ 默认参数也是 `PUBLIC_POLICY` —— 开发仓库恒为 `false`，一行判断都不会走到。
 */
export function ownerOnly(policy = PUBLIC_POLICY) {
  return !!policy?.ownerOnly;
}

/**
 * 白名单内的人**在群里能松到什么程度**的旋钮（2026-09-28）。
 *
 * 用户原话：「这个可以适当放松一点点，**不过我还没想好度**」
 * ⇒ 先按 `conservative` 上线，**不猜那个度**。
 *
 * ⚠️⚠️ 2026-09-28 **语义变了**：以前这个旋钮管的是"**所有人**的亲密言语松紧"，
 *    现在**只管白名单内的人在群里的松紧**（天花板本身由 `tierAllowed` 决定，
 *    跟这个常量无关）：
 *      · 'conservative' —— 白名单内群友：撒娇**轻轻回一句**即可
 *      · 'loose'        —— 白名单内群友：撒娇**可以更自然地接**
 *    想更松就改这一行，**不碰逻辑、不碰禁区层、不碰主人的私聊尺度**。
 */
const INTIMACY_TONE = 'conservative';


/**
 * 把这句话命中的敏感词条拼成提示词块（**没命中就返回空串** —— 第一道闸）。
 *
 * ⚠️ 刻意**不像梗库那样再加一层"玩梗信号"判断**（`memes.js` 的 `hasSignal()`）：
 *    那层是为"别把『这是经典案例』当梗"设计的。敏感词不一样 ——
 *    「今天被老婆骂了」是**真**敏感，加旁证判断反而会漏判。出现就是敏感。
 *
 * @param {string} text 对方说的话
 * @param {{max?:number}} [opts]
 * @returns {string}
 */
export function sensitiveFor(text, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  const hits = hitsFor(t);
  if (!hits.length) return '';
  // ⚠️⚠️ 2026-09-28：**禁区层优先，而且永远不参与 max 截断**。
  //    原来 `hits.slice(0, max)` 是按命中顺序切的 —— 一句话里同时出现
  //    「社保」和「天安门」时，前 4 条里可能没有禁区那条，
  //    于是"绝对不能碰"的规则**被一条调戏挤掉了**。这比误中严重得多。
  const redline = hits.filter((h) => isRedline(h.category));
  const intimacy = hits.filter((h) => !isRedline(h.category));
  const max = Number.isFinite(opts.max) ? opts.max : 4;
  const shown = intimacy.slice(0, max);
  const hidden = intimacy.length - shown.length;

  // ⚠️⚠️ 2026-09-28：`ceiling` = **这一档最高能松到哪儿**（`tierAllowed` 认它）。
  //    由 `bot.js` 按场景算好传进来：群聊白名单→'撒娇'、私聊白名单→'调戏'、
  //    主人私聊→'擦边'，其余→'none'。
  //    ⚠️ 默认 'none'：**没传就等于全不放**。宁可保守，也别让某个新调用点
  //    因为忘传参数而意外拿到主人的私聊尺度。
  const ceiling = String(opts.ceiling ?? 'none').trim();
  // ⚠️ 2026-09-28：标题跟着 `ceiling` 变。原来写死"只认不接"，可是主人私聊
  //    是放开的 —— 标题和下面逐档的话**对不上**，等于自己给自己下矛盾。
  const relaxed = TIERS.indexOf(ceiling) >= 0;
  const lines = [
    relaxed
      ? '## ⚠️ 他这句话里有敏感词 —— **按下面的分档处置**'
      : '## ⚠️ 他这句话里有敏感词 —— **只认不接**',
    '',
  ];

  // ── 禁区层 ──────────────────────────────────────────────
  if (redline.length) {
    lines.push(
      '### 🚫 禁区 · **一个字都不要碰**',
      '',
      '这一组是**绝对红线**（用户明确要求「绝对不能碰」），比下面那组硬得多：',
      '- **不评论、不接、不复述那个词、不解释它是什么、不评价任何人任何事。**',
      '- **一笔带过**（"这个我不聊"）或**直接换话题**，就这样。',
      '- **没有例外** —— 就算对方在讲正经事、问你看法、或者自己表明立场也一样。',
      '- ❌ 别假装不懂、别纠正对方、别顺着往下问。',
      '',
    );
    for (const it of redline) lines.push(...renderItem(it));
  }

  // ── 亲密言语层 ──────────────────────────────────────────
  if (shown.length) {
      // ⚠️⚠️ 2026-09-28：**按 `ceiling` 渲染，且每个场景只渲染一套话。**
    //
    //    原来的做法是"常驻写死保守版 + 主人在别处补一段『这里放开』"。
    //    那是**两套相反的话并存** ⇒ 模型只能二选一，而它通常挑措辞更硬的
    //    （保守版在开头还带 ⚠️）⇒ 主人的私聊尺度实际上**从来没生效过**。
    //
    //    ⇒ 现在：**谁在说话、什么场景、能松到哪一档，由 `ceiling` 决定，
    //    这里只渲染对应的那一套**。提示词里永远不会自相矛盾。
    const openTiers = TIERS.filter((t) => tierAllowed(t, ceiling));
    if (openTiers.length) {
      lines.push(`### 亲密言语 · 分档处置（当前**开到「${ceiling}」**）`, '');
      if (ceiling === '撒娇' && INTIMACY_TONE === 'conservative') {
        lines.push(
          '- **撒娇**：可以**轻轻回一句**（软一点、接一下就行），但**别顺势升级**。',
        );
      } else {
        lines.push(`- **${openTiers.join(' / ')}**：可以自然地接，**保持你平时的语气**。`);
      }
      const closedTiers = TIERS.filter((t) => !tierAllowed(t, ceiling));
      if (closedTiers.length) {
        lines.push(
          `- **${closedTiers.join(' / ')}**：这一档**当前不放开** —— ` +
            '不接、不解释、不调侃，直接带过。',
        );
      }
      lines.push(
        '- **排除词那条例外照旧**：列出来的那几个（社保卡之类）**按普通词正常答**。',
      );
    } else {
      lines.push('### 亲密言语 · 认出来，但**不接**', '');
      lines.push(
        // ⚠️⚠️ 「宁可误中不回也不能放」：方向是**先拦下来再说**。
        //    原来写的是"拿不准就按字面正常答 —— 宁可漏判"，
        //    那是**防误伤**的说法，跟用户要求**完全相反**，模型会照着它放行。
        '- **先按雷处理**：哪怕看着像在说正经事，也**不接、不解释、不调侃**。',
        '- **只有下面那条明确列出的「例外」**才按字面正常答，',
        '  而且要**正常、干脆地答**，别解释"我以为你在开车"、别露出警觉的样子。',
        '- 宁可答得生硬一点，也**不要漏掉**。',
      );
    }
    lines.push('');
    // ⚠️ 每条按**自己那一档**能不能接分别渲染 —— 主人私聊时撒娇开、擦边也开，
    //    白名单群友时撒娇开、调戏擦边关，不能一刀切。
    for (const it of shown) lines.push(...renderItem(it, tierAllowed(it.category, ceiling)));
    if (hidden > 0) {
      lines.push(`（另有 ${hidden} 条亲密言语也命中了，一并按上面这个原则处理。）`, '');
    }
  }
  return lines.join('\n').trim();
}

/**
 * 渲染一条词条（标题 + 原文 + 怎么处置 + 例外提示）。
 *
 * ⚠️⚠️ 2026-09-28 新增 `allowed`（这一档在**当前场景**能不能接）。
 *
 *    这是整个"分档授权"的关键：`怎么处理` 字段里的话**是按"允许接"写的**
 *    （撒娇那条：「在安全范围内**可以接一下**」）。如果**无条件**渲染它，
 *    那么在**没进白名单**的群里，提示词里会同时出现
 *    「亲密言语一律不接」和「撒娇：可以接一下」—— 两套相反的话。
 *    模型只能二选一，而它通常挑措辞更硬的那条 ⇒ 白名单机制形同虚设。
 *
 *    ⇒ 这里**只渲染一套**：`allowed` 为真才给数据里那句，否则给通用那句。
 *    提示词里因此**永远不会出现自相矛盾的两条**。
 *
 * @param {{name:string,category:string,body:string[],how:string[],ex:string[]}} it
 * @param {boolean} allowed
 */
function renderItem(it, allowed = false) {
  const out = [`#### 「${it.name}」命中（类别 ${it.category}）`];
  // ⚠️⚠️ `it.body` 里的行**本来就带着 `- `**（解析时整行原样收的，
  //    只把"触发词/类别/排除词"那几行摘走当字段用）。
  //    我第一版又 map(b => `- ${b}`) 加了一层 —— 渲染出来是 `- - 什么意思：…`，
  //    提示词里多一个横线，模型看着像格式错乱。
  //    ⇒ 直接 push，不加前缀。
  if (it.body.length) out.push(...it.body);
  // 「怎么处理」—— 只在**这一档允许接**时才给
  if (!isRedline(it.category)) {
    if (allowed && it.how?.length) {
      out.push('- 怎么处理：', ...it.how.map((l) => `  ${l}`));
    } else {
      out.push('- 怎么处理：**这一档在当前场景不放开** —— 不接、不解释、不调侃，直接带过。');
    }
  }
  // ⚠️ 措辞跟着"宁可误中"改：原来写"不算 → 按普通词答"是**指令**（直接放行），
  //    现在改成"**例外**" —— 默认是雷，例外是**有限列举**。
  //    ⚠️ 禁区层**不给例外**：那边连"例外"两个字都不该出现 ——
  //    否则文件里万一漏写了排除词，模型会以为"没列出来就算没例外但可以通融"。
  if (isRedline(it.category)) {
    out.push('- （本条**无例外**：不评论、不接、不复述。）');
  } else if (it.ex.length) {
    out.push(`- ⚠️ **例外**（只有这几种按普通词答）：${it.ex.join('、')}`);
  } else {
    out.push('- （本条没有例外。）');
  }
  out.push('');
  return out;
}


