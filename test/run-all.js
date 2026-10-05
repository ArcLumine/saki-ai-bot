/**
 * 并行跑所有回归测试。
 *
 * ⚠️ 为什么需要（2026-09-13，用户反馈「跑回归时间太长了」）：
 *    9 个测试套件串行跑要 **287 秒**（4.8 分钟），而其中
 *    **127 秒是各测试里固定的 `sleep()`**（"睡 3.5 秒等机器人回复"那种），
 *    剩下的是 9 次 node 启动开销。
 *
 *    **它们互不干扰** —— 每个测试用**自己独立的端口区间**（实测无冲突）：
 *      e2e 39001-39002 / cs 39101-39104 / teach 39501-39502
 *      face 39601-39602 / webui 39701 / attitude 39801-39802
 *      behavior 40001-40002 / natural-teach 40101-40102
 *    所以那些 `sleep` 可以**并行地等**，总时间由最慢的那个决定。
 *
 * 用法：
 *   node test/run-all.js            # 默认 5 个并行
 *   node test/run-all.js --jobs 8   # 指定并行数
 *   node test/run-all.js --jobs 1   # 退化成串行（排查用）
 *
 * 输出：每个套件一行（耗时 + 结果），最后给总耗时和失败清单。
 */
import { spawn } from 'node:child_process';
import { readdirSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// ⚠️ 2026-09-29：参数解析在 `test/_args.js`（纯函数；单测是 `test/run-all-cli.js`）
import { parseArgs } from './_args.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 回归套件（顺序无关，各用独立端口） */
const SUITES = [
  'behavior',
  'attitude',
  'face',
  // ⚠️ 2026-09-20 加：解题模式判据（「带图 + 短消息」那条踩过两次 —— 见 test/solve.js 头注释）
  'solve',
  'webui',
  'cs',
  'teach',
  'learned-edit',
  'spend',
  'earn-prompt',
  'balance',
  'affinity',
  'qzone',
  // ⚠️ 2026-09-29 加：大模型出口 JSON 的兜底（speak-judge / attribution-guard /
  //    face-annotate 三处「正则截到 ≠ 能解析」），以及 webui 请求体不合法要 400。
  //    ⚠️ 纯源码断言 + 纯函数，**不联网、不花钱**、几毫秒跑完。
  //    （状态码那条另由 webui 套件真发一个坏 body 出去验，不是靠源码猜。）
  'json-fallback',
  'observe-compress',
  'monthly-report',
  'context',
  'presearch',
  'bilibili-scope',
  // ⚠️ 2026-09-22 加：生图（群里让她「拍个照」）——
  //    标记解析/剥净（场景可以是一整句，最容易漏）、失败**不许泄露故障码**、
  //    换服务商只改配置（ark / openai 两种请求形状）、串行只跑一个。
  //    ⚠️ 纯离线 + 假服务器，**不花钱**（真出图 0.2 元/张）。
  'imagegen',
  // ⚠️ 2026-09-23 加：**她到底看没看到那张图**（识图/vision 的不变量）。
  //    用户截图问「这个机器人识别到图片了吗，按道理 @ 她应该会读一遍图片的」——
  //    那次先单独发图、5 秒后才 @ 问「你能分清吗」，而补识图的判据只认指代词
  //    ⇒ 一个都没命中 ⇒ **连图都没看** ✗
  //    ⚠️ 这个功能此前**没有任何套件覆盖**（当时只有一次性视觉探针）——
  //    所以这个 bug 一直没被抓到；现在由 `vision` 套件钉住。
  //    ⚠️ 纯源码断言，**不联网、不花钱**。
  'vision',
  // ⚠️ 2026-09-23 加：**大模型出口的自动识别与切换**。
  //    踩到的真故障：启动时探到代理开着 ⇒ 设了全局 `NODE_USE_ENV_PROXY`；
  //    后来代理软件被关 ⇒ 机器人一句话都回不出来（全线 ECONNREFUSED），
  //    而老的"自动切换"只换自己那个 dispatcher、**管不着全局代理** ⇒ 是假的。
  //    用户要求「要能自动识别并切换」。⚠️ 纯源码断言，不联网。
  'egress',
  // ⚠️ 2026-10-04 加：「谁说的」统一格式 `昵称(QQ号)`（`src/who.js`）。
  //   改造前全项目有 5 种写法表示同一个人，模型看到两种括号会当成两种语义。
  //   纯函数、不联网、不花钱。
  'who-tag',
  // ⚠️ 2026-09-15 加：对话状态机（他/别人/没在聊三态 + 喂给说话判断的那段状态）
  'dialogue',
  // ⚠️ 2026-09-15 加：掉线补看（10 分钟内的 @ / 关键词 / 服务器问题，三道防重闸）
  'catchup',
  // ⚠️ 2026-09-15 晚加：引用（引用她 = 直接对她说话；她上次说话隔 ≥4 条就要引用；
  //    引用够了不许再补 @；余额见底那条的 @ 不许动）
  'quote',
  // ⚠️ 2026-09-15 晚加：知识库**分群**（群资料库只给那个群；共享文件的「群标签块」按群生效；
  //    二次元库仍然全局可用）
  'knowledge-groups',
  // ⚠️ 2026-09-21 加：人设管理（WebUI「人设」页的文件层）——
  //    id 对齐 / 必填校验 / 路径白名单 / 保存前备份 / 新建改名 / 删除留底。
  //    ⚠️ 它会**写和删**人设包，所以必须靠 `QQBOT_PERSONAS_DIR` 指到临时池
  //    （套件自己设，绝不能碰真实的 personas/）。
  'persona-admin',
  // ⚠️ 2026-09-21 加：人设**自动起草** —— 只测不联网那层（动画库清单 / 联网前校验 / 字数上限）。
  //    ⚠️ 起草本身要联网 + 调模型，**不进回归**：每跑一次就烧一次钱，网一断还红。
  'persona-draft',
  // ⚠️ 2026-09-30 加：人设**共用层 / 专属层**的边界。
  //    抽出 `personas/_shared/style.md` 那次，两类问题**都不会让任何现有测试变红**：
  //      ① 批量替换把字压烂了（出现过「一个都能省」这种语义正好反掉的句子）
  //      ② Saki 专属的东西（大小姐/高松灯/家道中落）漏在共用层里
  //    所以专门钉住这两条边界。全离线、只读真实文件，不写盘、不用临时池。
  'persona-layers',
  // ⚠️ 2026-09-15 晚加：好友/好感度接线（到线通知只发一次 + 被回应加分 + `/好感度` 出榜）。
  //    它一直在仓库里但**没进过回归名单**（用户要求加进来）。
  'friend',
  'follow-up',
  'tic',
  'live-persona',
  'meal',
  // ⚠️ 2026-09-18：「她人在哪 / 在做什么」的状态机（跟 meal 同一类东西）
  'where',
  // ⚠️ 2026-09-18：「几点提醒我干什么」的定时提醒（记下来 / 到点 @ 他 / 找不到的人不 @）
  'remind',
  'cooldown',
  // ⚠️ 2026-09-16 加：连发碎片自动续窗（「你/可/以/一/个/一/个/字/说/话/吗」那种一个字一条
  //    的消息，整串当成一句话只回一次；私聊也走合并；正常消息与 @她 的短窗口没被拖慢）
  //    顺带钉住「一个字一条」的回复彩蛋（她可以一个字一个气泡回；私聊随便玩、
  //    群里只在 @她/引用她 时，最多 8 个字，同会话 30 分钟一次）
  'burst',
  // ⚠️ 2026-09-16 加：戳一戳交给模型回（不再随机挑那四句写死的；进上下文、进记忆；
  //    戳=明确召唤；防刷屏冷却与文字兜底都还在）
  'poke',
  // ⚠️ 2026-09-16 加：喊妈妈（第一次拒绝；还喊就认了并切白祥模式；按群、落盘、能退出；
  //    别误伤「我妈/你妈的/妈呀」）
  'mama',
  // ⚠️ 2026-09-16 加：分群调节（日常事件的节奏 + 二级剧情的参数都按群；
  //    参数白名单/数值化"存了必须生效"；状态按群分桶"不同群的数据不混"；老格式迁移）
  'group-params',
  // ⚠️ 2026-09-16 加：这个点她在哪（上学日白天在教室、放学后才到客服室；
  //    不许说"坐了一天"、不许凭空放假 —— 用户截图报的人设/时间表冲突）
  'schedule',
  'join-scope',
  'at-other',
  'tone',
  'watchdog-state',
  'qq-qrcode',
  'provider',
  // ★ 开机自启：唯一一个会写**用户注册表**的功能 —— 盯"真写进去了 / 换了目录认得出 /
  //   关得掉"（值名走 QQBOT_AUTOSTART_VALUE，绝不碰用户真实的 SakiBot 那一项）
  'autostart',
  // ★ 跟群友要钱：真事故（「能收啊，你要发？」）—— 那是个**真 QQ 号**，收到就是真钱。
  //   纯单元、不起进程；【2】那组反例和【1】一样重要（拦错了＝她突然不说话，更难查）
  'money',
  // ★ 有人在骂她 → 好感度 -2（用户 2026-09-17：「不能每次和她说话都是加…
  //   而且减2，因为加上来很容易」）。纯单元；【2】那组"不许误判"比【1】更重要 ——
  //   误伤表现为"一个老群友被莫名冷落"，他自己根本不知道哪儿错了。
  'insult',
  // ★ 称呼统一（2026-09-28）：提示词里不再有字面量「<主人>」和旧叫法「服主」——
  //   称呼一律从 `identity.address.owner` 填进来。盯两件事：① 拼出来的提示词里
  //   **绝不能残留占位符**（模型会照着吐「<主人>」）；② 资料文件里的占位符真的被填了
  //   （不填的话 `whoIsBrief` 认不出主人，表现为"我明明写了他，她说不认识"）。
  'owner-term',
  // ★ 群内「安静」指令（用户 2026-09-28）：主人一句话让她闭嘴，直到有人说解除。
  //   纯单元、不起进程。盯两件事：① 整句相等才认（「小祥安静点」不能误触发）
  //   ② 作用域/权限/落盘 —— 漏了任一样，表现都是"她安静错了地方"或"安静了却还在说话"。
  'quiet',
  // ★ 私聊记忆（用户 2026-09-17）：「私聊也应该和群里一样记下性格和事件」
  //   +「私聊和群用一套资料库」。盯两件事：① 私聊归到**他共有的那个群**（不分裂成两份）
  //   ② 查不到共有群时**绝不能掉进共享的 group-memory.md**（那文件所有群都看得到）
  'dm-memory',
  // ★ 复读机：群里刷同一句话时她也跟一句 +1（用户 2026-09-17 要求）。
  //   重点盯两条：①「有人打断 → 链断，不会接着接」②「一条链只接一次」
  'repeat',
  'storyline',
  'life',
  'holiday',
  'quest',
  'outbox',
  // ⚠️ 2026-09-21 加：提示词快照 —— 做人设模块化时靠它证明"一个字都没改味"。
  //    ⚠️ 它**故意不隔离快照文件本身**（要用持久的那份 `state/__prompt-snapshot.json`），
  //       但脚本自己会设好别的隔离 env。
  'prompt-snapshot',
  // ⚠️ 2026-09-21 加：单例锁（重复实例会让说说/接话重复发、甚至"一条消息回两次"）
  'singleton',
  'napcat-recover',
  'punctuation',
  'e2e',
  'natural-teach',
  'sensitivity',
  // ⚠️ 2026-09-22 加：玩梗库（`memesFor()` 无触发词就返回空串，绝不硬凑 ——
  //    用例里一半是"这话不是梗、别去接"的反例）。纯单元，不起进程、不联网。
  'memes',
  // ⚠️ 2026-09-28 加：敏感词库「总规则常驻 + 词典撞库」。
  //    盯的是"没命中时提示词里**一个词条都没有**" —— 改之前是整份 68 行
  //    每条消息都带，而 knowledgeText 的 `chosen` 是全量文件、不看过滤，
  //    那里漏掉一个排除就会悄悄把词典漏回常驻。纯单元，不起进程、不联网。
  'sensitive-hit',
  // ⚠️ 2026-09-28 加：safety/ 拦截层（送进 LLM 之前）。
  //    盯的是"**一个字都不进提示词**"+"三个作用范围"+"私聊只在私聊生效"——
  //    它跟 `safety/sensitive` 那层（给模型看的建议，软层）是两回事：这个是代码开关。
  'safety',
  'sealdice',
  'dice-mode',
  // ⚠️ 2026-09-29 加：`run-all.js` **自己的参数解析**（`--only` / `--jobs` / `--list`）。
  //    盯两条最容易破的：①「`--only` 不能把 `--jobs` 的值当套件名吞掉」
  //    ②「套件名写错时**绝不**静默只跑认识的那几个」——
  //    这两个坑破起来都是**静默少跑几套 + 收尾仍写"全过"**，也就是假绿，比报错难查得多。
  //    ⚠️ 纯离线：只 import 纯函数 + 读源码文本断言，**零 spawn**（所以它能进这个名单）。
  'run-all-cli',
];

/** 已知的、用户明确说过不用修的项目（不算失败） */
const KNOWN_OK_FAILURES = ['上下文里有前面那句「我刚买了 OP」', '当前消息没有重复出现在上下文里'];

const args = process.argv.slice(2);
// ⚠️ 2026-09-29：参数解析抽到 `test/_args.js`（**纯函数**，由 `test/run-all-cli.js`
//    单测）。这里只拿结果 —— 规则和坑全在那儿钉着。
const { only, jobs, list, error: argError, warnings } = parseArgs(args, SUITES);
/**
 * 默认并发 = **2**。
 *
 * ⚠️ 2026-09-13 从 5 改成 2：并发 5 时有几套会**间歇性失败**，而且每次挂的项不一样
 *    （e2e 的「私聊消息得到回复」、sensitivity 的「小祥会冒泡」、cs 的在线名单…）。
 *    单独跑 / 并发 2 跑都全绿 —— 是假 MC、假模型、假 NapCat 一起抢 CPU 导致的超时，
 *    **不是代码问题**，但会让我每次都被假警报牵着走，浪费很多时间去查不存在的 bug。
 *
 *    实测：并发 2 → 12/12 全绿（154 秒）；并发 3 → sensitivity 偶发挂（125 秒）；
 *    并发 5 → 常有 1~2 套挂（100 秒）。回归**绿**比快 50 秒重要。
 *    想快点就自己传 `--jobs 5`，但要知道那点失败是噪音。
 */
const warn = (m) => console.log(`  ⚠️ ${m}`);
for (const w of warnings) warn(w);
if (argError) {
  console.log(`\n❌ ${argError}\n`);
  process.exit(2);
}
if (list) {
  console.log(`\n套件 ${SUITES.length} 个：\n${SUITES.map((n) => `  · ${n}`).join('\n')}\n`);
  process.exit(0);
}
/** 这次**真的要跑**的套件（没给 `--only` 就是全量） */
const RUN = only ? SUITES.filter((n) => only.includes(n)) : SUITES;

/**
 * ⚠️⚠️ **每个套件都发一份隔离的 state 路径**（2026-09-15 加，是个真 bug 的修法）。
 *
 * 踩到的：`test/behavior.js` **不设** `QQBOT_STORYLINE_FILE` / `QQBOT_AFFINITY_FILE`，
 * 而它 import 了 `bot.js`（bot.js 又 import 了 storyline / affinity / friend）——
 * 于是那几套的 `noteInteraction()` 直接**写进了真实的 `state/*.json`**。
 *
 * 证据（真实文件里翻出来的）：
 *   · `state/affinity.json` 里有个 `u30003`，note 是「回应了她」—— **30003 是测试用的 QQ 号**
 *   · `state/storyline.json` 里有 `路人说：那我现在去试试` —— **这句台词在 behavior.js 里**
 *
 * 后面的套件自己设了环境变量（覆盖这份默认值），所以这里给**默认值**就能一次盖住全部 33 套。
 * ⚠️ 加新套件时不用管 —— 不设就是这份隔离路径，不会再碰真实文件。
 */
function isolatedStateEnv(name) {
  const safe = String(name).replace(/[^\w.-]/g, '_');
  const p = (what) => `logs/__run-${safe}-${what}.json`;
  return {
    // ⚠️ 故意**不动 `QQBOT_CONFIG`** —— 指向一个不存在的文件会让 config.js 拿不到配置。
    //    哪个套件要自己的配置就自己设（它们本来就会设）。
    QQBOT_SPEND_FILE: p('spend'),
    QQBOT_SPEND_BASE: p('spendbase'),
    QQBOT_BALANCE_FILE: p('balance'),
    QQBOT_MONTHLY_FILE: p('monthly'),
    QQBOT_TIC_FILE: p('tic'),
    QQBOT_MEAL_FILE: p('meal'),
    // ⚠️ 2026-09-18：不加这条，`test/where.js` 就会去写真实的 `state/where.json`
    QQBOT_WHERE_FILE: p('where'),
    // ⚠️ 2026-09-18：定时提醒也会落盘（"重启不能忘"），同样要各写各的
    QQBOT_REMIND_FILE: p('remind'),
    // ⚠️ 2026-09-17：`recent.js` 也会落盘了（"重启不丢上下文"）——
    //    套件必须各写各的，否则会互相串、也会污染真实的 state/recent.json
    QQBOT_RECENT_FILE: p('recent'),
    QQBOT_QZONE_FILE: p('qzone'),
    QQBOT_DIGEST_FILE: p('digest'),
    QQBOT_AFFINITY_FILE: p('affinity'),
    // ⚠️ 2026-09-28 加：`state/quiet.json`（群内「安静」指令）也得隔离 ——
    //    不然一套件测「安静」就把真机器上的安静状态改了（服主下的令被冲掉）。
    QQBOT_QUIET_FILE: p('quiet'),
    QQBOT_OBSERVE_FILE: p('observe'),
    QQBOT_STORYLINE_FILE: p('story'),
    QQBOT_LIFE_FILE: p('life'),
    QQBOT_QUEST_FILE: p('quest'),
    QQBOT_FRIEND_FILE: p('friend'),
    QQBOT_OUTBOX_FILE: p('outbox'),
    // ⚠️ 2026-09-15 加：QQ号→名字（群名片/昵称）那张表。
    //    不隔离的话，测试跑起来会往**真实的** `state/names.json` 里塞假名字。
    QQBOT_NAMES_FILE: p('names'),
    // ⚠️ 2026-09-22 加：玩家在线记录（`state/player-sessions.json`）。
    //    不隔离的话，所有**构提示词**的套件都会读到真实的**那一份** ⇒
    //    提示词里那段【在线情况】**有没有**取决于"最近 12 小时有没有人在服务器上"
    //    ⇒ 快照类断言忽红忽绿（`prompt-snapshot` 实测就是这么红的）。
    //    而且它自己也会写这个文件，本来就该各写各的。
    QQBOT_SESSIONS_FILE: p('sessions'),
    // ⚠️ 2026-09-16 加：「喊妈妈」的计数与白祥模式状态（`state/mama.json`）。
    //    不隔离的话，测试里那些假群友只要说一句带"妈"的话，
    //    就会往**真实的**状态里记一笔（甚至把真群切进白祥模式）。
    QQBOT_MAMA_FILE: p('mama'),
    // ⚠️ 这条**一定不能漏**：漏了的话测试跑起来会往真实的
    //    `state/napcat-restart.request` 写条子 → 看门狗真去重启协议端。
    QQBOT_NAPCAT_REQ_FILE: p('napcatreq'),
    // ⚠️ 2026-09-21 加：单例锁（`state/bot.lock`）。**必须隔离** ——
    //    不隔离的话，`test/behavior.js` / `test/e2e.js` 里
    //    `spawn(node, [src/index.js])` 起的探针机器人会被"已经有真机器人在跑"挡在门外，
    //    那几个套件会整片失败（而且看着像代码坏了）。
    // ⚠️ 2026-09-21 加：文件名里带 **run-all 自己的 PID**。
    //    锁文件是"会跨运行残留"的东西（子进程被强杀时不走清理），
    //    用固定名字就会和上一轮留下的撞 —— 实测 `test/punctuation.js`
    //    因此**连续两轮回归都失败**（残留锁里的 PID 被复用，探活误判成"有实例在跑"）。
    QQBOT_LOCK_FILE: `logs/__run-${safe}-${process.pid}-lock.json`,
  };
}

/**
 * ⚠️⚠️ **每个套件也发一份隔离的 `knowledge/` 副本**（2026-09-15，用户要求「隔离」）。
 *
 * 踩到的：`isolatedStateEnv()` 只管 `state/*.json`，**knowledge/ 一直是共用的真实目录**。
 * 而至少有 **五个**套件会真的去写它（都是靠"先备份、跑完还原"）：
 *   `webui` / `learned-edit` / `teach` / `natural-teach` / `observe-compress`
 *
 * 证据（跑一轮回归后 `knowledge/_backup/` 里多出来的）：
 *   10:31:44 persona.md / 10:31:46 learned.md / 10:31:52 learned.md
 *   10:32:25 learned.md / 10:32:40 learned.md
 *
 * 核过哈希：**目前没坏**（内容和跑之前逐字节一致）。但**只要套件中途崩一次**，
 * 真实的 `persona.md`（6.8 万字，攒了很多天）就会留在测试内容上。
 *
 * 做法：给每个套件复制一份 `knowledge/*.md`，用 `QQBOT_KNOWLEDGE_DIR` 指过去
 * （见 `config.js` 的 `KNOWLEDGE_DIR`；那 9 个用到 knowledge 的模块都从那儿拿路径）。
 * ⚠️ 只复制**顶层的 .md** —— 加载器只读那些；`_backup/` 建个空目录就行，别把历史备份也拷一遍。
 */
function isolatedKnowledgeDir(name) {
  const safe = String(name).replace(/[^\w.-]/g, '_');
  const rel = `logs/__know-${safe}`;
  const abs = join(ROOT, rel);
  try {
    rmSync(abs, { recursive: true, force: true });
    mkdirSync(abs, { recursive: true });
    for (const f of readdirSync(join(ROOT, 'knowledge'))) {
      if (!f.toLowerCase().endsWith('.md')) continue;
      copyFileSync(join(ROOT, 'knowledge', f), join(abs, f));
    }
    // ⚠️ 2026-09-21：动画库在**子目录**里（`knowledge/anime/<库名>.md`）—— 也要复制。
    //    不复制的话套件里一份动画库都读不到，跟真实环境不一致（会掩盖或制造假红）。
    const adir = join(ROOT, 'knowledge', 'anime');
    if (existsSync(adir)) {
      mkdirSync(join(abs, 'anime'), { recursive: true });
      for (const f of readdirSync(adir)) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        copyFileSync(join(adir, f), join(abs, 'anime', f));
      }
    }
    // ⚠️ 2026-09-29：**敏感词库不在这儿了** —— 它搬进了 `safety/sensitive/`（④ 搬家）。
    //    原来这里会把 `knowledge/sensitive/` 一并复制（不复制的话 `sensitiveRules()`
    //    恒为空、总规则那几条断言**假红**：单跑时绿、进了 run-all 就红）。
    //    现在它由 `isolatedSafetyDir()` 给副本 —— 规则和词库**同一份来源**，
    //    不会出现"规则读副本、词库读原件"那种半套半份（最难查的那类）。
    mkdirSync(join(abs, '_backup'), { recursive: true });
    return rel;
  } catch (e) {
    console.warn(`  ⚠️ 给 ${name} 准备 knowledge 副本失败：${e.message}`);
    return null;
  }
}

