/**
 * 群友性格观察 + 群里大事的**自动积累**。
 *
 * 需求（用户原话）：「不能用『你记住』这种模式，只能暗中总结」。
 * 所以这个模块**完全不打扰群聊**：把群消息悄悄攒起来，攒够了在后台跑一次总结，
 * 把观察到的性格和大事写进 knowledge/observe/<群号>.md（2026-09-28 从共享的群资料库里拆出来）。
 *
 * ⚠️ 设计上的两个关键决定（都是为了避免踩坑）：
 *
 * ① **只重写「标记区」，绝不碰手写内容。**
 *    文件里有个自动维护的区块：
 *      <!-- AUTO-OBSERVE:BEGIN -->
 *      ...（机器人生成的）
 *      <!-- AUTO-OBSERVE:END -->
 *    总结时只替换这两行之间的内容。这样你在界面上手写的段落
 *    （关键人物、常说话的群友…）永远不会被冲掉。
 *
 * ② **攒够条数才跑，不在聊天路径上跑。**
 *    聊天要快；总结是慢活（一次模型调用几秒），必须后台异步。
 *    攒够 threshold 条新消息就触发一次，跑完清零。
 *
 * 另外：模型只能**追加/修正**观察，**不许编**，也不许写「我记录了你」这种话。
 *
 * ---
 *
 * ## 2026-09-14 用户要求的三件事（都实现了）
 *
 * 用户原话：
 *   「**提升观察记录群友做了什么事什么性格的频率**，
 *    再加一个**按时间压缩**的功能，**压缩不重要的事情**，
 *    但是**性格要不断细化，不能删除**，**好感度也不能修改**。」
 *
 * | 要求 | 怎么做的 |
 * | --- | --- |
 * | 提高记录频率 | 一次最多写的群友观察 5 → **10**；性格条目**保留上限 20 → 60**；`threshold` 从 200 降到 120（见 config.yml） |
 * | 按时间压缩 | `compress()` —— 定期让模型把自动区重写一遍：**大事按时间压成小结**（不重要的合并/压短），**性格只许细化/合并，一条都不许删** |
 * | 性格不断细化 | 压缩提示词里**硬性要求**；代码再加一道**条数不许减少**的校验（减少了就拒绝写入） |
 * | 好感度不能修改 | 好感度**根本不在这里** —— 它在 `src/affinity.js` + `state/affinity.json`，这个模块**一个字都不碰**（连提示词里都不提它） |
 */
// ⚠️ 2026-10-04：四个都要（本地要 `readdirSync` 列目录，上游要 `rmSync` 删文件；
//    `dirname` 建目录、`basename` 拼日志里的文件名）。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { config, ROOT, KNOWLEDGE_DIR, knowledgePrivateDir, stateDir } from './config.js';
import { log } from './log.js';
import { reloadKnowledge } from './knowledge.js';
import { groupsOf } from './names.js';
import { backupKnowledge } from './backup.js';
import { streamChat } from './llm.js';
// ⚠️ 2026-10-04：「谁说的」统一格式 `昵称(QQ号)`
import { whoTag } from './who.js';

/** 把流式输出收成一段文本 */
async function collect(messages) {
  let out = '';
  for await (const d of streamChat(messages)) out += d;
  return out;
}

/** 观察记忆一律住 `knowledge/observe/`（2026-09-28：从"学到的知识"里拆出来） */
const KDIR = knowledgePrivateDir();
const FILE = join(KDIR, 'observe', '_shared.md');
const BEGIN = '<!-- AUTO-OBSERVE:BEGIN -->';
const END = '<!-- AUTO-OBSERVE:END -->';

/** 待观察的原始消息（只放内存，重启就丢 —— 观察是慢积累，丢一点无所谓） */
let pending = [];
/** 上次总结时的消息计数 */
let seen = 0;
/** 防止并发跑两次 */
let running = false;
/** 统计 */
const stats = { runs: 0, added: 0, lastRunAt: 0, lastError: '', compressRuns: 0, lastCompressAt: 0 };

/**
 * 「上次压缩是什么时候」**必须落盘**（2026-09-14）。
 *
 * ⚠️ 为什么：`minIntervalMs` 是"距上次压缩至少隔 3 天"，
 *    如果这个时间只在内存里，**每次重启就归零** → 一重启就可能立刻压一次。
 *    这个项目里"内存状态被重启清掉"已经踩过两次（见 AGENTS.md 铁律②），
 *    所以一开始就落盘。
 */
const STATE_FILE = process.env.QQBOT_OBSERVE_FILE
  ? join(ROOT, process.env.QQBOT_OBSERVE_FILE)
  : join(stateDir(), 'observe.json');

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    stats.lastCompressAt = Number(j?.lastCompressAt) || 0;
  } catch (e) {
    log.debug(`观察状态读取失败（当作空的）：${e.message}`);
  }
}

function saveState() {
  try {
    mkdirSync(join(stateDir()), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastCompressAt: stats.lastCompressAt }, null, 2), 'utf8');
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.debug(`观察状态写盘失败：${e.message}`);
  }
}

/**
 * 这次观察该归到哪个作用域（2026-09-17 加）。
 *
 *   · 群聊 → 群号
 *   · 私聊 → **他跟机器人共有的那个群**；一个共有群都没有才用 `dm:<QQ号>`
 *
 * ⚠️⚠️ 口径是用户定的（原话）：「我建议**私聊和群用一套**，也就是如果那个人在同一个群时，
 *    现在不会有没有群只加好友的」「**同一套资料库**」。
 *    为什么不能"私聊一律 dm:"：那样同一个人会有**两份记忆** ——
 *    他在私聊里提过的事，到群里聊起来她就"不记得"，反过来也一样。
 *
 * ⚠️ 多个共有群时取第一个（`card` 的顺序 = 首次记录到的顺序，稳定）。
 *    这个选择**只影响归属，不影响正确性** —— 无论归到哪个群，都是他自己的记忆。
 */
