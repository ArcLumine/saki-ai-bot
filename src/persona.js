/**
 * 人设身份：把「她是谁」从代码里抽出来的**唯一出口**（2026-09-21 加）。
 *
 * 数据来自 `personas/<id>/identity.json`，结构见 `personas/README.md`。
 *
 * ## 两类字段，用途完全不同 —— 别混
 *
 *   · **结构化字段**（`selfName` / `callNames` / `nicknames` / `ambiguity` …）
 *     → 给**逻辑**用：判断"这句话是在叫她吗"、"是不是中文歧义"。
 *       换人设时这些跟着换，代码一个字都不用动。
 *
 *   · **整句文案**（`prompt.*`）
 *     → 给**提示词**用，**整句替换**。
 *       ⚠️⚠️ **不要在代码里拼字段** —— 不同角色的自我介绍**结构本来就不一样**
 *       （有人有"外号都照应"这条规矩，有人没有），拼出来只会是个谁也不像的
 *       平均角色，那正是"掉人味"的典型死法。
 *
 * ## 两条硬约束
 *
 *   · **不缓存成死值**：`persona.id` 能在界面上热切换、`identity.json` 也能手改，
 *     所以靠 **mtime + 大小**判断要不要重读（界面保存后会走 `reload()`）。
 *   · **缺 `identity.json` 不崩**：那种情况下她只是"没有名字"，
 *     不该整个机器人起不来。但要**警告** —— 不然会变成"换了人设没反应"
 *     那种最难查的静默失败。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config, personaDir, personaId } from './config.js';
import { log } from './log.js';

let cache = null;
let cacheKey = '';
let warned = false;

function load() {
  const dir = personaDir();
  const file = join(dir, 'identity.json');
  let key = `${dir}|missing`;
  try {
    if (existsSync(file)) {
      const st = statSync(file);
      key = `${dir}|${st.mtimeMs}|${st.size}`;
    }
  } catch {
    /* stat 失败就按"文件没有"处理，下面会走兜底 */
  }
  if (cache && cacheKey === key) return cache;
  cacheKey = key;

  if (key.endsWith('|missing')) {
    if (!warned) {
      warned = true;
      log.warn(
        `人设包「${personaId()}」里没有 identity.json —— 名字/外号/称呼会用空值，` +
          `她会"没有名字"。照 personas/_template/identity.json 建一个：${file}`,
      );
    }
    cache = {};
    return cache;
  }
  try {
    // ⚠️ 剥 BOM：记事本/PowerShell 写出来的 JSON 常带 BOM，JSON.parse 会直接报错
    cache = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    warned = false;
  } catch (e) {
    log.error(`identity.json 读不了（${e.message}）—— 当作空，检查 JSON 格式：${file}`);
    cache = {};
  }
  return cache;
}

/** 人设包换了 / 文件被改了之后调它（界面保存后走这条） */
export function reload() {
  cache = null;
  cacheKey = '';
  warned = false;
  load();
  return status();
}

const str = (v, fb = '') => (typeof v === 'string' && v.trim() ? v.trim() : fb);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

/** 整个对象（一般不用它，用下面那些访问器） */
export const identity = () => load();

export const selfName = () => str(load().selfName);
export const charName = () => str(load().name);
export const displayName = () => str(load().displayName);
/**
 * **昵称形式**的名字（2026-09-21 加）。
 *
 * 用途：状态标题那种"捧场**小祥**""客服**小祥**" —— 那里用的**不是**自称（`Saki`）、
 * 也不是全名，而是群里最常叫的那个短名字。用 `selfName()` 去填会变成"捧场 Saki"，改味。
 *
 * ⚠️ 三级回落：`shortName` → `selfName` → `name`。留空也不会让标题缺字。
 */
export const shortName = () => str(load().shortName) || str(load().selfName) || str(load().name);

/**
 * **剧情 / 叙述里用的名字**（2026-09-21 加）。
 *
 * 用途：剧情提示词里那种「视角是**祥子**」「**祥子**在群里说的第一句」——
 * 那里用的是**第三人称叙述名**，既不是自称（`Saki`）也不是群里的昵称（`小祥`）。
 *
 * ⚠️ 用 `shortName()` 去填会变成「视角是**小祥**」——**文案就改了**。
 *    （2026-09-21 核对 git diff 时当场发现的：逐字核对这一步是有用的。）
 * ⚠️ 两级回落：`narrativeName` → `shortName`（没配就用昵称，至少不会缺字）。
 */