/**
 * 给每个套件一份 `safety/` 副本（2026-09-29 加，和 `isolatedKnowledgeDir` 一个道理）。
 *
 * ## 为什么现在才需要
 * `knowledge/sensitive/` 搬进 `safety/sensitive/` 之后，**敏感词的数据也住在规则目录里**
 * 了。搬之前它在 `knowledge/` 下、有隔离；搬过来不给隔离 = **把隔离给撤了**，
 * 套件一旦动 sensitive（webui 的编辑/校验、sensitive-hit 的口径）就会写到**真红线**上，
 * 而且**没有任何报错** —— 下次真跑起来才发现规则变了（2026-09-15 真 persona 被写坏同型）。
 *
 * ⚠️ 根目录那三个 md（`global` / `group` / `injection`）**一起**复制：`safety.js` 只认
 *    **一个**目录，"规则读副本、词库读原件"这种半套半份比不隔离还难查。
 * ⚠️ 复制出来的字节和真文件**完全相同** ⇒ 隔离只影响"写"，不影响任何断言结果。
 * ⚠️ 失败不致命（返回 null 就不设 env、退回读真目录，只打个 ⚠️）——
 *    但**必须打出来**：悄悄退回去读真文件，就等于隔离静默失效。
 */
function isolatedSafetyDir(name) {
  const safe = String(name).replace(/[^\w.-]/g, '_');
  const rel = `logs/__safe-${safe}`;
  const abs = join(ROOT, rel);
  try {
    rmSync(abs, { recursive: true, force: true });
    mkdirSync(abs, { recursive: true });
    const src = join(ROOT, 'safety');
    if (existsSync(src)) {
      for (const f of readdirSync(src)) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        copyFileSync(join(src, f), join(abs, f));
      }
      const sdir = join(src, 'sensitive');
      if (existsSync(sdir)) {
        mkdirSync(join(abs, 'sensitive'), { recursive: true });
        for (const f of readdirSync(sdir)) {
          if (!f.toLowerCase().endsWith('.md')) continue;
          copyFileSync(join(sdir, f), join(abs, 'sensitive', f));
        }
      }
    }
    return rel;
  } catch (e) {
    console.warn(`  ⚠️ 给 ${name} 准备 safety 副本失败：${e.message}（退回读真目录 —— 隔离失效）`);
    return null;
  }
}

