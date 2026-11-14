/**
 * 日账（`src/daybook.js`）回归。
 *
 * ## 这个套件盯的四件事（交接文档 `daybook-handoff.md` 定的）
 *
 * 1. **抽得准的那几条**：时间词 + 动作词 → 记；问句 / 对着别人说的 / 条件句 → 不记
 * 2. **只留 3 天、只留 8 条** —— 过期就该忘，它不是长期记忆
 * 3. **提示词块长什么样** —— 头、条目、以及「忘了就说记不清，别换一个说法糊过去」
 * 4. **空的时候返回空串**（别塞「（暂无）」，那会被当成真的什么都没有到处复述）
 *
 * ⚠️ 纯离线：不联网、不花钱、不碰真 `state/`（`QQBOT_DAYBOOK_FILE` 指到 `logs/`）。
 * 用法: node test/daybook.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const CFG_REL = 'logs/__test-daybook.yml';
const DB_REL = 'logs/__test-daybook.json';
const DB = join(ROOT, DB_REL);

writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: t',
    'timeZone: Asia/Tokyo',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_DAYBOOK_FILE = DB_REL;

const daybook = await import('../src/daybook.js');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `\n      实际：${extra}` : ''}`);
  if (!ok) failures++;
};
const reset = () => {
  try { rmSync(DB, { force: true }); } catch {}
};

try {
  // ── 【1】抽取 ───────────────────────────────────────────────
  console.log('\n【1】抽取：时间词 + 动作词才记，问句/别人的事不记');
  reset();
  check(
    daybook.extract('早上跟睦在校门口分了包辣条，辣得灌水').length === 1,
    '「早上 + 分了」→ 记（交接文档里那条真实案例）',
    JSON.stringify(daybook.extract('早上跟睦在校门口分了包辣条，辣得灌水')),
  );
  check(
    daybook.extract('明天要去月之森给睦送东西').length === 1,
    '「明天 + 要去」→ 记',
    JSON.stringify(daybook.extract('明天要去月之森给睦送东西')),
  );
  check(daybook.extract('今天好热啊').length === 0, '光有时间词、没有动作 → 不记');
  check(daybook.extract('你要不要明天一起去吃').length === 0, '「你要不要……」是在问别人 → 不记');
  check(daybook.extract('明天要去吃吗').length === 0, '问句 → 不记');
  check(daybook.extract('明天要是下雨就不去了').length === 0, '条件句 → 不记');
  check(daybook.extract('你别忘了明天要去买醋').length === 0, '「你别忘了……」是提醒，不是她的生活 → 不记');
  check(daybook.extract('嗯').length === 0, '太短 → 不记');
  check(daybook.extract('').length === 0, '空串不炸');
  check(daybook.extract(null).length === 0, 'null 不炸');
  check(
    daybook.extract('今天吃了一大碗面，还去便利店买了水。今天可真冷。').length === 1,
    '一句里两件事（同一句…）只记这一句；后面纯感慨那句不记',
    JSON.stringify(daybook.extract('今天吃了一大碗面，还去便利店买了水。今天可真冷。')),
  );
  check(
    daybook.extract('今天吃了面。昨天去了公园。明天要补课。').length === 2,
    '一条回复里最多记 2 条（多了就是在写日记）',
    JSON.stringify(daybook.extract('今天吃了面。昨天去了公园。明天要补课。')),
  );

  // ── 【2】落盘 + 读取 ─────────────────────────────────────────
  console.log('\n【2】落盘：原文存下来，带日期时间，按时间正序');
  reset();
  const n1 = daybook.record('早上跟睦在校门口分了包辣条，辣得灌水');
  check(n1 === 1, 'record() 返回记了几条', String(n1));
  daybook.record('明天要去月之森给睦送东西');
  const items = daybook.list();
  check(items.length === 2, '两条都在', String(items.length));
  check(items[0].text.includes('辣条'), '存的是**原文**（没改写、没截断）', items[0]?.text);
  check(/^\d{2}-\d{2}$/.test(items[0].date), 'date 是 `MM-DD`', items[0]?.date);
  check(/^\d{2}:\d{2}$/.test(items[0].at), 'at 是 `HH:MM`', items[0]?.at);
  check(
    Number(items[0].ts) <= Number(items[1].ts),
    'list() 按时间正序（老的在前）',
    `${items[0].ts} / ${items[1].ts}`,
  );
  const raw = JSON.parse(readFileSync(DB, 'utf8'));
  check(Array.isArray(raw.items) && raw.items.length === 2, 'state 文件里是 `{items:[…]}`', JSON.stringify(raw).slice(0, 80));

  // ── 【3】去重 ───────────────────────────────────────────────
  console.log('\n【3】去重：同一句说两遍只留一条');
  const n2 = daybook.record('早上跟睦在校门口分了包辣条，辣得灌水');
  check(n2 === 0, '重复的一句不再记', String(n2));
  check(daybook.list().length === 2, '条数没变', String(daybook.list().length));
  daybook.record('早上，跟睦在校门口分了包辣条，辣得灌水。');
  check(daybook.list().length === 2, '标点不同也算同一条', String(daybook.list().length));

  // ── 【4】提示词块 ───────────────────────────────────────────
  console.log('\n【4】提示词块：格式和那三条提醒');
  const blk = daybook.block();
  check(blk.includes('# 【你这两天自己说过的事】'), '有标题');
  check(/^- \d{2}-\d{2} \d{2}:\d{2} 早上跟睦/m.test(blk), '条目是 `- 11-12 18:30 …`', blk.split('\n')[2]);
  check(blk.includes('你自己说过的话'), '说清是**她自己**说的，不是别人告诉她的');
  check(blk.includes('记不清了'), '允许「记不清了」（真人最常用的解法）');
  check(blk.includes('别换一个说法糊过去'), '明令**不许换一个说法糊过去**');
  check(blk.includes('不用主动拿出来讲'), '不用主动拿出来讲');
  check(daybook.block({ maxChars: 10 }) === '' || !daybook.block({ maxChars: 10 }).includes('- '), 'maxChars 太小 → 不硬塞');

  // ── 【5】上限 8 条 ──────────────────────────────────────────
  console.log('\n【5】上限：只留最近 8 条');
  reset();
  const now = Date.now();
  const many = Array.from({ length: 8 }, (_, i) => ({
    ts: now - (8 - i) * 60000,
    date: '11-12',
    at: `1${i}:00`,
    text: `今天去超市买了东西第${i}次`,
  }));
  writeFileSync(DB, JSON.stringify({ items: many }, null, 2), 'utf8');
  daybook.record('今天在家煮了面');
  const capped = daybook.list({ limit: 99 });
  check(capped.length === 8, '记第 9 条之后仍然是 8 条', String(capped.length));
  check(!capped.some((x) => x.text.endsWith('第0次')), '丢的是最老那条', JSON.stringify(capped.map((x) => x.text.slice(-4))));
  check(capped.some((x) => x.text === '今天在家煮了面'), '新那条在', JSON.stringify(capped.map((x) => x.text)));

  // ── 【6】3 天过期 ───────────────────────────────────────────
  console.log('\n【6】过期：超过 3 天的删掉（它不是长期记忆）');
  reset();
  writeFileSync(
    DB,
    JSON.stringify({
      items: [
        { ts: now - 5 * 86400e3, date: '11-07', at: '10:00', text: '今天去了很远的地方' },
        { ts: now - 86400e3, date: '11-11', at: '10:00', text: '昨天去了公园' },
      ],
    }, null, 2),
    'utf8',
  );
  const pruned = daybook.prune();
  check(pruned.length === 1, '5 天前那条被清掉', String(pruned.length));
  check(pruned[0]?.text === '昨天去了公园', '1 天前那条还在', pruned[0]?.text);
  const onDisk = JSON.parse(readFileSync(DB, 'utf8'));
  check(onDisk.items.length === 1, '清理结果落了盘（不是只改内存）', String(onDisk.items.length));

  // ── 【7】空的时候 ───────────────────────────────────────────
  console.log('\n【7】空的时候返回空串（不塞「（暂无）」）');
  reset();
  check(daybook.list().length === 0, '没有条目');
  check(daybook.block() === '', 'block() === 空串', JSON.stringify(daybook.block()));
  check(daybook.record('嗯') === 0, '没东西可记时返回 0', String(daybook.record('嗯')));
} finally {
  reset();
  try { rmSync(join(ROOT, CFG_REL), { force: true }); } catch {}
}

// ⚠️ 收尾语**必须**是「全部通过」—— `run-all.js` 靠这个关键词判绿
console.log(`\n结果: ${failures ? `${failures} 项失败 ❌` : '全部通过 ✅'}`);
process.exit(failures ? 1 : 0);