export const narrativeName = () => str(load().narrativeName) || shortName();
export const selfNames = () => arr(load().selfNames);
export const callNames = () => arr(load().callNames);
export const nicknames = () => arr(load().nicknames);

/**
 * 正则转义 —— 名字是**数据**，里面可能有括号、空格、点，
 * 直接拼进 `new RegExp()` 会拼出一个坏正则（甚至语法错误）。
 * 凡是用 persona 字段拼正则的地方，都必须先过它。
 */
export const escapeRe = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * **做判据用的名字原子**（`identity.matchNames`，2026-09-21 加）。
 *
 * 和上面那几个的区别：上面是"**她叫什么**"（给人看的、进提示词的），
 * 这里是"**代码要在句子认出她来**"要匹配的碎片 —— 所以**允许单字和变体**：
 * 例「祥」既能匹配「小祥」也能匹配「祥子」，而 `nicknames` 里不会列一个单字。
 *
 * 谁在用：`mama.js`（「祥妈」「小祥妈妈」算不算在叫她）、
 * `search.js`（搜之前把呼语「小祥，…」剥掉）。
 *
 * ⚠️ 不填就从 `shortName / narrativeName / selfName / name / selfNames` 凑 ——
 *    凑出来的**不含单字**，判据会略严（宁可漏判，不要误判）。
 */
export function matchNames() {
  const it = load();
  const list = arr(it.matchNames);
  if (list.length) return list;
  return [
    ...new Set(
      [str(it.shortName), str(it.narrativeName), str(it.selfName), str(it.name), ...arr(it.selfNames)].filter(Boolean),
    ),
  ];
}

/**
 * 把 `matchNames()` 拼成正则用的分支串（**已转义、长的在前**）。
 *
 * ⚠️ 长的排前面是有意的：`客服小祥` 要排在 `小祥` 前面，
 *    否则 `^(?:小祥|客服小祥)` 在 "客服小祥…" 上会先试短的那个。
 *    （其实是"先试后回溯"，结果一样，但排好序省事也更好读。）
 * ⚠️ 一个名字都没有时返回 `(?!)`（**永不匹配**）——
 *    绝不能返回空串，那会拼出 `(?:)` 这种"匹配空"的写法，
 *    于是任何句子都会被判成"在叫她"。
 */
export function matchNamesAlt() {
  const alt = [...new Set(matchNames())]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
  return alt || '(?!)';
}

/**
 * **她不喜欢被叫的称呼 + 希望大家叫她什么**（`identity.renameObjection`）。
 *
 * ⚠️ 用途很窄，别当成"称呼白名单"：只给 `llm.js` 里那条**拦自我纠正**的判据用 ——
 *    她**不该去管别人怎么叫她**（用户 2026-09-13：「别人叫她所有外号都应该没关系」），
 *    只有「我不叫祥子」「别叫我祥子」「叫我 Saki 就行」这种**答非所问的纠正**要拦掉。
 */
export function renameObjection() {
  const r = load().renameObjection;
  const o = r && typeof r === 'object' ? r : {};
  return { dislike: arr(o.dislike), prefer: str(o.prefer) };
}
export const ambiguity = () => (Array.isArray(load().ambiguity) ? load().ambiguity : []);
export const style = () => {
  const s = load().style;
  return s && typeof s === 'object' ? s : {};
};

/**
 * 这个角色的两类口癖：句首与句末。
 *
 * 兼容旧格式：`style.verbalTics: ["xxx"]` 会被视为句首口癖；
 * 新格式是 `{ sentenceStart: [], sentenceEnd: [] }`。
 * 这里返回规范化后的结构，调用方不必重复处理旧数据。
 */
export function verbalTics() {
  const raw = style().verbalTics;
  if (Array.isArray(raw)) return { sentenceStart: arr(raw), sentenceEnd: [] };
  return {
    sentenceStart: arr(raw?.sentenceStart),
    sentenceEnd: arr(raw?.sentenceEnd),
  };
}

/**
 * **她引用哪些动画库**（`identity.anime.works`）。
 *
 * 每个名字对应一个文件：`knowledge/anime/<名字>.md`。
 * 这是"换角色不会串味"的关键 —— **没声明的库，她根本读不到**：
 *   · Saki 声明 `bangdream`，所以她看得见邦邦的事；
 *   · 换成别的角色、声明里没有 `bangdream`，那份库里写的东西就**不进她的提示词**。
 *
 * ⚠️ 返回**空数组** = 一个动画库都不读（**不是**"读全部"）——
 *    新人设包没填这个字段时，宁可让她不懂二次元，也别把别人的世界观塞给她。
 * ⚠️ 名字做**文件名白名单**校验（只留字母数字点横线），挡 `../` 那种。
 */