/**
 * 跑一个套件，返回 { name, sec, result, fails, timedOut }
 *
 * ⚠️ 用 stdout 管道收集 —— 实测这个沙箱允许（管道本身没问题）。
 *    每个套件的完整输出会写进 `logs/test-<name>.log`，失败时方便翻。
 */
function runSuite(name) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const know = isolatedKnowledgeDir(name);
    const safe = isolatedSafetyDir(name);
    const child = spawn(process.execPath, [join(HERE, `${name}.js`)], {
      cwd: ROOT,
      // ⚠️ 这些测试有的会调真实模型/真实网络，必须带上代理配置
      //    （跟 `_run-bot.bat` 里那套一致，别漏 NO_PROXY —— 漏了会砸掉本机请求）
      env: {
        ...process.env,
        // ⚠️⚠️ 2026-09-28：**给子进程钉死 TZ**，否则回归结果随**开发机时区**变。
        //
        //    实测踩到的：这台机器的时区从 Asia/Shanghai 变成了 Central Standard Time，
        //    `holiday` / `schedule` 两套立刻从绿变红（14 项 / 4 项），而代码一个字没动。
        //    原因：这两套用 `new Date('2026-02-17T00:00:00')`（**本地时间**）造日期，
        //    再由 `zonedParts()` 转到 `config.timeZone`（Asia/Tokyo）——
        //    本地时区一变，落到哪一天/哪个钟点就跟着变（农历、午休、客服室全错位）。
        //
        //    为什么是 Asia/Shanghai：项目一直是按东八区开发/部署的（config.yml `timeZone`）。
        //    钉死它 = 回归在任何机器上结果一致。⚠️ 只能**新增**在 `...process.env` 之后，
        //    别放前面 —— 外面同名变量会盖掉它（那正是这里要防的事）。
        TZ: 'Asia/Shanghai',
        // ⚠️ 隔离路径放在**后面**，保证它一定生效（别被外面同名变量盖掉）
        ...isolatedStateEnv(name),
        ...(know ? { QQBOT_KNOWLEDGE_DIR: know } : {}),
        // ⚠️ 2026-09-29：`safety/` 也给副本（词库数据搬进去了）。放在后面同理：
        //    保证一定生效，别被外面同名变量盖掉（盖掉 = 隔离静默失效）。
        ...(safe ? { QQBOT_SAFETY_DIR: safe } : {}),
        HTTP_PROXY: process.env.HTTP_PROXY ?? 'http://127.0.0.1:7890',
        HTTPS_PROXY: process.env.HTTPS_PROXY ?? 'http://127.0.0.1:7890',
        NODE_USE_ENV_PROXY: '1',
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      resolve({ name, sec: 0, result: `启动失败: ${e.message}`, fails: [], raw: out });
    });
    child.on('close', () => {
      const sec = Math.round((Date.now() - t0) / 100) / 10;
      // 取最后一条「结果: …」
      const m = [...out.matchAll(/结果:\s*(.+)/g)].pop();
      const result = m ? m[1].trim() : '（无结果行）';
      const fails = [...out.matchAll(/❌\s*(.+)/g)]
        .map((x) => x[1].trim())
        .filter((t) => !KNOWN_OK_FAILURES.some((k) => t.includes(k)));
      resolve({ name, sec, result, fails, raw: out });
    });
  });
}

