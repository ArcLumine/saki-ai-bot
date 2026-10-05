/**
 * 称呼统一（2026-09-28）的回归。
 *
 * ## 为什么盯这个
 *   以前提示词里写的是**字面量**「叫他「<主人>」」—— 尖括号**没有任何代码会替换**，
 *   它就是原样发给模型的，而尖括号对模型来说就是"这是占位符"的信号，
 *   **它真的会照着吐出来**（用户报过输出里出现「<主人>」）。
 *   同时「服主」这个词在提示词里到处是，两套叫法并排还会让她摇摆。
 *
 *   现在统一成：**称呼由 `identity.address.owner` 填进来**，别的地方只写 `<主人>`。
 *
 * ⚠️ 纯离线：只调纯函数 + 拼提示词，不发请求、不碰真 QQ。
 * 用法: node test/owner-term.js
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

const persona = await import('../src/persona.js');
const { fillOwnerTerms, callOwner, callOwnerAny, ownerAliases } = persona;
const OWNER = callOwner();

console.log('\n【1】称呼本身必须是"真名字"，不能是占位符');
{
  // ⚠️ 这条钉的是真踩过的坑：`personas/amiya/identity.json` 的 `address.owner`
  //    曾经就写成 `"<主人>"` —— 填完还是「<主人>」，**等于什么都没填**，
  //    而且它长得就像填好了，不测根本发现不了。
  check(!!OWNER, `identity 配了称呼（${OWNER}）`);
  check(
    !/<主人>|\{\{\s*owner\s*\}\}|【主人】/.test(OWNER),
    '称呼里不含占位符（不是自己填自己）',
    OWNER,
  );
  check(OWNER !== '服主', '不再用旧叫法「服主」当称呼', OWNER);
  check(!!callOwnerAny(), `正式叫法可填（${callOwnerAny()}）`);
  check(!/<主人>/.test(callOwnerAny()), '正式叫法里也不含占位符');
}

console.log('\n【2】占位符会被填掉（三种写法都认）');
{
  for (const [raw, want] of [
    ['叫他「<主人>」', `叫他「${OWNER}」`],
    ['叫他「{{owner}}」', `叫他「${OWNER}」`],
    ['叫他「【主人】」', `叫他「${OWNER}」`],
  ]) {
    check(fillOwnerTerms(raw) === want, `「${raw}」→「${want}」`);
  }
  const multi = '甲是<主人>，乙不是。';
  check(fillOwnerTerms(multi).split(OWNER).length - 1 === 1, '一句话里出现两次也全填');
  check(fillOwnerTerms('这段没有占位符') === '这段没有占位符', '没占位符 → 原样返回（零成本）');
  check(fillOwnerTerms('') === '' && fillOwnerTerms(null) === null, '空值不炸');
}

console.log('\n【3】★ 拼出来的提示词里绝不能出现「<主人>」');
{
  const knowledge = await import('../src/knowledge.js');
  const bal = await import('../src/balance.js');
  const prompts = [
    ['knowledgeText()', knowledge.knowledgeText()],
    ['balance.remindSystem()', bal.remindSystem(false)],
    ['balance.remindSystem(critical)', bal.remindSystem(true)],
    ['persona.ownerIdentityText()', persona.ownerIdentityText()],
  ];
  for (const [name, text] of prompts) {
    const s = String(text ?? '');
    check(!/<主人>|\{\{\s*owner\s*\}\}|【主人】/.test(s), `${name}：没有占位符残留`);
    check(!s.includes('服主'), `${name}：没有旧叫法「服主」`);
  }
  const kt = String(knowledge.knowledgeText() ?? '');
  check(kt.includes(OWNER), `knowledgeText 里真的出现了真称呼「${OWNER}」`);
}

console.log('\n【4】★ 资料文件里的占位符真的被填了（不然机器人认不出主人）');
{
  const knowledge = await import('../src/knowledge.js');
  // `whoIsBrief` 是拿「**名字**」去匹配用户说的字的 —— 不填就永远匹配不上，
  // 表现是"我明明在 owner.md 里写了他，她说不认识"。
  const brief = knowledge.whoIsBrief(`还记得${OWNER}吗`, '<跑团群>');
  check(!!brief, `whoIsBrief 能认出「${OWNER}」（档案里的 **名字** 被填过了）`);
  check(!brief.includes('<主人>'), '返回的档案里没有占位符残留');
  check(!/服主/.test(brief), '返回的档案里没有旧叫法');
}

console.log('\n【5】身份段（真正发给模型的那块）里也不能有占位符/旧叫法');
{
  const { Bot } = await import('../src/bot.js');
  const bot = Object.create(Bot.prototype); // 只借方法，不连协议端
  const ev = { message_type: 'group', user_id: '1', sender: { card: OWNER, nickname: OWNER, role: 'owner' } };
  const blocks = [
    ['attitudeFor(owner)', bot.attitudeFor('owner', ev)],
    ['attitudeFor(staff)', bot.attitudeFor('staff', { ...ev, sender: { ...ev.sender, role: 'admin' } })],
    ['attitudeFor(member)', bot.attitudeFor('member', { ...ev, sender: { ...ev.sender, role: 'member' } })],
    ['behaviorHints', bot.behaviorHints({ ...ev, sender: { ...ev.sender, role: 'member' } }, '喂')],
    ['relationshipText()', bot.relationshipText()],
  ];
  for (const [name, text] of blocks) {
    const s = String(text ?? '');
    check(!/<主人>|\{\{\s*owner\s*\}\}|【主人】/.test(s), `${name}：没有占位符残留`);
    check(!s.includes('服主'), `${name}：没有旧叫法「服主」`);
  }
  const ownerBlock = String(blocks[0][1] ?? '');
  check(ownerBlock.includes(OWNER), `身份段里出现了真称呼「${OWNER}」`);
  check(/任何场合都叫/.test(ownerBlock), '身份段明确"任何场合都叫同一个名字"');
}

console.log('\n【6】昵称只用于"认出他是谁"，不作为输出称呼');
{
  const al = ownerAliases();
  check(Array.isArray(al), `ownerAliases 是数组（${al.length} 个）`);
  check(!al.includes(OWNER), '名单里不重复放"称呼自己"那一个', al.join('、'));
  const t = persona.ownerIdentityText();
  if (al.length) check(t.includes(al[0]), '身份段里带上了昵称名单（用来识别）');
  check(t.includes(`一律叫「${OWNER}」`), '身份段里写死了唯一输出称呼');
  // ⚠️ 2026-09-28：昵称名单现在住在 **config**，不是人设包 ——
  //    「别人怎么叫他」是共用事实（跟 ownerQQ 一样换人设不该动），
  //    人设包的 `address.*` 只管"她怎么称呼别人"。这里钉住，免得哪天又被塞回 identity.json。
  const { config } = await import('../src/config.js');
  check(
    Array.isArray(config.ownerAliases) && config.ownerAliases.length > 0,
    'config.ownerAliases 配了（单一事实源）',
    JSON.stringify(config.ownerAliases ?? null),
  );
  const ident = JSON.parse(readFileSync(join(ROOT, 'personas', 'saki', 'identity.json'), 'utf8'));
  check(
    ident.address?.ownerAliases === undefined,
    '人设包里已经没有 address.ownerAliases（不会变成两个事实源）',
  );
}

console.log('\n【7】源头不再硬编码旧叫法（防回潮）');
{
  // 只扫**会进提示词的文件**；注释和文档不在此列（它们不发给模型）
  const files = [
    'src/knowledge.js',
    'src/learned.js',
    'src/extract.js',
    'src/attribution-guard.js',
    'personas/saki/persona.md',
    'example/owner.example.md',
    'example/global.example.md',
  ];
  let bad = [];
  for (const f of files) {
    const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!l.includes('服主')) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return; // 注释里允许（历史原因说明）
      if (l.includes('腐竹')) return; // 输入侧兼容词（见 knowledge.js 里那段说明）
      bad.push(`${f}:${i + 1}`);
    });
  }
  check(bad.length === 0, '提示词源文件里没有硬编码的「服主」', bad.join(' '));
}

console.log('\n【8】★ 模型出口**真的**收口了（起个假 LLM 服务，看发出去的请求体）');
{
  // 这一条盯的是「兜底放在哪一层」：光检查拼提示词的函数不够 ——
  // 出口有 6 个（streamChat / quickAck / phrase / phraseMoney / ping / extract），
  // 填值只要没放在**所有出口都过**的那一层，就一定有一条路会漏。
  // 所以这里不看函数，直接看**发到网络上的那个 body**。
  const { createServer } = await import('node:http');
  const { config } = await import('../src/config.js');
  const llm = await import('../src/llm.js');
  let got = '';
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got = b;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const old = { baseURL: config.llm.baseURL, adaptiveRateLimit: config.llm.adaptiveRateLimit };
  config.llm.baseURL = `http://127.0.0.1:${port}/v1`;
  config.llm.adaptiveRateLimit = false; // 别进限速排队那套，测试要的是"立刻发出去"
  try {
    await llm.llmFetch(`${config.llm.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [
          { role: 'system', content: `叫他「<主人>」` },
          { role: 'user', content: '<主人> 在吗' },
          { role: 'user', content: '这段没有占位符' },
        ],
      }),
    });
    const j = JSON.parse(got || '{}');
    const texts = (j.messages ?? []).map((m) => String(m.content ?? ''));
    check(!!got, '假 LLM 服务确实收到了请求');
    check(texts.length === 3, '三条消息一条没少（没被误删）');
    check(
      texts.every((t) => !/<\u4e3b\u4eba>|\{\{\s*owner\s*\}\}|\u3010\u4e3b\u4eba\u3011/.test(t)),
      '★ 发出去的请求体里没有任何占位符残留',
      texts.join(' | ').slice(0, 80),
    );
    check(texts[0].includes(OWNER), `system 提示词里已经是真称呼「${OWNER}」`);
    check(texts[2] === '这段没有占位符', '没占位符的那条一个字没动');
  } finally {
    Object.assign(config.llm, old);
    srv.close();
  }
}

console.log('\n【9】★ 别人用别称提到他时，能认出来（2026-09-28 用户要求）');
{
  // ⚠️ 用户原话：「这是她用来判定**别人对主人的称呼**的」。
  //    也就是：路人说「粥粥上次说的那个…」时，要能认出那是在说他。
  //
  // ⚠️⚠️ 下面**一个具体名字都不写死** —— 全部从 `config.ownerAliases` 现读。
  //    写死的话，用户改了名单，测试就会"钉死一个过时的名字"，
  //    然后逼着代码里也留着那个旧词（这正是要避免的）。
  const al = ownerAliases();
  const cn = al.find((a) => /[^\x20-\x7e]/.test(a)); // 含中文的
  const en = al.find((a) => /^[\x20-\x7e]+$/.test(a)); // 纯 ASCII 的
  check(!!cn, '名单里至少有一个中文别名（拿它验中文匹配）', al.join('、'));
  check(!!en, '名单里至少有一个英文别名（拿它验词边界）', al.join('、'));

  if (cn) {
    check(persona.ownerMentionHit(`${cn}上次说的那个皮肤`), `中文别名：说「${cn}…」认得出来`);
    check(!persona.ownerMentionHit('今天服务器怎么炸了'), '无关的话不会误命中');
  }
  if (en) {
    check(persona.ownerMentionHit(`${en} 在吗`), `英文别名：说「${en}」认得出来`);
    check(persona.ownerMentionHit(en.toUpperCase()), `英文别名：${en.toUpperCase()}（大写）也认得出来`);
    // ⚠️⚠️ 这两条是本组**最关键**的断言：`ark` 用 includes 的话，
    //    'shark' / 'market' 全都会"命中"（在聊鲨鱼、市场），而真的 ark 反而认不出。
    check(!persona.ownerMentionHit(`sh${en}`), `英文别名：sh${en}（另一个词）不命中`);
    check(!persona.ownerMentionHit(`market${en}`), `英文别名：market${en}（粘着的）不命中`);
  }
}

console.log('\n【10】★ 提示词里那段的边界（不加不该加的东西）');
{
  const { config } = await import('../src/config.js');
  const al = ownerAliases();
  const hint = persona.ownerMentionHint();
  check(!!hint, '配了别名时，这段提示词存在');
  check(!/<主人>|\{\{\s*owner\s*\}\}/.test(hint), '那段里没有占位符（称呼是填好的）');
  for (const a of al) check(hint.includes(a), `名单里的「${a}」都出现在那段里（现读，不是写死的）`);
  // ⚠️⚠️ 两条**不加**的断言 —— 这是用户明确要求的边界：
  check(!/relationship\.md/.test(hint), '★ 不包含 relationship.md（那是"她怎么跟他说话"，泄给路人就糟了）');
  check(!/owner\.md/.test(hint), '★ 不包含 owner.md（主人的私人资料，只在主人在场时读）');
  check(/不是他/.test(hint) && /别替他说/.test(hint), '★ 明确"在场的人不是他"+"别替他表态"');

  // ⚠️ 名单为空 → 整段不生成（不留空壳）
  const saved = config.ownerAliases;
  config.ownerAliases = [];
  check(persona.ownerMentionHint() === '', '别名名单为空 → 整段不生成');
  check(!persona.ownerMentionHit('随便聊聊'), '别名名单为空 → 命中判定恒 false');
  config.ownerAliases = saved;
  check(persona.ownerMentionHint() !== '', '恢复名单后那段又回来了');
}

console.log('\n【11】★★ 端到端：走 buildSystemPrompt 看那段到底出没出现');
{
  const { Bot } = await import('../src/bot.js');
  const { config } = await import('../src/config.js');
  const bot = Object.create(Bot.prototype); // 只借方法，不连协议端
  const al = ownerAliases();
  const cn = al.find((a) => /[^\x20-\x7e]/.test(a)) ?? al[0];
  const MARK = '这些称呼指的是';

  const evOf = (uid) => ({
    message_type: 'group',
    user_id: uid,
    group_id: '<跑团群>',
    sender: { card: '某人', nickname: '某人', role: 'member' },
  });
  const p = (uid, text) => String(bot.buildSystemPrompt('', evOf(uid), null, text) ?? '');

  // ① 路人提到别名 → 应该有
  const byStranger = p('99999999', `${cn}上次说的那个皮肤怎么弄`);
  check(byStranger.includes(MARK), '★ 路人用别称提到他 → 提示词里认出来了');

  // ② 路人没提 → 不该有（别成天挂着这段，占提示词还干扰）
  check(
    !p('99999999', '今天服务器怎么炸了').includes(MARK),
    '★ 路人没提他 → 不注入那段',
  );

  // ③ ⚠️⚠️ 主人本人说话时**绝对不能**有那段 ——
  //    他在场，插入"现在跟你说话的人不是他"是纯胡说，还会和 owner 身份段打架。
  const byOwner = p(String(config.ownerQQ), `${cn}在吗`);
  check(!byOwner.includes(MARK), '★★ 主人本人说话（哪怕用别称）→ 不注入那段');
  check(byOwner.includes('本人'), '★ 主人本人的完整身份段照常注入');

  // ④ 提了别名也不能顺带多带任何资料
  check(!/experien/.test(byStranger), '★ 路人提他 → owner.md 的私人资料没进来');
  // ⚠️⚠️ 原来这里断言"两份提示词除了那一小段一模一样"（差 <40 字）—— **行不通**：
  //    `buildSystemPrompt` 里有实时数据（群观察、"已经说过的话"防复读那类），
  //    两次调用的间隔里那些会变，于是差值忽大忽小（实测 0 / 40 / 146 都出现过），
  //    变成一个**随机假红**的断言 —— 比没有断言更糟。
  //    ⇒ 改成真正要证明的那件事：**别名的作用仅限于认人**。
  //    判据取"owner.md 那份资料的独有内容"（`owner.md` 只有主人在场时才会读，
  //    它的标题是稳定的，不受实时数据影响）。
  const OWNER_FILE = readFileSync(join(ROOT, 'knowledge', 'owner.md'), 'utf8');
  const uniq = OWNER_FILE
    .split('\n')
    .map((l) => l.replace(/<[^>]+>/g, '').trim())
    // 取一条够长、且不含标题/分隔符的行 —— 那是"资料内容"而不是"格式"
    .find((l) => l.length > 24 && !/^[#>\-*|]/.test(l) && !/请|注意|⚠/.test(l));
  if (uniq) {
    check(!byStranger.includes(uniq), '★ 路人提他 → owner.md 的资料内容没进来', uniq.slice(0, 30));
  } else {
    check(true, '★ （owner.md 里没抽到可用的特征行，跳过内容比对）');
  }
}

/** 从提示词里把那一小段原样抠出来（比对时要用） */
function hintBlock(s) {
  const i = s.indexOf('## ⚠️ 有人用');
  if (i === -1) return '';
  const j = s.indexOf('\n## ', i + 1);
  return j === -1 ? s.slice(i) : s.slice(i, j);
}

