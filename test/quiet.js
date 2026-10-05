/**
 * 群内「安静」指令的回归（2026-09-28 加）。
 *
 * ## 为什么盯这个
 *   服主一句话让她闭嘴 —— 这功能最危险的失败方式**不是"不闭嘴"**，
 *   而是**该闭嘴时没闭嘴**（还在群里插嘴）或者**不该闭嘴时闭嘴了**
 *   （她突然消失半句话，群里只当她掉线了，比说错话更难查）。
 *   所以【2】那组反例和【1】同样重要。
 *
 * ⚠️ 纯离线：不发请求、不碰真 QQ、不动真实的 state/quiet.json
 *    （下面把 QQBOT_QUIET_FILE 指到 logs/ 下，和 run-all 一个套路）。
 *
 * 用法: node test/quiet.js
 */
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ── 先把 config / 状态路径指到临时文件，再 import（import 一跑就定死了）──
const CFG_REL = 'logs/__test-quiet.yml';
const QUIET_REL = 'logs/__test-quiet-state.json';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'quiet:',
    '  enable: true',
    '  keywords:',
    '    - 小祥安静',
    '  releaseKeywords:',
    '    - 小祥说话',
    '  durationMs: 0',
    '  groupId: "1001"',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_QUIET_FILE = QUIET_REL;
rmSync(join(ROOT, QUIET_REL), { force: true });

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { matchQuiet, Bot } = await import('../src/bot.js');
const CFG = { keywords: ['小祥安静'], releaseKeywords: ['小祥说话'], durationMs: 0, groupId: '1001' };
const GROUP = { message_type: 'group', group_id: '1001' };
const OTHER_GROUP = { message_type: 'group', group_id: '2002' };

console.log('\n【1】认得指令（含标点/空白的容错）');
for (const t of ['小祥安静', '小祥安静。', '小祥安静！', '  小祥安静  ']) {
  check(matchQuiet(t, CFG)?.act === 'on', `「${t}」→ 安静`);
}
for (const t of ['小祥说话', '小祥说话。']) {
  check(matchQuiet(t, CFG)?.act === 'off', `「${t}」→ 解除`);
}
{
  // ⚠️ 解除词必须**先判**：万一有人把同一个词同时配成两个意思，
  //    判成"安静"就反了 —— 那就是越说越安静，比不做还离谱。
  const m = matchQuiet('说话', { keywords: ['说话'], releaseKeywords: ['说话'] });
  check(m?.act === 'off', '同一个词既是安静又是解除时，判「解除」', m ? `→ ${m.act}` : '→ 没认出来');
}

console.log('\n【2】★ 不许误伤（这一组同样重要）');
for (const t of [
  '小祥安静点，她今天话好多', // 半句话
  '别安静了快说话',
  '今天服务器人多吗',
  '安静', // 没配的词
  '',
  '   ',
  null,
  undefined,
]) {
  check(matchQuiet(t, CFG) === null, `「${String(t).slice(0, 12)}」不算指令`);
}

console.log('\n【3】作用域：只认配置里那个群');
{
  const bot = Object.create(Bot.prototype);
  bot.quiet = { 1001: { at: Date.now(), until: 0, by: '1', byName: '主人' } };
  check(bot.isQuieted(GROUP) === true, '配置里的群：闭嘴中');
  check(bot.isQuieted(OTHER_GROUP) === false, '别的群不受影响（A 群下令、B 群照说）');
  check(bot.isQuieted({ message_type: 'private', user_id: '1' }) === false, '私聊不受影响');
}

console.log('\n【4】到点自己醒 / 一直到解除 是两种情况');
{
  const bot = Object.create(Bot.prototype);
  bot.quiet = { 1001: { at: Date.now() - 1000, until: Date.now() - 1, by: '1', byName: '主人' } };
  check(bot.isQuieted(GROUP) === false, '过了期限 → 自动醒');
  check(bot.quiet['1001'] === undefined, '过期的条目顺手清掉了（不然文件越攒越多）');

  const bot2 = Object.create(Bot.prototype);
  bot2.quiet = { 1001: { at: Date.now(), until: Date.now() + 60000, by: '1', byName: '主人' } };
  check(bot2.isQuieted(GROUP) === true, '没到期 → 继续闭嘴');
}