export function scopeFor(event) {
  const mt = event?.message_type;
  if (mt !== 'private') return String(event?.group_id ?? '');
  try {
    const gids = groupsOf(event?.user_id);
    if (gids.length) return String(gids[0]);
  } catch (e) {
    log.debug(`查共有群失败（这次观察单独存）：${e.message}`);
  }
  return `dm:${event?.user_id}`;
}

/** 记一条消息（群消息 / 私聊，由 bot 在收到时调用） */
export function note(event, text) {
  if (config.observe?.enable === false) return;
  // ⚠️ 2026-09-17：**私聊也观察**。
  //    用户原话：「机器人和群友的私聊也应该和群里一样，记下性格和事件」——
  //    在这之前这一行是 `if (message_type !== 'group') return;`，
  //    所以私聊里说过的话一个字都不留，她跟人私聊永远是"每次从零开始"。
  const mt = event?.message_type;
  if (mt !== 'group' && mt !== 'private') return;
  if (!text || !text.trim()) return;
  // 机器人自己说的不算「观察对象」
  if (String(event.user_id) === String(event.self_id)) return;

  pending.push({
    name: event.sender?.card || event.sender?.nickname || String(event.user_id),
    userId: String(event.user_id),
    // ⚠️ 2026-09-15 晚：**记住是哪个群的** —— 观察出来的东西要写进**那个群自己的资料库**
    //    （`knowledge/groups/<群号>.md`），别再往共享文件里混。
    // ⚠️⚠️ 2026-09-17：私聊**优先归到他跟机器人共有的那个群**（用户要求"私聊和群用一套
    //    资料库"），见 `scopeForObservation` 的注释。查不到共有群才退回 `dm:<QQ号>`。
    groupId: scopeFor(event),
    // ⚠️ 2026-09-17：**记下这条是不是私聊来的**。
    //    光看 `groupId` 分不出来（私聊归到群号之后，跟群消息长得一模一样），
    //    但收尾选文件时必须分得清 —— 见 `targetFileFor` 里那段"绝不能掉回共享文件"。
    fromPrivate: mt === 'private',
    text: String(text).slice(0, 200),
    at: Date.now(),
  });
  // 别无限攒（万一一直没触发）
  if (pending.length > 2000) pending = pending.slice(-1000);
}

export function pendingCount() {
  return pending.length;
}

export function status() {
  return {
    enable: config.observe?.enable !== false,
    threshold: config.observe?.threshold ?? 200,
    pending: pending.length,
    ...stats,
  };
}

/** 测试用：确认"私聊记忆到底会写到哪个文件"—— 写错地方 = 私聊内容泄漏给所有群 */
export function __targetFileFor(groupId, fromPrivate = false) {
  return targetFileFor(groupId, fromPrivate);
}

/**
 * 这个 scope 的观察该写进哪个文件。
 *
 * ⚠️ 2026-09-28 大改：观察记忆**独立目录** `knowledge/observe/`，
 *    跟"学到的知识"（`groups/` `dm/`）彻底分开 —— 以前两者写同一份文件、靠标记区隔开，
 *    于是注入要互相摘、界面校验别扭、备份粒度也对不上（详见 knowledge.js 里那段注释）。
 *
 *    现在路径**永远由 scope 算出来**，不再"看哪个文件存在就往哪写"：
 *      group:<群号> → `observe/<群号>.md`      （只在这个群注入）
 *      dm:<QQ号>    → `observe/dm-<QQ号>.md`  （只在跟这个人私聊时注入）
 *      认不出 scope → `observe/_shared.md`    （⚠️ 几乎不会发生；真发生了下面会 warn）
 *
 *    ⚠️ 这样比原来还安全一格：旧版最后会**回落**到共享的群资料库
 *    —— 那是所有群都看得到的地方，写错一次就是泄漏（`test/dm-memory.js` 【3】盯的就是这个）。
 *    现在那个回落口**没有了**：算不出 scope 就落 `_shared.md`，而 `_shared`
 *    永远不会匹配到任何真群号，等于"宁可丢也不泄漏"。
 *
 * @param {string} groupId `group:<群号>` 或 `dm:<QQ号>`（见 `observe.scopeFor()`）
 * @param {boolean} [fromPrivate] 保留给旧调用点/测试；现在不再影响选路
 */
function targetFileFor(groupId, fromPrivate = false) {
  const gid = String(groupId ?? '').trim();
  if (!gid) {
    log.warn(`[观察] 认不出这是哪个群的观察（fromPrivate=${!!fromPrivate}）→ 落 _shared.md（不会被任何群读到）`);
    return FILE;
  }
  if (gid.startsWith('dm:')) return join(KDIR, 'observe', `dm-${gid.slice(3)}.md`);
  return join(KDIR, 'observe', `${gid}.md`);
}

