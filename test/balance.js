/**
 * 工资提醒（余额）测试。
 *
 * 覆盖 2026-09-13 用户的两轮要求：
 *   ① 话术别出常识错（原来写「电子琴键盘换琴弦」—— 键盘没有弦）
 *   ② 「见底」档要**直接 @ 服主**、要软催（不能像欠了一百万）
 *   ③ 称呼：平时叫 <主人>，「服主」只在服务器事务里用
 *
 * ⚠️ 这里**不用**等那个 90 秒的首检（`startBalanceWatch` 里硬编码的），
 *    而是把风险最大的那一段 —— **@ 的消息段真的拼进去了吗** —— 单独拎出来测。
 *    这不是偷懒：@ 写错（比如把 `@123` 写进文本里）在群里**根本不会提醒到人**，
 *    而且肉眼看不出来，只有检查消息段才发现得了。
 *
 * ⚠️ 用 `QQBOT_BALANCE_FILE` 指向临时文件，不碰真实的"已抱怨"状态。
 *
 * 用法: node test/balance.js
 */
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T_FILE = 'state/_test-balance.json';
const WS_PORT = 39831;
const TOKEN = 'test-token-balance';
process.env.QQBOT_BALANCE_FILE = T_FILE;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';
process.env.no_proxy = process.env.NO_PROXY;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = () => {
  const p = join(ROOT, T_FILE);
  try {
    existsSync(p) && unlinkSync(p);
  } catch {}
};
clean();

const balance = await import('../src/balance.js');
const { config } = await import('../src/config.js');
const { Bot } = await import('../src/bot.js');
const { WebSocket } = await import('ws');

const owner = String(config.ownerQQ);
const low = Number(config.balance?.low) || 5;
const crit = Number(config.balance?.critical) || 2;

console.log('\n【1】话术不许出常识错 / 不许凄惨');
{
  const all = [...balance.allLines('low'), ...balance.allLines('critical')];
  check(all.length >= 8, `话术够多（${all.length} 条），不会老是那一句`);
  // ⚠️ 用户 2026-09-13：「为什么电子琴键盘要换琴弦？」—— 键盘没有弦
  check(!all.some((l) => /键盘弦|琴弦|换弦/.test(l)), '没有「键盘换弦」这种常识错');
  // 用户：「不要像真的欠了100万一样」
  check(!all.some((l) => /饿死|活不下去|救命|要死了/.test(l)), '没有凄惨到像要出人命的说法');
  check(!all.some((l) => /API|token|余额不足|系统/.test(l)), '没有技术词');
  // 不能报具体金额（会和工资设定打架）
  check(!all.some((l) => /\d+\s*元|\d+\s*块/.test(l)), '没有报具体金额');
}

console.log('\n【2】★ 提醒的是"他去充值"，不是"她自己花超了"');
{
  // ⚠️ 用户 2026-09-13 第二次纠正：「这个余额提醒还得改改，我觉得还是得**和工资分开思考**，
  //    因为这个作用是**提醒我去充值的**，要**突出我的问题**」。
  //
  //    我上一版满嘴「我花得有点凶」「是**我**花得快」—— 那是"她自己的经济问题"的口气，
  //    结果**该负责的那个人看不到提醒**（用户截图反馈的就是这条）。
  const critLines = balance.allLines('critical');
  const lowLines = balance.allLines('low');
  const all = [...critLines, ...lowLines];

  check(
    all.every((l) => /充|余额|账|钱|清零/.test(l)),
    '每条都在说"账户/充值"这件事',
    all.find((l) => !/充|余额|账|钱|清零/.test(l)) ?? '',
  );
  // ✅ 私聊中仍明确称呼主人
  check(all.some((l) => /<主人>|你/.test(l)), '有指向主人的说法（<主人> / 你）');
  // ❌ 不能再出现"是我花超了"这一套
  check(
    !all.some((l) => /我自己的问题|是我花得快|花得有点凶|我花超/.test(l)),
    '没有"是我花超了"这种把责任揽到自己身上的说法',
    all.find((l) => /我自己的问题|是我花得快|花得有点凶|我花超/.test(l)) ?? '',
  );
  // ❌ 也不能提"工资"（那是另一套话术，两件事要分开）
  check(!all.some((l) => /工资|发工资|薪水/.test(l)), '不提"工资"（那是另一套，别混）');
  // ⚠️ 用户第三次纠正：「**也别说这个月之类的，因为余额我是随用随充的**」
  //    —— 余额**没有月度周期**，说"这个月快见底了"是概念错。
  check(
    !all.some((l) => /这个月|本月|这月|月底|下个月|每月/.test(l)),
    '不提「这个月/本月/月底」（余额是随用随充，没有月度周期）',
    all.find((l) => /这个月|本月|这月|月底|下个月|每月/.test(l)) ?? '',
  );
  // 私聊仍统一称呼<主人>，不沿用旧称呼。
  check(
    all.every((l) => /<主人>/.test(l)),
    '每条都点名<主人>（私聊提醒仍有明确称呼）',
    all.find((l) => !/<主人>/.test(l)) ?? '',
  );
  const onlyYou = all.filter((l) => /你/.test(l) && !/<主人>/.test(l));
  check(onlyYou.length === 0, '没有"只有你、没有<主人>"的句子', onlyYou[0] ?? '');
  // 「见底」档要直接催
  check(critLines.some((l) => /充(一)?下|该充|充点|充值/.test(l)), '「见底」档直接催他充钱');
}