/** 简单并发池：一次最多 jobs 个 */
async function pool(items, jobs, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

// ⚠️ 筛选模式必须在**开头**就说清"还有别的套件这次没跑" —— 收尾那行容易被滚没，
//    而"我明明只跑了两套却以为全绿"是最危险的一种误读。
console.log(
  only
    ? `\n并行跑回归（**筛选** ${RUN.length} 套，${jobs} 个并行；其余 ${SUITES.length - RUN.length} 套这次没跑）…\n`
    : `\n并行跑回归（${jobs} 个并行，共 ${RUN.length} 套）…\n`,
);
const t0 = Date.now();
const results = await pool(RUN, jobs, runSuite);
const total = Math.round((Date.now() - t0) / 100) / 10;

// 落盘每套的完整输出（失败时方便查）
const { writeFileSync } = await import('node:fs');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
for (const r of results) {
  try {
    writeFileSync(join(ROOT, 'logs', `test-${r.name}.log`), r.raw ?? '', 'utf8');
  } catch {}
}

for (const r of results) {
  const ok = r.result.includes('全部通过');
  const mark = ok ? '✅' : '❌';
  console.log(`  ${mark} ${r.name.padEnd(15)} ${String(r.sec).padStart(6)} 秒   ${r.result}`);
  for (const f of r.fails) console.log(`        ↳ ${f}`);
}

const failed = results.filter((r) => !r.result.includes('全部通过'));
console.log(`\n  总耗时 ${total} 秒（并行 ${jobs}）`);
// ⚠️ 两种收尾语都是**给人也给脚本看**的：
//    · 全量：`套件 68/68 全过`（关键词**唯一**，别改 —— 脚本就靠这行判绿）
//    · 筛选：明写"部分运行"，并且提醒 logs/ 里那些没跑的套件是**上一次的旧输出**
console.log(
  only
    ? `  ⚠️ 部分运行 ${results.length - failed.length}/${results.length} 套全过` +
      `（其余 ${SUITES.length - results.length} 套没跑，logs/ 里它们还是上一次的输出）`
    : `  套件 ${results.length - failed.length}/${results.length} 全过`,
);
if (failed.length) {
  console.log(`  未过：${failed.map((r) => r.name).join(', ')}`);
  console.log(`  完整输出在 logs/test-<套件名>.log`);
}
process.exit(failed.length ? 1 : 0);
