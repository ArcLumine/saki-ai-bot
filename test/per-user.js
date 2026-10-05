/**
 * 「单人频率闸」测试（2026-10-02）。
 *
 * ## 它治的是哪个真问题
 *
 * 用户原话：「**有时候一个人主动触发过多导致 token 消耗过大了**」。
 *
 * 根因：**所有闸都是按群的**（`voluntaryBucket` = 场景@会话），
 * 而刷屏是**按人**的 —— 一个人连发 20 条时，群里只有他一个人在说话，
 * 于是**每一轮的冷却都是刚过的**（没人占住那个 key），20 条全部过闸、
 * 20 次全部烧模型调用。`strictness: 0` 时更糟：冷却 0、`maxChain = Infinity`。
 *
 * ## 三条设计约定（都在这里钉住）
 *
 * 1. **硬闸必须在 judge 之前**：放后面等于「照常花钱问一遍、再把结果丢掉」
 *    —— 那正是要治的病。所以 `checkPerUser` 在 `judgeSpeak()` 调用之前跑。
 * 2. **只在"真的开口了"时计数**：和 `markVoluntary()` 同一个记账点。
 *    判了不说**不计数** —— 否则又变成「这次没接 → 整段静默」，跟真人相反。
 * 3. **不落盘**：和「主动接话冷却」同一个取舍（重启后记起来反而危险）。
 *
 * ⚠️ 纯单元测试：不起机器人、不连 NapCat、不花钱（直接 new Bot 调方法）
 *
 * 用法: node test/per-user.js
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 配置路径必须在 import `src/*` **之前**设好（`config.js` 是加载时读的）
const CFG_REL = 'logs/__test-per-user.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    '',
    'chat:',
    '  perUser:',
    '    enable: true',
    '    windowMs: 300000',
    '    softLimit: 3',
    '    hardLimit: 6',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const mod = await import('../src/bot.js');
const BotClass = mod.Bot ?? mod.default ?? null;
const G1 = '200000001';
const G2 = '200000002';
const A = '40001'; // 刷屏的那个人
const B = '40002'; // 另一个人
const ev = (gid, uid) => ({
  message_type: 'group',
  group_id: gid,
  user_id: uid,
  sender: { nickname: uid === A ? '话痨' : '路人' },
  message: [],
});

if (!BotClass) {
  console.log('  ❌ 没找到导出的 Bot 类（测试无法进行）');
  process.exit(1);
}
check(true, '拿到了 Bot 类');

const b = new BotClass();

console.log('\n【1】同一个人连发：到硬阈值才拦，且**记的是"她真说了几次"**');
{
  const seen = [];
  for (let i = 1; i <= 8; i++) {
    const r = b.checkPerUser('chat', ev(G1, A));
    seen.push(r.allow);
    // ⚠️ 模拟"她真的说了" → 记一次（就是 markVoluntary 里那一行）
    if (r.allow) b._countPerUser('chat', ev(G1, A));
  }
  // 0,1,2 次时放行；第 4 次开始是 soft（仍放行）；第 7 次起 hard（拦）
  check(seen[0] === true, '第 1 次 → 放行');
  check(seen[2] === true, '第 3 次（softLimit）→ 仍放行（只是喂给 judge 让它收着）');
  check(b.checkPerUser('chat', ev(G1, A)).hard === true, '★ 第 7 次 → 硬阈值命中');
  check(b.checkPerUser('chat', ev(G1, A)).allow === false, '★ 硬阈值拦下 ⇒ 一次模型调用都不花');
}

console.log('\n【2】★ 另一个人**不该被连累**（否则就是"一人刷屏、全群哑掉"）');
{
  const r = b.checkPerUser('chat', ev(G1, B));
  check(r.allow === true, 'B 的额度是独立的');
  check(r.count === 0, 'B 窗口内 0 次');
}

console.log('\n【3】★ 跨群不该被连累（和 voluntaryBucket 同一口径）');
{
  const r = b.checkPerUser('chat', ev(G2, A));
  check(r.count === 0, 'A 在另一个群是重新计的');
  check(r.allow === true, 'A 在 G2 上不受 G1 的刷屏影响');
}

console.log('\n【4】窗口滑出之后**要恢复**（不能一次刷屏就永久禁言）');
{
  const b2 = new BotClass();
  for (let i = 0; i < 7; i++) {
    b2._countPerUser('chat', ev(G1, A));
  }
  check(b2.checkPerUser('chat', ev(G1, A)).allow === false, '先确认确实被拦住了');
  // ⚠️ 手动把窗口调小（而不是改 config）→ 模拟"时间过去了"
  const arr = b2.perUserHits[b2.perUserKey('chat', ev(G1, A))];
  const old = Date.now() - 6 * 60 * 1000; // 6 分钟前，早于 5 分钟窗口
  arr.fill(old);
  const r = b2.checkPerUser('chat', ev(G1, A));
  check(r.allow === true, '★ 6 分钟前的触发滑出窗口 → 恢复放行');
  check(r.count === 0, '过期的记录被裁掉了（计数归零，不会无限涨）');
}

console.log('\n【5】★ 「判了不说」不计数（否则整段静默，跟真人相反）');
{
  const b3 = new BotClass();
  // 模拟：过了闸、跑了 judge、结果判"不说" → 只有 markVoluntary 才计数，
  // 判了不说的路径压根不会调 markVoluntary。
  b3.checkPerUser('chat', ev(G1, A)); // 放行，但**没有** _countPerUser
  check(b3.countPerUser('chat', ev(G1, A)) === 0, '没开口就不计次数');
  // 对照：真开口了才计
  b3.markVoluntary('chat', ev(G1, A));
  check(b3.countPerUser('chat', ev(G1, A)) === 1, '★ markVoluntary 之后才 +1');
}

console.log('\n【6】key 的构造');
{
  const k1 = b.perUserKey('chat', ev(G1, A));
  const k2 = b.perUserKey('chat', ev(G2, A));
  const k3 = b.perUserKey('chat', ev(G1, B));
  console.log(`     → ${k1}`);
  check(k1 !== k2 && k1 !== k3 && k2 !== k3, '群和人都不同的 key 互不相同');
  check(k1.includes(A), 'key 里带 user_id');
  check(b.perUserKey('chat', null) === b.voluntaryBucket('chat', null), 'event 为 null 时退回旧口径、不抛错');
}

console.log('\n【7】关掉开关 = 完全不影响（可回退）');
{
  const { config } = await import('../src/config.js');
  const b4 = new BotClass();
  const save = { ...config.chat.perUser };
  config.chat.perUser.enable = false;
  check(b4.checkPerUser('chat', ev(G1, A)).allow === true, '关掉后永远放行');
  Object.assign(config.chat.perUser, save);
}

console.log('\n【8】召唤频率闸（2026-10-03）—— 换着花样点名也挡得住');
{
  const { config } = await import('../src/config.js');
  // ⚠️ 先在配置里显式开出来：默认是关的（opt-in），免得升级就改变既有行为。
  const b8 = new BotClass();
  const save = JSON.parse(JSON.stringify(config.chat.perUserCall));
  config.chat.perUserCall.enable = true;
  config.chat.perUserCall.windowMs = 120000;
  config.chat.perUserCall.limit = 10;
  const eA = ev(G1, A);

  check(b8.checkPerUserCall(eA, 'call').allow === true, '默认：第 1 次召唤放行');
  // ⚠️ 模拟"真的答了"——计数发生在闸通过之后（`handle` 里的 `_countPerUserCall`）。
  //    ⚠️ 循环 `i < 10` 跑 10 次：第 1 次调用前 count=0（放行），跑完恰好 10 次。
  for (let i = 0; i < 10; i++) {
    const r = b8.checkPerUserCall(eA, 'call');
    check(r.allow === true, `第 ${i + 1} 次召唤放行（阈值 10，留足余量）`);
    b8._countPerUserCall(eA); // 过了闸 → 真的答了 → 记一次
  }
  check(b8.countPerUserCall(eA) === 10, '★ 累计 10 次（正好到阈值）');

  // 换着花样点名：哈希/内容各不相同，但**计数不看内容**，只按人。
  const ways = ['小祥在吗', '叫一下祥子', '小祥？', '祥子在吗', '小祥小祥'];
  let firstGate = null;
  for (let i = 0; i < 5; i++) {
    const r = b8.checkPerUserCall({ ...eA, raw_message: ways[i % ways.length] }, 'call');
    if (!r.allow && firstGate === null) firstGate = r;
  }
  check(firstGate !== null, '★ 第 11 次被静默（已累计 10 次）');
  check(firstGate?.first === true, '★ 撞线**第一次**要提示');
  check(b8.checkPerUserCall(eA, 'call').first === false, '★ 之后不再提示（只提示一次）');

  const notice = b8.callGateNotice(firstGate?.who);
  check(typeof notice === 'string' && notice.length > 0, '提示语是非空字符串');
  check(b8.callGateNotice(null).length > 0, '取不到称呼时也不抛错');

  Object.assign(config.chat.perUserCall, save);
}

console.log('\n【9】召唤计数与闲聊计数**完全隔离**');
{
  const { config } = await import('../src/config.js');
  const b9 = new BotClass();
  const save = JSON.parse(JSON.stringify(config.chat));
  config.chat.perUser.enable = true;
  config.chat.perUserCall.enable = true;
  config.chat.perUserCall.limit = 10;
  config.chat.perUserCall.windowMs = 120000;
  const eA = ev(G1, A);

  for (let i = 0; i < 10; i++) b9._countPerUserCall(eA); // 点名刷到阈值
  check(b9.countPerUserCall(eA) === 10, '召唤计数 = 10');
  check(b9.countPerUser('chat', eA) === 0, '★ 闲聊计数**不受召唤影响**（仍是 0）');
  check(b9.checkPerUserCall(eA, 'call').allow === false, '召唤被拦');
  check(b9.checkPerUser('chat', eA).allow === true, '★ 闲聊仍放行（正常聊天没被牵连）');

  // 反向：闲聊刷满也不该吃掉召唤额度。
  const b9b = new BotClass();
  for (let i = 0; i < 6; i++) b9b.markVoluntary('chat', eA); // 闲聊到硬阈值
  check(b9b.checkPerUser('chat', eA).allow === false, '闲聊被拦');
  check(b9b.countPerUserCall(eA) === 0, '★ 召唤计数**不受闲聊影响**');
  check(b9b.checkPerUserCall(eA, 'call').allow === true, '★ 召唤仍放行');

  config.chat.perUser = save.perUser;
  config.chat.perUserCall = save.perUserCall;
}

console.log('\n【10】召唤闸关掉 = 零影响（可回退）');
{
  const { config } = await import('../src/config.js');
  const b10 = new BotClass();
  const save = config.chat.perUserCall.enable;
  config.chat.perUserCall.enable = false;
  check(b10.checkPerUserCall(ev(G1, A), 'call').allow === true, '关掉后永远放行');
  config.chat.perUserCall.enable = save;
}

console.log('\n【11】按人分：另一个人不受牵连');
{
  const { config } = await import('../src/config.js');
  const b11 = new BotClass();
  const save = config.chat.perUserCall.enable;
  config.chat.perUserCall.enable = true;
  const eA = ev(G1, A);
  const eB = ev(G1, B);
  for (let i = 0; i < 20; i++) b11._countPerUserCall(eA);
  check(b11.checkPerUserCall(eA, 'call').allow === false, 'A 被拦');
  check(b11.checkPerUserCall(eB, 'call').allow === true, '★ B 不受影响');
  config.chat.perUserCall.enable = save;
}

console.log('\n【12】★ 识图也走同一个召唤闸（2026-10-03）');
{
  // ⚠️ 为什么识图必须进闸：触发识图只需要「上下文里有刚发过的图」，
  //    不需要任何召唤动作 —— 一个人连发 20 张图就能逼出 20 次识图调用，
  //    而每次识图都是一次真实模型调用（比聊天更贵）。这是最省的滥用口子。
  const { config } = await import('../src/config.js');
  const b12 = new BotClass();
  const save = JSON.parse(JSON.stringify(config.chat.perUserCall));
  config.chat.perUserCall.enable = true;
  config.chat.perUserCall.limit = 10;
  config.chat.perUserCall.windowMs = 120000;
  const eA = ev(G1, A);

  for (let i = 0; i < 10; i++) b12._countPerUserCall(eA);
  const vg = b12.checkPerUserCall(eA, 'vision');
  check(vg.allow === false, '★ 窗口内识图触发撞线 → 不识图（省一次 flash 调用）');
  check(b12.checkPerUserCall(eA, 'vision').allow === false, '★ 之后持续拦（不是只拦一次）');
  // ⚠️ 闸按人头分桶：换个群/换个人识图该放行，否则就是"一人刷图、全群不识图"。
  check(b12.checkPerUserCall(ev(G2, A), 'vision').allow === true, '★ 换个群识图不受牵连');
  check(b12.checkPerUserCall(ev(G1, B), 'vision').allow === true, '★ 换个人识图不受牵连');

  Object.assign(config.chat.perUserCall, save);
}

console.log('\n【13】vision 关掉闸 = 照常识图（可回退，不锁死功能）');
{
  const { config } = await import('../src/config.js');
  const b13 = new BotClass();
  const save = config.chat.perUserCall.enable;
  config.chat.perUserCall.enable = false;
  const eA = ev(G1, A);
  for (let i = 0; i < 50; i++) b13._countPerUserCall(eA);
  check(b13.checkPerUserCall(eA, 'vision').allow === true, '关掉后识图不受限制');
  config.chat.perUserCall.enable = save;
}

console.log(`\n${failures ? `❌ ${failures} 条没过` : '✅ 全部通过'}`);
try {
  rmSync(join(ROOT, CFG_REL), { force: true });
} catch {}
process.exit(failures ? 1 : 0);