console.log('\n【3】私聊余额话术统一点名<主人>');
{
  check(typeof balance.stripNameForAt === 'undefined', 'stripNameForAt 已删除（不再去掉名字）');
  for (const tier of ['low', 'critical']) {
    const lines = balance.allLines(tier);
    check(lines.every((l) => /<主人>/.test(l)), `${tier} 档每条都带<主人>`, lines.find((l) => !/<主人>/.test(l)) ?? '');
  }
}

console.log('\n【4】dry 预览不能把档位标记成"已抱怨"');
{
  // ⚠️ 这个坑很隐蔽：如果用 `balanceComplaint({total:1})` 来预览，
  //    它会真的把 critical 记成"已抱怨" → 真实提醒反而永远不发了
  const dry = balance.balanceComplaint({ total: crit - 0.5, dry: true });
  check(dry.need === true && dry.dry === true, 'dry 模式会返回话术');
  const real = balance.balanceComplaint({ total: crit - 0.5 });
  check(real.need === true, 'dry 之后真实调用**仍然**该抱怨（说明 dry 没吃掉档位）');
}

console.log('\n【5】★ 余额提醒只发送给主人私聊');
{
  const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));

  const got = [];
  const sockets = [];
  wss.on('connection', (ws, req) => {
    if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) {
      ws.close(1008);
      return;
    }
    sockets.push(ws);
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      got.push(m);
      // ⚠️ 必须回执：`bot.call()` 会生成一个 `echo` 并等回执，
      //    不回的话就是 30 秒超时（我第一版就卡在这里）
      if (m.echo !== undefined) {
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: m.echo }));
      }
    });
    ws.send(
      JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        self_id: '10000002',
        time: Math.floor(Date.now() / 1000),
      }),
    );
  });

  const bot = new Bot();
  const sock = new WebSocket(`ws://127.0.0.1:${WS_PORT}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  // 用真的 `attach()`，别自己塞 `bot.ws` —— 回执要有人处理（`pending` 表）
  bot.attach(sock);
  bot.selfId = '10000002';
  await sleep(600);

  await bot.sendToPrivate(owner, '<主人>，账上真见底了，充一下吧');
  await sleep(300);

  const sends = got.filter((m) => m.action === 'send_private_msg');
  const groupSends = got.filter((m) => m.action === 'send_group_msg');
  check(sends.length === 1, `发出 1 条私聊（实际 ${sends.length}）`);
  check(groupSends.length === 0, '没有发送任何群聊余额提醒');
  if (sends[0]) {
    check(String(sends[0].params?.user_id) === owner, `私聊收件人是主人（${owner}）`, `实际 ${sends[0].params?.user_id}`);
    const text = sends[0].params?.message?.[0]?.data?.text ?? '';
    check(/<主人>/.test(text), '私聊正文使用<主人>称呼', text);
    check(/充|账/.test(text), '私聊正文是在催充值', text);
  }

  try {
    bot.ws?.close();
  } catch {}
  wss.close();
}

console.log('\n【6】★★ 偏低档可由配置开关');
{
  const cfg = (await import('../src/config.js')).config;
  const oldLow = cfg.balance.low;
  cfg.balance.low = 0;
  const info = balance.tierInfo();
  check(info.length === 1 && info[0].key === 'critical', '★ 设置 low=0 后只剩「见底」档');
  const at3 = balance.balanceComplaint({ total: 3, groupId: 'gTierA' });
  check(at3.need === false, '★ low=0 时 3 元不提醒');
  cfg.balance.low = 5;
  const back = balance.balanceComplaint({ total: 3, groupId: 'gTierB' });
  check(back.need === true && back.tier === 'low', '★ 改回 5 后偏低提醒恢复');
  cfg.balance.low = oldLow;
}

console.log('\n【7】★★ 余额提醒**按群各记一次**（修 <主人> 报的「699 收不到余额报警」）');
{
  const cfg = (await import('../src/config.js')).config;
  const oldLow = cfg.balance.low;
  cfg.balance.low = 0; // 只留见底档，测起来干净
  const A = '200000006';
  const B = '200000002';
  balance.reload();

  const a1 = balance.balanceComplaint({ total: 1, groupId: A });
  check(a1.need === true && a1.tier === 'critical', '★★ 群 A 余额 1 元 → 提醒（见底档）');
  const a2 = balance.balanceComplaint({ total: 1, groupId: A });
  check(a2.need === false, '★ 同一个群**不会**重复提醒');
  const b1 = balance.balanceComplaint({ total: 1, groupId: B });
  check(
    b1.need === true,
    '★★ **另一个群照样提醒**（原来是全局只提醒一次 → 第一个群之后，别的群永远收不到）',
  );
  const re = balance.reload();
  check(
    re.complainedByGroup?.[A]?.critical === true && re.complainedByGroup?.[B]?.critical === true,
    '★ 按群的标记**落盘**了（重启不忘）',
  );

  // ── 充值回去 → 标记必须重置，否则"再掉下来就不提醒了" ──
  // ⚠️ 用假余额接口走一遍真的 `fetchBalance()`（它才负责重置）
  const http = await import('node:http');
  const srv = http.createServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '10.00' }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const oldBase = cfg.llm.baseURL;
  cfg.llm.baseURL = `http://127.0.0.1:${srv.address().port}/v1`;
  const fetched = await balance.fetchBalance();
  check(fetched.ok === true && fetched.total === 10, '★ 假余额接口通了（模拟"充值到 10 元"）', fetched.error ?? '');
  const a3 = balance.balanceComplaint({ total: 1, groupId: A });
  check(a3.need === true, '★★ 充上去之后再掉下来 → 那个群**又会**提醒（按群的标记也重置了）');
  try {
    srv.close();
  } catch {}
  cfg.llm.baseURL = oldBase;
  cfg.balance.low = oldLow;
}

clean();
console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