export function animeWorks() {
  const a = load().anime;
  const list = a && typeof a === 'object' ? arr(a.works) : [];
  return list.map((x) => String(x).trim()).filter((x) => /^[\w.-]+$/.test(x));
}

/**
 * **问到这些词就该联网搜**（`identity.anime.keywords`）。
 *
 * 作品名、同作品的角色名都写这里 —— 它有两个用处：
 *   ① `search-presearch.js` 判断"这是不是关于她自己企划的问题"（该搜还是该直接答）；
 *   ② 命中就说明该去查最新动态。
 * ⚠️ 跟 `animeWorks()` 是两件事：**那个决定读哪份库，这个决定什么时候去搜。**
 */
export function animeKeywords() {
  const a = load().anime;
  return a && typeof a === 'object' ? arr(a.keywords) : [];
}

/**
 * **这个角色的 QQ 昵称 / 头像**（`identity.qq`，2026-09-21 加）。
 *
 * ⚠️ 用途：**切换人设时自动把真号上的昵称和头像换成这里的值**
 *    （用户原话：「昵称和头像应该就是自动改的，要不然就没意义了」）。
 * ⚠️ `avatar` 是**人设包里的文件名**（相对包根，例 `avatar.png`），
 *    不是 URL —— 头像图片跟着人设包走，换角色就是换文件。
 * ⚠️ 两个都可以留空：留空 = 那一项**不动**（不是清空）。
 */
export function qq() {
  const q = load().qq;
  const o = q && typeof q === 'object' ? q : {};
  return { nickname: str(o.nickname), avatar: str(o.avatar) };
}

/**
 * **生图用的参考图**（`identity.image.refs`，2026-09-22 加）。
 *
 * 返回**人设包内**的绝对路径数组 —— 顺序有意义，第一张一般是正脸立绘。
 * `src/imagegen.js` 会把它们编码成 base64 一起发过去（`image` 字段）。
 *
 * ⚠️ 为什么放人设包、不写死在代码里：参考图 = 「这个角色长什么样」，
 *    该跟着角色走。**换人设 = 自动换脸，代码一个字不动**。
 * ⚠️ 没配 `image.refs` 时**退回 `qq.avatar`** —— 头像是现成的，
 *    这样"刚配好生图就能用"，不用用户先去想该传哪张。
 *    （但头像往往太小，生成的脸会飘；界面上会提示补一张立绘。）
 * ⚠️ 文件名走**白名单**（和 `persona-admin.avatarFile()` 同一套规矩）：
 *    这是要读进内存、发到外部 API 的路径，不能让 `../` 有半点机会。
 */
export function refImages() {
  const dir = personaDir();
  const pick = (rel) => {
    const safe = String(rel ?? '').replace(/[^\w.-]/g, '');
    if (!safe || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(safe)) return '';
    const f = join(dir, safe);
    return existsSync(f) ? f : '';
  };
  const img = load().image;
  const refs = arr(img && typeof img === 'object' ? img.refs : [])
    .map(pick)
    .filter(Boolean);
  if (refs.length) return refs;
  const avatar = pick(qq().avatar);
  return avatar ? [avatar] : [];
}

/**
 * **她怎么称呼别人**（`identity.address.*`）。
 *
 * ⚠️ 和「别人怎么称呼她」是两回事，后者是顶层那些字段（`selfName` / `nicknames`…）。
 * ⚠️⚠️ 这里只管**叫法**。**"主人是谁"是共用事实**（`config.ownerQQ` + `knowledge/owner.md`），
 *    换人设**不该**动它 —— 换个角色该改的是"你叫他什么"，不是"你主人变成了别人"。
 * ⚠️ `admin` / `member` 留空 = 用群名片（`names.js` 那条路），大多数角色都该是空的。
 */
export const address = () => {
  const a = load().address;
  return a && typeof a === 'object' ? a : {};
};
export const callOwner = () => str(address().owner);
export const callOwnerFormal = () => str(address().ownerFormal);

/** 叫他什么（正式场合用；没配就跟平时一样）。** 空 → 退回平时叫法 */
export const callOwnerAny = () => callOwnerFormal() || callOwner() || '主人';

