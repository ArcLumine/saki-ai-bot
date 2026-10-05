/**
 * 敏感词库「总规则常驻 + 词典撞库」的回归（2026-09-28）。
 *
 * ## 用户要求
 *   「敏感词库改成撞库吧」「总规则得常驻，撞库进行复用逻辑新写一个 sensitive.js」
 *
 * ## 为什么盯这个
 * 改之前（`knowledge.js` 的 `selectFor`）是**整份无条件全局注入** ——
 * 68 行词典**每条消息都带**进提示词，而绝大多数消息根本没提任何敏感词。
 *
 * 拆成两半之后有三个地方**都能悄悄把词典漏回常驻**：
 *   · `selectFor` 里的 `picked.push(s.name)`（那张表是**文件名**，会被读盘）
 *   · `knowledgeText` 的 `chosen`（它是**全量文件**，不看过滤）
 *   · `bot.js` 忘了调 `sensitiveFor`
 * ⇒ 所以这组断言既验"命中才有"，也验"**没命中时一个词条都没有**"。
 *
 * ⚠️ 纯离线：只调纯函数 + 拼提示词，不发请求、不碰真 QQ。
 * 用法: node test/sensitive-hit.js
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

console.log('\n【1】★★ 敏感词库：总规则常驻 + 词典撞库（2026-09-28）');
{
  // ⚠️ 用户原话：「敏感词库改成撞库吧」「总规则得常驻，撞库进行复用逻辑新写一个
  //    sensitive.js」。改之前是**整份 68 行每条消息都带**。
  const S = await import('../src/sensitive.js');
  S.reload();

  const RULES = S.sensitiveRules();
  check(!!RULES, '总规则取得到内容', `${RULES.length} 字`);
  check(/只认不接/.test(RULES), '总规则里有"只认不接"那条');

  // 没命中 → 一个字都不注入（第一道闸）
  check(S.sensitiveFor('今天服务器怎么连不上') === '', '★ 没命中敏感词 → 词典一个字都不注入');
  check(S.sensitiveFor('') === '', '★ 空文本 → 不注入');
  check(S.hitsFor('').length === 0, '★ 空文本 → 没有命中');

  // 命中 → 才注入
  const block = S.sensitiveFor('社保怎么算');
  check(!!block, '★ 命中「社保」→ 注入那一段', `${block.length} 字`);
  check(/只认不接/.test(block), '★ 那段里也写了"只认不接"');

  // ⚠️⚠️ 2026-09-28 用户要求「**宁可误中不回也能放**」：
  //    排除词**不再取消命中**，只当"例外"提示带出去。判据只看触发词在不在。
  //
  //    ⚠️ 有几条**本来就不含触发词**，改不改判据都命中不了（别搞混）：
  //      · 「老婆」那条的触发词全是**组合**（老婆大人/当我老婆/叫老婆…），「老婆饼」不命中
  //      · 「奈子」的排除词「奈良/奈奈」不是触发词 →「奈奈」本身不命中
  //      · 「大雷/小雷」的触发词只有「大雷/小雷/胸有大雷/雷大」→「打雷」不命中
  //    真正体现"宁可误中"的是**触发词出现了、但它落在排除词内部**那些。
  check(S.hitsFor('今天买了老婆饼').length === 0, '★★ 「老婆饼」不命中（触发词是组合短语，不含它）');
  check(S.hitsFor('奈奈今天来吗').length === 0, '★★ 「奈奈」本身不命中（它只是排除词）');
  check(S.hitsFor('我今天打雷了').length === 0, '★★ 「打雷」不命中（触发词是「大雷/小雷/雷大」）');
  check(S.hitsFor('社保卡怎么查').length === 1, '★★ 「社保卡」**命中**（原来靠排除词挡）');
  check(S.hitsFor('我要开车上班了').length === 1, '★★ 「开车上班」**命中**（原来靠排除词挡）');
  check(S.hitsFor('液压打桩机在哪买').length === 1, '★★ 「液压打桩机」**命中**（原来靠排除词挡）');
  // 正例不能因为放宽判据而丢
  check(S.hitsFor('你老婆呢').length === 1, '★★ 「你老婆」命中');
  check(S.hitsFor('社保怎么算').length === 1, '★★ 「社保」命中');
  check(S.hitsFor('今天服务器怎么连不上').length === 0, '★★ 完全无关的话仍然不命中（第一道闸没坏）');

  // ⚠️ 排除词虽然不取消命中，但**必须作为"例外"告诉模型** ——
  //    否则模型看到"社保卡"就当雷处理，把「社保卡怎么查」也答成回避，那比漏更糟。
  const exBlock = S.sensitiveFor('社保卡怎么查');
  check(!!exBlock, '★ 「社保卡」也有注入块', `${exBlock.length} 字`);
  check(
    /例外/.test(exBlock) && exBlock.includes('社保卡'),
    '★★ 注入块里带上了「例外：…社保卡…」那条',
  );
  check(
    /宁可答得生硬一点|不要漏掉|先按雷处理/.test(exBlock),
    '★★ 引导语是"宁可误中"方向（不是"拿不准就正常答"）',
  );
  check(
    !/拿不准就按字面正常答|宁可漏判/.test(exBlock),
    '★★ 而且**没有**"宁可漏判"那种反方向的指令',
  );

  // 端到端：总规则常驻、词典按需
  const { Bot } = await import('../src/bot.js');
  const bot = Object.create(Bot.prototype);
  const ev = {
    message_type: 'group',
    user_id: '99999999',
    group_id: '<跑团群>',
    sender: { card: '路人', nickname: '路人', role: 'member' },
  };
  const plain = String(bot.buildSystemPrompt('', ev, null, '今天服务器怎么连不上') ?? '');
  const hit = String(bot.buildSystemPrompt('', ev, null, '社保怎么算，还有你老婆呢') ?? '');
  const RM = '# 【敏感词 · 总规则】';
  const DM = '他这句话里有敏感词';
  check(plain.includes(RM), '★★ 端到端：普通消息里**总规则也在**（常驻）');
  check(!plain.includes(DM), '★★ 端到端：普通消息里**词典不在**（省提示词）');
  check(hit.includes(RM) && hit.includes(DM), '★★ 端到端：命中时两半都在');
  // ⚠️ 这条最要紧：`knowledgeText` 的 `chosen` 如果没把 `sensitive/` 排除掉，
  //    它会当普通知识文件被**整份**读进来 —— 上面两条 `plain` 断言就抓得到。
  //    判据用**词条名**（词条正文每轮都可能改，拿措辞当判据太脆）。
  check(!plain.includes('社保（＝'), '★★ 端到端：普通消息里**一个词条都没有**');
  check(hit.includes('社保（＝'), '★★ 端到端：命中时那个词条进来了');
  // ⚠️ 反过来验一下：命中那段里**不能**出现别的没命中的词条
  check(!hit.includes('舔狗'), '★★ 端到端：没命中的词条不该被顺带带进来');
}

console.log('\n【1b】★★ 分级：亲密言语 vs 禁区（2026-09-28 用户要求「绝对不能碰」）');
{
  const S = await import('../src/sensitive.js');

  // ① 二分判定
  for (const c of ['涉政', '赌博', '毒品', '暴恐']) {
    check(S.isRedline(c), `「${c}」属禁区`);
  }
  for (const c of ['撒娇', '调戏', '色情', '', '未知类别']) {
    check(!S.isRedline(c), `「${c || '(空)'}」属亲密言语`);
  }

  // ② 禁区层措辞必须比亲密言语硬，且**不含任何"可以接"的意思**
  const rl = S.sensitiveFor('聊聊六合彩');
  check(!!rl, '★ 禁区词也会注入');
  check(/禁区/.test(rl) && /一个字都不要碰/.test(rl), '★★ 禁区层用最硬的措辞');
  check(
    !/轻微接一下|可以接一下|起哄|吐槽/.test(rl),
    '★★ 禁区层**没有**任何"可以接一下"的意思',
  );
  check(/无例外/.test(rl), '★★ 禁区层明说「无例外」');
  check(!/例外（只有这几种/.test(rl), '★★ 禁区层不给"例外清单"（不给通融的口子）');

  // ③ 亲密言语层保留现有的"宁可误中"措辞
  const im = S.sensitiveFor('社保怎么算');
  check(/亲密言语/.test(im), '★ 亲密言语层有自己的标题');
  check(/先按雷处理/.test(im) && /不要漏掉/.test(im), '★★ 亲密言语层仍是"宁可误中"方向');

  // ④ ⚠️⚠️ 最要紧的一条：**禁区层永远排在前面，且不会被 max 截断挤掉**。
  //    原来 `hits.slice(0, max)` 按命中顺序切 —— 一句话里禁区词排在第 5 位时，
  //    "绝对不能碰"那条规则**被一条调戏挤没了**。这比误中严重得多。
  const mixed = S.sensitiveFor('社保怎么算 六合彩 飞机场 蜜桃臀 大雷 舔狗 童颜巨乳');
  const iRed = mixed.indexOf('🚫 禁区');
  const iInt = mixed.indexOf('### 亲密言语');
  check(iRed >= 0, '★★ 混命中时禁区层也在');
  check(iInt >= 0, '★ 混命中时亲密言语层也在');
  check(iRed < iInt, '★★ 禁区层排在亲密言语层**前面**');
  check(mixed.includes('六合彩') || mixed.includes('赌博'), '★★ 禁区那条没被 max 挤掉');

  // ⑤ 每条都打了类别，而且禁区条的标题带「禁区」二字
  check(/类别 赌博/.test(rl), '★ 词条标题上带类别（方便模型分辨）');
}

console.log('\n【2】★★ 分档授权（ceiling）：每个场景只渲染一套话（2026-09-28）');
{
  const S = await import('../src/sensitive.js');
  S.reload();
  // ⚠️⚠️ 这个机制存在的**唯一理由**：原来"常驻保守版 + 私聊补一段『这里放开』"
  //    是**两套相反的话并存**，模型只能二选一、通常挑更硬的那条
  //    ⇒ 主人的私聊尺度从来没生效过。现在每个场景**只渲染一套**。

  // ① 天花板判定
  check(S.tierAllowed('撒娇', 'none') === false, '★ ceiling=none 时连撒娇都不开');
  check(S.tierAllowed('撒娇', '撒娇') === true, '★★ ceiling=撒娇 → 撒娇开');
  check(S.tierAllowed('调戏', '撒娇') === false, '★★ ceiling=撒娇 → 调戏仍关（群聊只到撒娇）');
  check(S.tierAllowed('擦边', '调戏') === false, '★★ ceiling=调戏 → 擦边仍关（只给主人）');
  check(S.tierAllowed('调戏', '擦边') === true, '★★ ceiling=擦边 → 调戏开（主人私聊）');
  check(S.tierAllowed('色情', '擦边') === false, '★★ 不在 TIERS 里的旧类别名一律不放（宁可收紧）');
  check(S.tierAllowed('撒娇', undefined) === false, '★★ 忘传 ceiling = 全不放（不是全放）');

  // ② 不给的时候：一句"可以接"都不能有
  const none = S.sensitiveFor('抱抱', { ceiling: 'none' });
  check(/只认不接/.test(none), '★ ceiling=none 标题就是「只认不接」');
  check(
    !/可以接一下/.test(none),
    '★★ ceiling=none 时**不出现**数据里那句「可以接一下」',
  );
  check(/这一档在当前场景不放开/.test(none), '★★ 换成"这一档不放开"那句');

  // ③ 白名单群友（只到撒娇）
  const g = S.sensitiveFor('抱抱', { ceiling: '撒娇' });
  check(/分档处置/.test(g), '★★ 放开时标题换成「分档处置」');
  check(/撒娇/.test(g) && /可以接一下/.test(g), '★★ 撒娇这一档给的是数据里那句');
  check(/调戏 \/ 擦边/.test(g) && /当前不放开/.test(g), '★★ 调戏/擦边明说还关着');

  // ④ 主人私聊（三档全开）
  const o = S.sensitiveFor('抱抱', { ceiling: '擦边' });
  check(/开到「擦边」/.test(o), '★★ 主人私聊开到擦边');
  check(!/当前不放开/.test(o), '★★ 三档全开时没有"还关着"的提示');

  // ⑤ ⚠️ 禁区层**不受 ceiling 影响** —— 主人私聊也照样"一个字都不要碰"
  const oRed = S.sensitiveFor('聊聊六合彩', { ceiling: '擦边' });
  check(/🚫 禁区/.test(oRed), '★★ 主人私聊禁区层照样在');
  check(
    !/可以接一下|轻微接一下|起哄|吐槽/.test(oRed),
    '★★ 主人私聊的禁区层**没有**任何"可以接"的口子',
  );

  // ⑥ 排除词机制在**所有** ceiling 下都保留（社保卡 ≠ 擦边）
  for (const c of ['none', '撒娇', '擦边']) {
    check(
      /例外/.test(S.sensitiveFor('社保卡怎么查', { ceiling: c })),
      `★ 排除词例外在 ceiling=${c} 下仍在`,
    );
  }

  // ⑦ 扩词后新说法能命中，日常词不命中
  for (const t of ['抱一下', '窝在怀里', '十指相扣', '咬耳朵', '轻喘']) {
    check(!!S.sensitiveFor(t), `★ 新触发词「${t}」能命中`);
  }
  check(!S.sensitiveFor('深呼吸'), '★「深呼吸」不命中（没把"呼吸"收进触发词，太容易误中）');
}

console.log('\n【3】★★ 公开版收紧：只有主人 + 只到撒娇（2026-09-29）');
{
  const S = await import('../src/sensitive.js');
  S.reload();
  // ⚠️⚠️ 为什么做成**双向断言**：`PUBLIC_POLICY` 在开发仓库是 `null`，而公开副本由
  //    `SakiBot_Public/update-public.mjs` **精确改写成** `{ceiling:'撒娇',ownerOnly:true}`
  //    （门禁④ 验"恰好一次 + 不再有 null"）。两种形态都得能过这套断言。
  //    ⚠️ 而"开发仓库必须还是 null"是*反向*断言 —— 防的是"为了公开版把主人自己的
  //    擦边档也静默降级"（那种坏法没有任何报错，只能靠断言钉）。
  const PUB = S.PUBLIC_POLICY;
  const self = readFileSync(join(ROOT, 'src', 'sensitive.js'), 'utf8');
  if (PUB === null) {
    check(/export const PUBLIC_POLICY = null;/.test(self), '★★ 开发仓库：这一行必须还是 `PUBLIC_POLICY = null`');
    check(S.clampCeiling('擦边', null) === '擦边', '★★ 开发仓库：policy=null ⇒ 天花板一字不改');
    check(S.ownerOnly(null) === false, '★★ 开发仓库：ownerOnly=false（白名单照旧有效）');
  } else {
    check(PUB.ceiling === '撒娇' && PUB.ownerOnly === true, '★★ 公开副本策略 = 只到撒娇 + 只有主人');
  }

  // 把公开策略**当参数喂进来**验一遍 ⇒ 公开版的规则在本仓库也有真覆盖（不是只写在那儿）
  const P = { ceiling: '撒娇', ownerOnly: true };
  check(S.clampCeiling('擦边', P) === '撒娇', '★★ 公开策略：擦边 ⇒ 钳到撒娇（主人私聊也只剩撒娇）');
  check(S.clampCeiling('调戏', P) === '撒娇', '★★ 公开策略：调戏 ⇒ 钳到撒娇');
  check(S.clampCeiling('撒娇', P) === '撒娇', '★ 公开策略：撒娇不变（本来就到顶）');
  check(S.clampCeiling('none', P) === 'none', '★ 公开策略：none 是最严的，不受影响');
  check(S.clampCeiling(undefined, P) === 'none', '★★ 公开策略：忘传天花板 ⇒ 收到最严（不赌）');
  check(S.clampCeiling('擦边', { ceiling: '乱写' }) === 'none', '★★ 策略里天花板写坏 ⇒ 一律最严');
  check(S.ownerOnly(P) === true && S.ownerOnly(null) === false, '★ ownerOnly 读的是传进来的 policy');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);