console.log('\n【12】★★ 扫所有提示词出口：谁都不许有占位符残留');
{
  // ⚠️⚠️ 这组是 2026-09-28 **补**的 —— 因为下面三处**真的漏了**，
  // 而且是查 prompt-snapshot 基线时才发现的：
  //   · src/machine.js   「（背景：<主人> 之前说过要给你换个设备…」
  //   · src/affinity.js  「**它管不到 <主人>** —— 你对 <主人> 的态度…」
  //   · src/bot.js       「例如 `@<主人> 好了`」「人家 @ 的是 <主人>」
  // 三处都是**各自拼的字符串、从别处直接 push 进提示词**，绕开了 `fillOwnerTerms`。
  // 而本文件原来只验 knowledgeText / remindSystem / attitudeFor 这几个"主要出口"
  // ⇒ 漏网。**只验主要出口是不够的** —— 出口会增补，靠列举迟早再漏。
  // ⇒ 最外层那个（完整系统提示词）才是真正的闸：所有块最终都会拼进去。
  const { Bot } = await import('../src/bot.js');
  const { promptLine } = await import('../src/affinity.js');
  const bot = Object.create(Bot.prototype);
  const OWNER = callOwner();
  const BAD = /<主人>|\{\{\s*owner\s*\}\}|【主人】/;
  const ev = {
    message_type: 'group',
    user_id: '99999999',
    group_id: '<跑团群>',
    sender: { card: '路人甲', nickname: '路人甲', role: 'member' },
  };

  // ① 好感度那段（affinity.promptLine）—— 就是漏网的三处之一
  const line = promptLine('99999999', { name: '路人甲', groupId: '<跑团群>' });
  check(!!line, '（前提）好感度那段真的生成了内容', `${line.length} 字`);
  check(!BAD.test(line), '★ affinity.promptLine 那一段没有占位符');
  check(line.includes(OWNER), '★ 而且用的是真称呼');
  // ⚠️⚠️ 加这组断言的当天就**当场又抓到第四处**（src/spend.js 的账本那段）。
  //    这就是"穷举所有出口"本身的价值：修完已知的三处之后还剩一处 ——
  //    只靠人工翻代码是翻不干净的。

  // ② 完整系统提示词 —— 最外层的闸，所有块最终都拼进来
  const sys = String(bot.buildSystemPrompt('', ev, null, '随便聊聊') ?? '');
  check(sys.length > 1000, `（前提）系统提示词真的生成了（${sys.length} 字）`);
  check(!BAD.test(sys), '★★ 完整系统提示词里一个占位符都没有');
  check(!/服主/.test(sys), '★★ 也没有旧叫法「服主」');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