/**
 * 别人会怎么叫他（**识别用**，不是输出称呼）。
 *
 * ⚠️ 2026-09-28：**从 `config.ownerAliases` 读，不再是人设包**。
 *    「别人怎么叫他」是**共用事实**（跟 `config.ownerQQ` 一样，换人设不该动）；
 *    人设包的 `address.*` 只管"**她**怎么称呼别人"。见 `address()` 上面的注释。
 *    界面上在「模型（主人 / 机器人）」页那张「身份」卡里填，和 `ownerQQ` 挨着。
 *
 * ⚠️ 兼容两种写法：数组，或用 `、` 分隔的字符串（手改 config.yml 时容易写成后者）。
 */
export function ownerAliases() {
  const raw = config.ownerAliases;
  const list = Array.isArray(raw)
    ? raw
    : String(raw ?? '').split(/[、,，\n]/);
  return list.map(str).map((s) => s.trim()).filter(Boolean);
}

/**
 * 一条别名怎么才算"命中"（2026-09-28 用户要求：别人喊他时用来判断"这话跟主人有关"）。
 *
 * ⚠️⚠️ **纯 ASCII 的别名必须走词边界**，不能用 `includes`（真实踩过）：
 *    名单里有个 `ark`，用 `includes` 的话 ——
 *      'shark' / 'market' / 'darkroom' 全都"命中"（在讨论鲨鱼、市场、Darkroom 房间），
 *      而真的喊他 'ARK' 反而**不**命中（大小写不同）。
 *    ⇒ 英文别名一律用 `\b...\b` + `i` 标志。含中文的别名没有这个问题，`includes` 就够
 *      （中文没有词边界这个概念，「粥粥」两个字挨着出现就是喊他）。
 *
 * ⚠️ 别名一个都不能写死在代码里 —— 全部来自 `config.ownerAliases`（界面上也能填），
 *    改名单 = 改配置，代码零改动。
 *
 * @param {string} text
 * @returns {boolean} 消息里是否提到了主人的某个别称
 */
export function ownerMentionHit(text) {
  const s = String(text ?? '');
  if (!s) return false;
  for (const a of ownerAliases()) {
    // ⚠️ 名字里带正则元字符时必须转义，否则用户填一个 `a+b` 就能让整段提示词崩掉
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (/^[\x20-\x7e]+$/.test(a)) {
      if (new RegExp(`(?:^|[^a-z0-9_])${esc}(?![a-z0-9_])`, 'i').test(s)) return true;
    } else if (s.includes(a)) {
      return true;
    }
  }
  return false;
}

/**
 * 「有人在用主人的别称提到他」—— 给提示词按需拼的一小段（2026-09-28）。
 *
 * ## 这段是干什么的
 *
 * `speakerRole()` **只按 `user_id` 判身份**（那是唯一可靠的依据，不该动）。
 * 所以别人在群里说「粥粥上次说的那个…」时，代码层面她就是 `member`。
 * 但那句话**确实是在说主人** —— 没有这段提示词，模型只能靠自己的推测，
 * 而"提到主人"和"主人本人在说话"对回答方式的要求完全不同。
 *
 * ## 只加这一小段，**故意不加**的两样东西
 *
 *   · `owner.md` —— 主人的私人资料，现在只在 `role === 'owner'` 时读
 *     （`knowledge.js` 里那道闸是用户自己定的："给群友看很怪"）。不加。
 *   · `relationship.md` —— ⚠️ 那份文件**一条事实都没有，全是"她该怎么跟他说话"**
 *     （「可以撒娇式地嫌弃」「被他夸了要让他听出来你高兴」…）。
 *     别人只是提了一句就把它拉进来，等于把「对他可以更软」这个语气指示
 *     泄给不相干的人，她会顺着那个软语气对路人说话。**坚决不加。**
 *
 * ## 名单为空就整段不生成
 *
 * `config.ownerAliases: []` → 这里返回空串、`ownerMentionHit()` 恒 false，
 * 等于这条路径不存在，不留空壳。
 *
 * @returns {string} 提示词片段；没命中/没配别名时返回 ''
 */
export function ownerMentionHint() {
  const alias = ownerAliases();
  if (!alias.length) return '';
  const o = callOwner() || '主人';
  return [
    `## ⚠️ 有人用${o}的别的叫法提到他`,
    '',
    `「${alias.join('、')}」这些称呼指的是**${o}本人**（这台机器人的主人）。`,
    `⚠️ 但**现在跟你说话的人不是他**（他不在场），所以：`,
    '  · 仍按**对群友**的口吻回答 —— 别用平级口气、别撒娇、别刻意讨好。',
    '  · **别替他说**「他同意」「他说可以」「他让你这么做的」。',
    `  · 他没说过的事，**不要写成他的意思**；不知道就说不知道。`,
    `  · 提到他 ≠ 可以提他的私事。只回答**对方问的那件事**本身。`,
  ].join('\n');
}