console.log('\n【5】关掉开关就不安静（enable: false）');
{
  const { config } = await import('../src/config.js');
  const bot = Object.create(Bot.prototype);
  bot.quiet = { 1001: { at: Date.now(), until: 0, by: '1', byName: '主人' } };
  const old = config.quiet.enable;
  config.quiet.enable = false;
  check(bot.isQuieted(GROUP) === false, 'enable: false → 有旧状态也不闭嘴');
  config.quiet.enable = old;
  check(bot.isQuieted(GROUP) === true, '把开关改回来 → 又闭嘴了（别把状态测没了）');
}

console.log('\n【6】★ 落盘：重启后还记得（这才是要落文件的原因）');
{
  const a = Object.create(Bot.prototype);
  a.quiet = { 1001: { at: 1700000000000, until: 0, by: '1234567890', byName: '主人' } };
  a.saveQuietState();
  check(existsSync(join(ROOT, QUIET_REL)), '写出了 quiet.json');

  const b = Object.create(Bot.prototype);
  b.loadQuietState();
  check(b.quiet?.['1001']?.byName === '主人', '新实例读回来还是闭嘴中');
  const raw = JSON.parse(readFileSync(join(ROOT, QUIET_REL), 'utf8'));
  check(raw['1001']?.by === '1234567890', '落盘字段完整（谁下的令也记着）');
}

console.log('\n【7】权限：没资格的人下不了令');
{
  const said = [];
  const mk = (canTeach) => {
    const bot = Object.create(Bot.prototype);
    bot.quiet = {};
    bot.sendText = async (_e, t) => { said.push(t); };
    bot.canTeach = () => canTeach;
    return bot;
  };

  const no = mk(false);
  const r1 = await no.handleQuiet(GROUP, '小祥安静');
  check(r1 === false, '群友说「小祥安静」→ 不算指令');
  check(Object.keys(no.quiet).length === 0, '群友没能让她闭嘴');
  check(said.length === 0, '群友那条也没被吞掉（照常当聊天处理，不静默消失）');

  const yes = mk(true);
  const r2 = await yes.handleQuiet(GROUP, '小祥安静');
  check(r2 === true, '服主说「小祥安静」→ 指令被消费掉');
  check(yes.quiet['1001'] !== undefined, '状态已记录');
  check(/知道了/.test(said.at(-1) ?? ''), '回了一句「知道了」', said.at(-1) ?? '');

  said.length = 0;
  const r3 = await yes.handleQuiet(OTHER_GROUP, '小祥安静');
  check(r3 === false, '别的群说「小祥安静」→ 不算（作用域只认配置那个群）');

  said.length = 0;
  const r4 = await yes.handleQuiet(GROUP, '小祥说话');
  check(r4 === true && yes.quiet['1001'] === undefined, '解除指令生效');
  check(/我回来了/.test(said.at(-1) ?? ''), '回了一句「我回来了」', said.at(-1) ?? '');
}

console.log('\n【8】带时限的安静（durationMs ≠ 0）');
{
  const { config } = await import('../src/config.js');
  const said = [];
  const bot = Object.create(Bot.prototype);
  bot.quiet = {};
  bot.sendText = async (_e, t) => { said.push(t); };
  bot.canTeach = () => true;
  config.quiet.durationMs = 10 * 60 * 1000;
  await bot.handleQuiet(GROUP, '小祥安静');
  check((bot.quiet['1001']?.until ?? 0) > Date.now(), '到点时间被记下来了（10 分钟后）');
  check(/10\s*分钟/.test(said.at(-1) ?? ''), '回话里说了安静多久', said.at(-1) ?? '');
  config.quiet.durationMs = 0; // 还原
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(join(ROOT, QUIET_REL), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