/** 把文件里的自动区替换成新内容；没有标记区就建骨架再写 */
function patchFile(body, file = FILE) {
  // ⚠️⚠️ 2026-10-05 加：**写之前先备份**。
  //    起因：我自己的测试把用户**两个群的资料库**写坏又删掉了，翻提示词快照、旧备份目录
  //    都救不回来（最后只能走 OneDrive 回收站）—— 而 `backupKnowledge` **早就在这个文件里
  //    import 了、却一次都没调用过** ✗（`knowledge/_backup/` 里只有 server-basic / learned，
  //    一份 groups 都没有）。观察是**自动后台写**的，没备份等于"改坏了就没了"。
  try {
    backupKnowledge(file);
  } catch (e) {
    log.debug(`[观察] 写前备份失败（继续写）：${e.message}`);
  }
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // ⚠️ 2026-09-28：观察记忆**一律**落在 `knowledge/observe/` 下（见 `targetFileFor`），
    //    所以这里只需要建这一个目录 —— 以前那套"看是 dm/ 还是 groups/ 就给哪种骨架"
    //    的分支全没了（路径现在由 scope 唯一决定，骨架也就只有一种，写不错）。
    const isDm = /[\\/]observe[\\/]dm-/.test(file);
    try {
      mkdirSync(join(KDIR, 'observe'), { recursive: true });
    } catch { /* 建不出来就等写盘那步自己报错 */ }
    // ⚠️ 2026-09-28（用户要求）：这条安全规则原来写在 group-memory.md 的手写区里，
    //    那个文件已经删掉了。规则本身不能跟着文件一起丢 —— 它是**给观察用的护栏**，
    //    所以放进代码生成的骨架：以后**任何**群/私聊新建观察文件都自带这一条。
    const RULE = '> ⚠️ 别把群里的玩笑当成知识记住。\n';
    raw = isDm
      ? `# 私聊观察（跟这个人私聊时攒下来的）\n\n> 这一份**只在跟这个人私聊时注入**，别的群、别的人都看不到。\n${RULE}`
      : `# 群观察（这个群自己暗中攒的）\n\n> 这一份**只在这个群注入**，别的群看不到。\n${RULE}`;
  }

  const block = [BEGIN, body.trim(), END].join('\n');

  if (raw.includes(BEGIN) && raw.includes(END)) {
    // 只换标记区之间
    const i = raw.indexOf(BEGIN);
    const j = raw.indexOf(END) + END.length;
    raw = raw.slice(0, i) + block + raw.slice(j);
  } else {
    // 第一次：插在「## 五、怎么用」之前；找不到就追加到末尾
    const anchor = raw.indexOf('## 五、怎么用');
    const heading = [
      '## 四点半、自动观察（机器人自己攒的）',
      '',
      '> 下面这段是机器人**自己暗中积累**的观察，不是你写的，随时会被覆盖。',
      '> 想改就改，但下次总结可能会把它合进去。',
      '',
      block,
      '',
      '---',
      '',
    ].join('\n');
    raw = anchor >= 0 ? raw.slice(0, anchor) + heading + raw.slice(anchor) : `${raw.trimEnd()}\n\n${heading}`;
  }

  try {
    writeFileSync(file, raw, 'utf8');
    return true;
  } catch (e) {
    log.warn(`[观察] 写不进去（${file}）：${e.message}`);
    return false;
  }
}

/** 取出标记区里现在已有的内容（给模型避免重复用） */
function currentObserved(file = FILE) {
  try {
    const raw = readFileSync(file, 'utf8');
    const i = raw.indexOf(BEGIN);
    const j = raw.indexOf(END);
    if (i < 0 || j < 0) return '';
    return raw.slice(i + BEGIN.length, j).trim();
  } catch {
    return '';
  }
}

const PROMPT = `你在帮一个 QQ 群客服机器人**暗中积累**对群和群友的了解。

你会看到一批群聊记录，以及**它已经记下的内容**。请输出**这次新观察到的东西**。

## 输出格式（严格照做）

### 群友
- **昵称**（QQ 12345678）：一句话描述这个人（爱好、说话风格、在意什么、怎么跟他打交道）

### 大事
- 日期或「最近」：一句话说清发生了什么

## ⚠️⚠️ 关于 QQ 号（2026-09-28 加，用户要求）

群昵称**会一直变**，QQ 号**不会变**。所以每条群友观察**必须带 QQ**：

- **同一个 QQ 就是同一个人**。他改了昵称 → **只更新那一条**里的昵称，**绝不新增条目**。
  （不这么要求的话，改一次昵称就多一条，同一个人最后七八条，提示词里全是重复。）
- **两个人用了同一个昵称** → 靠 QQ 分开，各写各的，**不许合并成一条**。
- 昵称和 QQ 对不上时**以 QQ 为准**（记录里都带着 \`[QQ xxx]\`，不会认错）。
- 输入里某人这次没标 QQ → 那条就**别带 QQ**，原样写昵称就行。

## 硬要求

- **只写新东西**。已经记过的不要重复写。
- **没观察到就留空**（那一节下面什么都不写），**绝对不要为了凑数编**。
- ⚠️ **群友观察尽量多写**（最多 12 条）—— 用户要的是**性格不断细化**：
  · 同一件事反复出现的（总问同一个问题、总在某时段冒泡）→ **那就是性格，写下来**
  · 已经记过这个人的，可以**再补一条更细的**（新角度、新场合下的表现）
  · 宁可多记一条细节，也别因为"大概记过了"就跳过
- 大事最多 3 条。**宁少勿滥。**
- ⚠️ **只写从聊天里真能看出来**的。看不出来就不写。
- **不写隐私**：真实姓名、学校、住址、联系方式、家庭情况一律不要。
- **不写负面标签**（「这人很烦」「情商低」这种不要）。写客观特点就行。
- 描述要**有助于以后跟他说话**（比如「喜欢发脑洞梗，接住他的梗他就高兴」）。
- 不要写「我记录了他」这类话。
- 只输出上面那两节，不要开场白、不要解释。`;

/**
 * 压缩用的提示词（2026-09-14 用户要求）。
 *
 * ⚠️⚠️ 用户的两条硬约束，都写在下面：
 *   「**压缩不重要的事情**，但是**性格要不断细化，不能删除**」
 *
 * 所以这里的规矩和"总结"完全不同：
 *   · 大事 → **允许**合并、缩短、把旧的压成一句
 *   · 性格 → **只许更细、合并更好的说法；一条都不许删**
 *
 * ⚠️ 另外**绝对不许**提到好感度 —— 那是 `src/affinity.js` 管的，
 *    存在 `state/affinity.json`，**不在这个文件里**。
 *    提示词里连提都不提，免得模型以为要在观察区里维护一个数字。
 */