/**
 * 占位符 → 真称呼。
 *
 * ⚠️ 为什么要有这一层：以前提示词里写的是**字面量**「叫他「<主人>」」——
 *    尖括号对模型来说就是"占位符"的信号，**它真的会照着吐出来**（实测风险）。
 *    而且尖括号那串东西也不会被任何人替换，纯粹是"看起来像配置、其实是字面量"。
 *
 * 支持三种写法，随谁方便用谁：`<主人>` / `{{owner}}` / `【主人】`。
 * ⚠️ 兜底是「主人」这个词本身 —— identity 没配称呼时也不至于把占位符漏给模型。
 *
 * @param {string} text
 * @returns {string} 填好的文本（不是 string 时原样返回）
 */
export function fillOwnerTerms(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!/<主人>|\{\{\s*owner\s*\}\}|【主人】/.test(text)) return text;
  // ⚠️⚠️ 自引用防护（真实踩过）：`personas/amiya/identity.json` 里曾经把
  //    `address.owner` 本身写成 `"<主人>"` —— 那样填完还是「<主人>」，
  //    **等于什么都没填**，而且排查起来极难看出来（它长得就像填好了）。
  //    称呼里带着占位符 → 判定为没配，退回「主人」这个词本身。
  const raw = callOwner() || '';
  const name = /<主人>|\{\{\s*owner\s*\}\}|【主人】/.test(raw) ? '主人' : raw || '主人';
  const formalRaw = callOwnerFormal() || '';
  const formal = /<主人>|\{\{\s*owner\s*\}\}|【主人】/.test(formalRaw) ? '' : formalRaw;
  return text
    .replace(/<主人>|\{\{\s*owner\s*\}\}|【主人】/g, name)
    .split('<正式主人>')
    .join(formal || name);
}

/**
 * 「他是谁 + 该怎么叫他」—— 给提示词按需拼的一段。
 *
 * ⚠️ 别在代码里拼字段（persona.js 头部那条规矩）：整句优先取 `address.ownerRule`，
 *    那是人设作者自己写的句子；取不到才退到下面这个最朴素的拼法。
 */
export function ownerIdentityText() {
  const o = callOwner() || '主人';
  const rule = str(address().ownerRule);
  const alias = ownerAliases();
  const lines = [`**他**：这台机器人的主人（QQ \`${config.ownerQQ ?? ''}\`）。`, '', `**称呼**：一律叫「${o}」。`];
  if (rule) lines.push(rule);
  if (alias.length) lines.push('', `别人也可能这么叫他（**只是识别对象，不代表你也这么叫**）：${alias.join('、')}。`);
  return lines.join('\n');
}

/**
 * 提示词里的**整句**（`identity.prompt.<key>`）。
 *
 * ⚠️ 取不到时返回**空字符串**，**绝不兜底编一句** —— 编出来的那句不是这个人设说的话。
 *    调用方自己决定没有它怎么办（一般是跳过那一段）。
 */
export function promptText(key) {
  const p = load().prompt;
  return p && typeof p === 'object' ? str(p[key]) : '';
}

/**
 * 读人设包里的**长段提示词**（`personas/<id>/prompt/<name>.md`）。
 *
 * ⚠️ 为什么长段不放 `identity.json`：131 行中文塞进 JSON 要写成 `\n` 转义，
 *    既没法读也没法改，界面上更没法编辑。**短句走 `promptText()`，长段走这里。**
 * ⚠️ 取不到时返回**空字符串**，不兜底编 —— 和 `promptText()` 一个道理：
 *    编出来的那段不是这个人设说的话。
 * ⚠️ 文件名做白名单（只留字母数字点横线），别让它拼出 `../` 去读别处。
 * ⚠️ 不缓存（每次读盘）：换人设、或者用户在界面上改了这个 md，都要立刻生效。
 */
export function promptFile(name) {
  const safe = String(name ?? '').replace(/[^\w.-]/g, '');
  if (!safe) return '';
  const file = join(personaDir(), 'prompt', `${safe}.md`);
  try {
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8');
  } catch (e) {
    log.warn(`读人设长段提示词失败（${safe}）：${e.message}`);
    return '';
  }
}

export function status() {
  const it = load();
  return {
    id: personaId(),
    dir: personaDir(),
    loaded: Object.keys(it).length > 0,
    name: str(it.name),
    selfName: str(it.selfName),
    nicknameCount: arr(it.nicknames).length,
    promptKeys: it.prompt && typeof it.prompt === 'object' ? Object.keys(it.prompt) : [],
  };
}