const COMPRESS_PROMPT = `你在帮一个 QQ 群客服机器人**整理**它的群记忆（不是重新观察）。

你会看到它现在记着的内容。请**整理成更干净、更耐久的一版**。

## 两节的整理规矩**完全不同**，看清了再动

### 「群友」这节 —— ⚠️ **只许细化，一条都不许删**

- 每一条都是**性格特征**，是长期有用的东西，**再啰嗦也不许删**。
- ⚠️⚠️ **合并只认 QQ，不认昵称**（2026-09-28 加，用户要求）：
  群昵称会一直变、QQ 不会变。**同一个 QQ 的多条必须合并成一条**（哪怕昵称不同 —— 那是他改昵称了，
  **不是换了个人**）；**不同 QQ 哪怕昵称一样，也必须各留各的**（那是重名，不是同一个人）。
  条目格式照旧：- **昵称**（QQ 12345678）：描述。
- 你可以做的是：
  · 把**同一个人的多条**合并成一条，但**信息只能变多不能变少**（细节全保留）
  · 把啰嗦的说法**改写得更准**（「爱刷屏」→「习惯连发多条短消息、爱复读别人的话」）
  · 补上**跨条目的共性**（比如三个人都爱在深夜冒泡，可以在各自那条里点出来）
- ❌ **不许**因为"时间久了"就把某条删掉
- ❌ **不许**把具体细节抽象成空话（「人挺好的」这种等于删掉）

### 「大事」这节 —— ✅ **可以按时间压缩**

- **重要的事必须留着**（服务器重启/整改、谁被处理、群里的大变动、有人退群或入群、第一次发生的事）
- **不重要的事可以合并或压短**：
  · 同一类反复发生的 → 合并成一条（「9 月上旬：群里多次因为 X 刷屏，每次都是 Y 出来收场」）
  · 太琐碎的（某人某天随便聊了什么）→ 直接去掉
  · 保留时间感，但**允许模糊**（「9 月上旬」「上个月」）
- 目标：大事这节**控制在 15 条以内**，越旧越短

## 输出格式

照原样两节，标题还是 \`### 群友\` 和 \`### 大事\`：

### 群友
- **昵称**（QQ 12345678）：描述

### 大事
- 时间：发生了什么

## 绝对不许

- ❌ 不许编新的内容（你是在**整理**，不是观察）
- ❌ 不许写任何**数字评分**（好感度之类的是另一套东西，**不在这个文件里**，别往这儿写）
- ❌ 不许写「我记录了」「已整理」这类话
- ❌ 不要开场白、不要解释，只输出那两节`;

/**
 * 跑一次总结。攒够 threshold 条才真的跑。
 * @param {{force?:boolean}} opts
 * @returns {Promise<{ok:boolean, reason?:string, added?:number}>}
 */
export async function summarize(opts = {}) {
  if (config.observe?.enable === false) return { ok: false, reason: '观察功能已关闭' };
  if (running) return { ok: false, reason: '上一次还在跑' };

  const threshold = Math.max(20, Number(config.observe?.threshold ?? 200));
  if (!pending.length) return { ok: false, reason: '没有新消息' };

  // ⚠️⚠️ 2026-09-15 晚：**按群分开总结、分开写**。
  //    原来是"所有群的消息攒一起 → 一次总结 → 写进同一份共享文件" ✗
  //    → 699 群的人和事会被写进共享文件，**所有群都看得到**（<主人> 报的就是这个：
  //      「最开始的群只玩 mc，699 那个群群友玩的游戏很多」）。
  //    现在：每个群攒够自己那一份就单独跑一次，写进**那个群自己的资料库**
  //    （没有群资料库文件的群，仍然写共享文件 —— 保持老行为，不惊动别的群）。
  const byGroup = new Map();
  for (const m of pending) {
    const g = String(m.groupId ?? '');
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(m);
  }
  // ⚠️⚠️ 2026-09-17（用户：「最近消息太少了，再加个时间阈值就行了」）——
  //
  //    **消息少的群永远攒不到 threshold**，那份群资料就永远不更新。
  //    实测：752（主群）一天才一百多条，而 `pending` 只在内存、**重启就清零**，
  //    结果它的群资料**从来没生成过**（连 `state/observe.json` 都不存在）——
  //    用户截图来问「这个人喜欢喵喵喵没记下来」，就是这个原因。
  //
  //    所以补一条**时间兜底**：这一群里**最老的一条**超过 `maxAgeMs` 就总结，
  //    哪怕只剩几条也总结。消息多的群照旧按条数触发，两条路互不影响。
  const maxAgeMs = Math.max(60000, Number(config.observe?.maxAgeMs) || 6 * 3600 * 1000);
  const nowMs = Date.now();
  const jobs = [...byGroup.entries()].filter(([, list]) => {
    if (opts.force) return true;
    if (list.length >= threshold) return true;
    const oldest = list[0]?.at ?? nowMs;
    return nowMs - oldest >= maxAgeMs;
  });
  if (!jobs.length) {
    const most = Math.max(...[...byGroup.values()].map((l) => l.length));
    return {
      ok: false,
      reason: `还没攒够（最多的一群 ${most}/${threshold} 条；或者等满 ${Math.round(maxAgeMs / 3600000)} 小时）`,
    };
  }

  running = true;
  const done = new Set();
  let totalAdded = 0;
  try {
    for (const [gid, list] of jobs) {
      const batch = list.slice(-threshold);
      for (const m of batch) done.add(m);
      const file = targetFileFor(gid, list.some((m) => m.fromPrivate));
      const lines = batch
        // ⚠️ 2026-09-28：把 **QQ 一起喂进去**（用户要求：昵称会一直变、QQ 不会变，
        //    只给昵称的话模型分不清"他改昵称了"和"换了个人"，观察区最后全是重复条目）。
        //    `m.userId` 是 `note()` 一开始就存好的，那会儿没喂给模型 —— 就是这儿漏的。
        //    ⚠️ 2026-10-04：格式跟群上下文统一成 `昵称(QQ号)`（以前是 `[QQ 号] 昵称`，顺序还是反的）
        .map((m) => `${whoTag(m.name, m.userId)}：${m.text}`)
        .join('\n')
        .slice(0, 12000);

      const existing = currentObserved(file);
      const user = [
        existing ? `# 已经记下的\n${existing.slice(0, 2000)}\n` : '# 已经记下的\n（还没有，这是第一次）\n',
        `# 这批群聊记录（${batch.length} 条${gid ? `，群 ${gid}` : ''}）\n${lines}`,
      ].join('\n');

      const res = await collect([
        { role: 'system', content: PROMPT },
        { role: 'user', content: user },
      ]);

      const raw = String(res ?? '').trim();
      if (!raw) {
        log.info(`[观察] 群 ${gid || '(无群号)'} 模型没返回内容，这批留着下次再试`);
        for (const m of batch) done.delete(m); // 没成功就不算处理过
        continue;
      }

      const parsed = parseSections(raw);
      const added = parsed.people.length + (parsed.events.length ? 1 : 0);
      if (!added) {
        log.info(`[观察] 群 ${gid || '(无群号)'} 这次没观察到新东西`);
        stats.runs++;
        stats.lastRunAt = Date.now();
        continue;
      }

      const merged = merge(existing, parsed);
      const ok = patchFile(merged, file);
      // ⚠️⚠️ 2026-10-05 加（用户要求：「在机器人记群里内容的时候，加一个能撤回记住的机制，
      //    只要 @机器人 然后以自然语言说出『忘记刚才那个』之类的话，就撤回记住的那条」）：
      //    **写成功之后**把"改之前是什么样"存一份快照 —— 撤回就是把它写回去，
      //    见下面的 `undoLast()`。⚠️ 必须在 `patchFile` **之后**（写失败就不该能撤）。
      if (ok) pushUndo({ file, gid, before: existing, after: merged });
      if (!ok) {
        log.warn(`[观察] 群 ${gid || '(无群号)'} 写文件失败，这批留着下次再试`);
        for (const m of batch) done.delete(m);
        continue;
      }
      totalAdded += added;
      stats.runs++;
      stats.added += added;
      stats.lastRunAt = Date.now();
      log.info(
        `[观察] 群 ${gid || '(无群号)'} 总结完成：新增 ${parsed.people.length} 条群友观察、${parsed.events.length} 条大事 → ${file.replace(ROOT, '.')}`,
      );
    }

    // 只清掉**这次真的处理过**的那些（别的群没攒够的要留着）
    if (done.size) pending = pending.filter((m) => !done.has(m));
    reloadKnowledge(); // 立刻生效，不用重启
    return { ok: true, added: totalAdded, groups: jobs.length };
  } catch (e) {
    stats.lastError = e.message;
    log.warn(`[观察] 总结失败：${e.message}`);
    return { ok: false, reason: e.message };
  } finally {
    running = false;
  }
}

/** 把模型输出切成两节 */
function parseSections(raw) {
  const people = [];
  const events = [];
  const seenQq = new Set(); // ⚠️ 2026-09-28：同一个 QQ 不许出现两条
  let mode = '';
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (/^#+\s*群友/.test(t) || /^群友[:：]?$/.test(t)) {
      mode = 'people';
      continue;
    }
    if (/^#+\s*大事/.test(t) || /^大事[:：]?$/.test(t)) {
      mode = 'events';
      continue;
    }
    if (!t || t === '-' || /^#+\s/.test(t)) continue;
    const item = t.replace(/^[-*·]\s*/, '').trim();
    if (!item || item.length < 4) continue;
    // ⚠️ 性格（群友）**不设小上限**：用户要的是"不断细化"
    //    （原来这里限 5 条，等于把细节扔了）。只用一个宽松的护栏防刷屏。
    if (mode === 'people' && people.length < 12) {
      // ⚠️ 2026-09-28：**同一个 QQ 只留一条**（用户要求：昵称会一直变、QQ 不会变）。
      //    模型要是没听提示词、把一个改过昵称的人写了两遍，这里兜住 ——
      //    不兜的话观察区会越攒越臃肿（同一个人七八条），注入提示词全是重复内容。
      const qq = qqOf(item);
      if (qq) {
        if (seenQq.has(qq)) continue;
        seenQq.add(qq);
      }
      people.push(item);
    }
    if (mode === 'events' && events.length < 3) events.push(item);
  }
  return { people, events };
}

/**
 * 从一条观察里抠出 QQ 号（`- **昵称**（QQ 12345678）：描述`）。
 * @returns {string} 没有就返回 ''（不猜、不从别处补）
 */
function qqOf(item) {
  const m = /[（(]\s*QQ\s*:?\s*(\d{5,12})\s*[）)]/i.exec(String(item ?? ''));
  return m ? m[1] : '';
}

/**
 * 新的放前面，去掉明显重复的旧条目。
 *
 * ⚠️⚠️ **性格条目保留上限从 20 提到 60**（2026-09-14 用户要求「性格要不断细化」）。
 *    原来 `oldPeople.slice(0, 20)` —— 攒到 20 条之后**每加一条就挤掉最老的一条**，
 *    等于性格**永远停在 20 条、细节被慢慢冲掉**，和"不断细化"正好相反。
 *    大事仍然限 20（那个本来就要靠 `compress()` 按时间压）。
 */
function merge(existing, parsed) {
  const old = existing.split(/\r?\n/).filter((l) => l.trim());
  const oldPeople = [];
  const oldEvents = [];
  let mode = '';
  for (const l of old) {
    const t = l.trim();
    if (/^#+\s*群友/.test(t)) { mode = 'p'; continue; }
    if (/^#+\s*大事/.test(t)) { mode = 'e'; continue; }
    // ⚠️ 「最后更新」这类元信息别当成条目攒下来（之前每次跑都追加一行，越积越多）
    if (/^>\s*最后更新/.test(t)) continue;
    if (!t || t.startsWith('>')) continue;
    if (mode === 'p') oldPeople.push(t);
    else if (mode === 'e') oldEvents.push(t);
  }

  // 简单去重：新条目的「昵称/主体」如果已经在旧条目里出现过，就不再重复
  const keyOf = (s) => (s.replace(/^[-*·]\s*/, '').split(/[:：]/)[0] || '').slice(0, 8);
  const seenKeys = new Set(oldPeople.map(keyOf));
  const freshPeople = parsed.people.filter((p) => !seenKeys.has(keyOf(p)));

  const seenEv = new Set(oldEvents.map((e) => e.slice(0, 12)));
  const freshEvents = parsed.events.filter((e) => !seenEv.has(e.slice(0, 12)));

  const PEOPLE_KEEP = Number(config.observe?.keepPeople) > 0 ? Number(config.observe.keepPeople) : 60;
  const EVENTS_KEEP = Number(config.observe?.keepEvents) > 0 ? Number(config.observe.keepEvents) : 20;

  const out = [];
  out.push('### 群友', '');
  if (freshPeople.length) out.push(...freshPeople.map((p) => `- ${p}`));
  if (oldPeople.length) out.push(...oldPeople.slice(0, PEOPLE_KEEP));
  out.push('', '### 大事', '');
  if (freshEvents.length) out.push(...freshEvents.map((e) => `- ${e}`));
  if (oldEvents.length) out.push(...oldEvents.slice(0, EVENTS_KEEP));
  out.push('', `> 最后更新：${new Date().toLocaleString('zh-CN')}`);
  return out.join('\n');
}

/**
 * **按时间压缩**自动区（2026-09-14 用户要求）。
 *
 * 用户原话：「再加一个**按时间压缩**的功能，**压缩不重要的事情**，
 *   但是**性格要不断细化，不能删除**，**好感度也不能修改**」。
 *
 * ## 两道保险（都必要）
 *
 * ① **提示词里写死规矩**（见 `COMPRESS_PROMPT`）：性格只许细化/合并，大事才能压
 * ② **代码校验条数**：压缩后**性格条数不许比之前少** ——
 *    少了就**整次作废、不写盘**。提示词不可靠（这个项目里反复验证过），
 *    而"性格被悄悄删掉"是**不可逆**的损失（备份也救不回来语义），
 *    所以宁可白跑一次。
 *
 * ⚠️ 好感度**不参与**这里的任何计算 —— 它在 `state/affinity.json`，
 *    本模块不知道它的存在。这是用户明确要求的（"好感度也不能修改"）。
 *
 * @param {{force?:boolean}} opts
 * @returns {Promise<{ok:boolean, reason?:string, peopleBefore?:number, peopleAfter?:number}>}
 */
/** 从 `observe/` 里挑一份**有内容可压**的文件（调用方没给 scope 时用） */
function anyObserveFileWithContent() {
  const dir = join(KDIR, 'observe');
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return FILE; // 目录还不存在 = 还没有任何观察
  }
  for (const n of names) {
    if (!n.toLowerCase().endsWith('.md')) continue;
    const f = join(dir, n);
    if (currentObserved(f)) return f;
  }
  return FILE;
}

/**
 * 按时间压缩：性格只许细化/合并（一条都不许删），大事压成按时间的小结。
 *
 * ⚠️ 2026-09-28：观察记忆**按 scope 分文件**之后，"压哪一份"必须显式选 ——
 *    以前这里 `currentObserved()` 不带参数、默认读那**一个**共享文件；
 *    拆开以后那样读到的是空的 → 一进来就「没什么可压」返回，连状态都不落盘
 *    （`test/observe-compress.js` 就是这么崩的）。
 *
 *    现在：`opts.groupId` 给了就压那一份；没给就从**有内容**的那几份里挑一份。
 *    ⚠️ 下面那个「距上次压缩 minIntervalMs」是**全局**冷却，所以一次最多压一份 ——
 *    模型调用花销和拆分之前一样，不会因为多了几个文件就翻倍。
 *
 * @param {{force?:boolean, groupId?:string}} opts
 *        `groupId` 用 `group:<群号>` / `dm:<QQ号>`（跟 `summarize` 同一套，见 `scopeFor()`）
 */
export async function compress(opts = {}) {
  if (config.observe?.enable === false) return { ok: false, reason: '观察功能已关闭' };
  if (config.observe?.compress?.enable === false) return { ok: false, reason: '压缩功能已关闭' };
  if (running) return { ok: false, reason: '上一次还在跑' };

  // ⚠️ 「距上次压缩至少隔 minIntervalMs」（默认 3 天）——
  //    压太勤没意义，还白花一次模型调用。
  //    `lastCompressAt` 是**落盘**的，所以重启不会让它重来一次。
  const minGap = Number(config.observe?.compress?.minIntervalMs) || 3 * 24 * 3600 * 1000;
  if (!opts.force && stats.lastCompressAt && Date.now() - stats.lastCompressAt < minGap) {
    const left = Math.round((minGap - (Date.now() - stats.lastCompressAt)) / 3600000);
    return { ok: false, reason: `距上次压缩还不到 ${Math.round(minGap / 3600000)} 小时（还有 ${left} 小时）` };
  }

  // ⚠️ 2026-09-28：压哪一份 —— 有 scope 就压那一份，没给就从有内容的里挑一份
  const gid = String(opts.groupId ?? '').trim();
  const target = gid ? targetFileFor(gid) : anyObserveFileWithContent();
  const existing = currentObserved(target);
  if (!existing) return { ok: false, reason: '自动区还是空的，没什么可压' };

  const before = parseSections(existing);
  // 太少就别压了 —— 压了也没东西可压，白花一次调用
  if (before.events.length <= 8 && before.people.length <= 6) {
    return { ok: false, reason: `内容还不多（性格 ${before.people.length} / 大事 ${before.events.length}），先不压` };
  }

  running = true;
  try {
    const res = await collect([
      { role: 'system', content: COMPRESS_PROMPT },
      { role: 'user', content: `# 现在记着的内容\n${existing.slice(0, 8000)}` },
    ]);
    const raw = String(res ?? '').trim();
    if (!raw) return { ok: false, reason: '模型没返回内容' };

    const after = parseSections(raw);

    // ⚠️⚠️ 保险：性格**不许变少**（用户明确要求"不能删除"）
    if (after.people.length < before.people.length) {
      log.warn(
        `[观察] 压缩后性格条目变少了（${before.people.length} → ${after.people.length}），**整次作废不写盘**`,
      );
      return {
        ok: false,
        reason: `压缩把性格从 ${before.people.length} 条砍到 ${after.people.length} 条，已作废`,
        peopleBefore: before.people.length,
        peopleAfter: after.people.length,
      };
    }
    if (!after.people.length && before.people.length) {
      return { ok: false, reason: '压缩后一条性格都没了，已作废' };
    }

    // 重建（保留「最后更新」那行）
    const merged = [
      '### 群友',
      '',
      ...after.people.map((p) => `- ${p}`),
      '',
      '### 大事',
      '',
      ...after.events.map((e) => `- ${e}`),
      '',
      `> 最后更新：${new Date().toLocaleString('zh-CN')}（压缩整理）`,
    ].join('\n');

    if (!patchFile(merged, target)) return { ok: false, reason: '写文件失败' };
    reloadKnowledge();

    stats.compressRuns = (stats.compressRuns ?? 0) + 1;
    stats.lastCompressAt = Date.now();
    saveState();
    log.info(
      `[观察] 压缩完成：性格 ${before.people.length} → ${after.people.length} 条（只能变多），` +
        `大事 ${before.events.length} → ${after.events.length} 条`,
    );
    return {
      ok: true,
      peopleBefore: before.people.length,
      peopleAfter: after.people.length,
      eventsBefore: before.events.length,
      eventsAfter: after.events.length,
    };
  } catch (e) {
    stats.lastError = e.message;
    log.warn(`[观察] 压缩失败：${e.message}`);
    return { ok: false, reason: e.message };
  } finally {
    running = false;
  }
}

// ── 撤回最近一次观察（2026-10-05 用户要求）──────────────────────
//
// 用户原话：「在机器人记群里内容的时候，加一个能撤回记住的机制，只要 @机器人
//   然后以自然语言说出忘记刚才那个 之类的话，就撤回记住的那条，区别于 / 的命令」
//
// 拍板（两个来回问过的）：
//   · 粒度 = **撤销最近一次总结**（不是"删一条"）——
//     ⚠️ 因为 `patchFile` 是**整块替换**自动观察区，代码里压根没有"第 N 条"这种东西；
//     存"改之前的整块"再写回去，才是可靠且可预期的做法。
//   · 权限 = 只有服主 / 管理员 / 群管（见 `bot.js` 的 `tryForgetMemory`）。
//
// ⚠️ 快照必须**按群找**：一次 summarize 会给好几个群各写一次，
//    "撤回"只该撤**当前这个群**那一次，别把别的群的记录也卷回来。
const UNDO_FILE = process.env.QQBOT_OBSERVE_UNDO_FILE
  ? join(ROOT, process.env.QQBOT_OBSERVE_UNDO_FILE)
  : join(stateDir(), 'observe-undo.json');
/** 留最近几次（够用就行，别把状态文件堆大） */
const UNDO_KEEP = 10;

function readUndo() {
  try {
    const a = JSON.parse(readFileSync(UNDO_FILE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function writeUndo(list) {
  try {
    mkdirSync(dirname(UNDO_FILE), { recursive: true });
    const tmp = `${UNDO_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(list.slice(-UNDO_KEEP), null, 2), 'utf8');
    renameSync(tmp, UNDO_FILE);
  } catch (e) {
    log.warn(`[观察] 撤回快照写不进去：${e.message}`);
  }
}

/** 记一份「改之前长什么样」。⚠️ 只在写成功之后调用 */
function pushUndo({ file, gid, before, after, kind = 'observe', title = '', entries }) {
  const list = readUndo();
  list.push({
    at: Date.now(),
    // ⚠️ 2026-10-06 加（用户：「把撤回扩展到教学」）：**两类快照的还原方式不一样** ——
    //    · `observe`（群记忆）→ 写的是**自动观察区**，还原时只换标记区之间
    //    · `teach`（教学）→ 写的是 `server-basic.md` 那种**散文式全局知识库**，
    //      没有标记区 ⇒ 必须**整文件写回**（见 `restoreFile`）
    //    所以每条快照都得记下自己是哪一类，否则撤回时会用错还原方式、把文件写坏。
    kind: String(kind ?? 'observe'),
    // 教学的主题名 —— 撤回后要能告诉她"撤的是哪一条"（观察快照没这个，空串）
    title: String(title ?? ''),
    file: String(file ?? ''),
    gid: String(gid ?? ''),
    // ⚠️ `before` 允许是 `null`：表示**这个文件当时还不存在**（教学第一次给某个群
    //    建库就会这样）。撤回时要把文件**删掉**，而不是写回一份骨架 ——
    //    不然会凭空多出一个之前没有的文件。
    before: before === null ? null : String(before ?? ''),
    after: String(after ?? ''),
    // ⚠️ 只用来告诉她"撤了几条" ⇒ 必须算**新增**的条数（`after - before`），
    //    不是 `after` 里总共有几条 —— 第一版算的是总数，测试里报成 3（实际新增 2）。
    //    改写的那些（差值 0）就报"那次记的内容删了"，不硬凑数字。
    // ⚠️ 教学快照自己传 `entries`（它按 `## 标题` 组织，数不出 `- ` 行）。
    entries:
      entries !== undefined
        ? Math.max(0, Number(entries) || 0)
        : Math.max(
            0,
            (String(after ?? '').match(/^- /gm) ?? []).length -
              (String(before ?? '').match(/^- /gm) ?? []).length,
          ),
  });
  writeUndo(list);
}

/** 还能撤几次（测试 / 诊断用） */
export function undoCount(groupId = '') {
  const gid = String(groupId ?? '');
  return readUndo().filter((s) => !gid || String(s.gid) === gid).length;
}

/**
 * 把**整份文件**写回去 —— 撤回教学用（2026-10-06 加）。
 *
 * ⚠️⚠️ 为什么**不能复用 `patchFile`**：那个函数只认**自动观察区**
 *    （`<!-- AUTO-OBSERVE:BEGIN -->`），文件里没有那对标记时它会**自己包一个**
 *    再写进去 ⇒ `server-basic.md` 那种散文式知识库会被套上一层标记区，
 *    内容也会被挪位。教学写的恰恰就是那几份 ⇒ 必须走这条**整文件还原**。
 *
 * @returns {boolean} 写成功没有
 */
function restoreFile(file, content) {
  try {
    backupKnowledge(file);
  } catch (e) {
    log.debug(`[观察] 还原前备份失败（继续写）：${e.message}`);
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, String(content ?? ''), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch (e) {
    log.warn(`[观察] 还原 ${basename(file)} 失败：${e.message}`);
    return false;
  }
}

/**
 * 记一份「**教学**之前长什么样」—— 让「撤回」也能撤掉**教给她的知识**。
 *
 * ⚠️ 2026-10-06 加（用户原话：「把撤回扩展到教学」）。
 *    以前只有**自动观察**（群记忆）能撤：教学写的是 `server-basic.md` /
 *    `server-rules.md` / `server-world.md` / `server-people.md` 那几份**全局知识库**
 *    （`learned.js` 的 `upsertIntoFile`），**压根没有退路** ——
 *    教错一条只能去界面上手改，`/撤回` 还会回一句"没有什么可撤的诶"。
 *
 * ⚠️ 调用点在 `learned.js` 的 `learn()` —— **写成功之后**才记（写失败就不该能撤）。
 * ⚠️ `gid` 记的是**教学发生的那次群聊**：教学写进的是全局库，但"撤回最近一次"
 *    是按群聊会话算的，不然 A 群撤回会把 B 群刚教的东西抹掉。
 *
 * @param {{file:string, gid:string, before:string|null, after:string, title?:string, added?:boolean}} p
 *   `before` = 写之前的**整份文件内容**；传 `null` 表示"这个文件当时还不存在"。
 */
export function pushTeachUndo({ file, gid, before, after, title = '', added = false }) {
  pushUndo({
    file,
    gid,
    before,
    after,
    kind: 'teach',
    title,
    // 教学一次只动**一条**（新增 1 条 / 覆盖 0 条），不像观察那样一写好几行
    entries: added ? 1 : 0,
  });
}

/**
 * 撤回**这个群最近一次**写入 —— 群记忆（自动观察）和教学**共用同一条队列**，
 * 所以"撤回"永远撤的是**最近发生的那一次**，不管它是哪种。
 *
 * @param {string} groupId 群号（'dm:<QQ>' 也认 —— 私聊记忆同一个机制）
 * @returns {{ok:boolean, kind?:string, title?:string, reason?:string, at?:number, removed?:number, preview?:string[]}}
 */
export function undoLast(groupId = '') {
  const gid = String(groupId ?? '');
  const list = readUndo();
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (gid && String(s.gid) !== gid) continue;
    const kind = String(s.kind ?? 'observe');
    // ⚠️ 两类快照**还原方式不同**（见 `restoreFile` 上面那段）：
    //    · 'teach' → 整文件写回；`before === null` = 文件本来不存在 → 删掉它
    //    · 'observe' → 只换自动观察区之间（老行为，没动）
    let restored;
    if (kind === 'teach') {
      if (s.before === null) {
        try {
          rmSync(s.file, { force: true });
          restored = true;
        } catch (e) {
          log.warn(`[观察] 撤教学时删文件失败：${e.message}`);
          restored = false;
        }
      } else {
        restored = restoreFile(s.file, s.before);
      }
    } else {
      restored = patchFile(s.before, s.file);
    }
    if (!restored) {
      return { ok: false, reason: '写不回去（文件被占用或者没有权限）' };
    }
    list.splice(i, 1);
    writeUndo(list);
    // ⚠️ 知识是**启动时读进内存**的 —— 不重载的话，撤回只改了磁盘，
    //    她这次说话用的还是撤掉之前那份（用户会以为"撤了但没生效"）。
    try {
      reloadKnowledge();
    } catch (e) {
      log.warn(`[观察] 撤回后重载知识失败（重启才生效）：${e.message}`);
    }
    // ⚠️ 教学快照的 `after` 是**整份文件**，按 `- ` 行去筛会捞出一堆跟这次无关的旧条目
    //    ⇒ 教学只报**主题名**（那个才是"撤了哪一条"）。
    const preview =
      kind === 'teach'
        ? [String(s.title ?? '').trim()].filter(Boolean)
        : String(s.after ?? '')
            .split('\n')
            .filter((l) => l.trim().startsWith('- '))
            .slice(0, 3)
            .map((l) => l.trim().replace(/^- /, '').slice(0, 40));
    return {
      ok: true,
      kind,
      title: String(s.title ?? ''),
      at: Number(s.at ?? 0),
      removed: Number(s.entries ?? 0) || 0,
      preview,
    };
  }
  return { ok: false, reason: gid ? '这个群还没有能撤的记录' : '没有能撤的记录' };
}

/** 测试用：手动塞一条撤回快照（生产路径只有 `summarize` 里那一处会调 `pushUndo`） */
export function __pushUndoForTest(entry) {
  pushUndo(entry);
}

export function reset() {
  pending = [];
  seen = 0;
  stats.runs = 0;
  stats.added = 0;
  stats.lastRunAt = 0;
  stats.lastError = '';
  stats.compressRuns = 0;
  stats.lastCompressAt = 0;
  saveState();
}

// ⚠️ 模块加载时恢复「上次压缩时间」（见 STATE_FILE 的注释）
loadState();
