/**
 * 海豹骰（SealDice）客户端的回归（2026-09-30，方案「甲」）。
 *
 * ## 用户需求
 *   「群里发 .ra 之类小祥能答」+「小祥和海豹最后要落到同一个账号收发消息」
 *
 * ## 方案为什么是「海豹不接 IM」
 *   小祥和海豹若都连同一个 NapCat（同一个 QQ 账号），会有**自反馈死循环**：
 *   小祥发的消息 → 海豹当成"群友消息" → 再转回给小祥 ⇒ 她在跟自己对话。
 *   那是架构问题，调参解决不了。所以海豹只做**骰点引擎 + log**，由小祥主动调它的 API。
 *
 * ## 为什么用假海豹服务而不是真海豹
 *   真海豹能测（实测过 `dice/exec` 通），但**不能进 `run-all`**：
 *   它是外部常驻进程、还要 token，套件必须能独立跑完。所以这里起一个
 *   假 HTTP 服务，验的是**我们这边的调用方式**（路径、请求体、超时、容错）。
 *
 * ⚠️ 纯离线：假服务只监听 127.0.0.1 的随机端口，不碰真海豹、不碰真 config.yml。
 *
 * 用法: node test/sealdice.js
 */
import { createServer } from 'node:http';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ── 起一个假海豹 ────────────────────────────────────────
let hits = [];
const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ url: req.url, method: req.method, token: req.headers.token ?? '', body });
    res.setHeader('Content-Type', 'application/json');
    const u = req.url || '';
    // ⚠️ 算骰是**分两步**：exec 只回 "ok"，结果在 recentMessage（海豹这么设计的）
    if (u === '/sd-api/dice/exec') { res.end(JSON.stringify('ok')); return; }
    if (u === '/sd-api/dice/recentMessage') {
      res.end(JSON.stringify([{ uid: 'UI-Group:2001', message: '检定结果为: 42', messageType: 'group' }]));
      return;
    }
    if (u.startsWith('/sd-api/story/logs/page')) {
      res.end(JSON.stringify({ data: [{ name: '第一局', groupId: '<跑团群>' }], total: 1, result: true }));
      return;
    }
    if (u === '/sd-api/js/status') { res.end(JSON.stringify({ result: true, status: true })); return; }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;


const CFG_REL = 'logs/__test-sealdice.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'sealdice:',
    '  enable: true',
    `  baseUrl: http://127.0.0.1:${port}`,
    '  token: TEST-TOKEN',
    '  timeoutMs: 2000',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;

const S = await import('../src/sealdice.js');
const { config } = await import('../src/config.js');


console.log('\n【1】★★ 配置与开关');
{
  check(S.enabled() === true, '★ 配了 baseUrl+token ⇒ 启用');
  check(typeof S.ping === 'function', '导出 ping（给状态显示用）');
  check(config.sealdice.timeoutMs <= 15000, '★ 超时被夹在 15 秒内', `实得 ${config.sealdice.timeoutMs}`);
  // ⚠️ 不填 baseUrl 必须完全不启用 —— 这是「对现有行为零影响」的前提
  const saved = config.sealdice.baseUrl;
  config.sealdice.baseUrl = '';
  check(S.enabled() === false, '★★ baseUrl 为空 ⇒ 不启用（零影响现有行为）');
  config.sealdice.baseUrl = saved;
}

console.log('\n【2】★★ 算骰（群里打 .ra 小祥能答）');
{
  hits = [];
  const out = await S.ask('.ra 3d6');
  const exec = hits.find((h) => h.url === '/sd-api/dice/exec');
  const recent = hits.find((h) => h.url === '/sd-api/dice/recentMessage');
  check(!!exec, '★ 调了 dice/exec');
  check(!!recent, '★ 接着取了 recentMessage（结果不在 exec 的返回里）');
  check(exec?.method === 'POST', 'exec 是 POST');
  check(exec?.token === 'TEST-TOKEN', '★ 带上了 token 请求头');
  check(out.includes('42'), '★ 拿到了结果文本', `实得「${out}」`);

console.log('\n【3】★★ 容错：海豹不在 / 出错都不能拖住小祥');
{
  hits = [];
  const bad = await S.storyLogs({ pageNum: 1, pageSize: 10 });
  check(Array.isArray(bad.list) && bad.total >= 0, '★ 正常路径返回结构化结果', `total=${bad.total}`);

  // ⚠️ 这条调用在**消息处理链路**上，抛异常 = 打断小祥。所以必须只返回空。
  const savedUrl = config.sealdice.baseUrl;
  config.sealdice.baseUrl = 'http://127.0.0.1:1'; // 没人听的端口
  const t0 = Date.now();
  let threw = false;
  try { await S.ask('.r'); } catch { threw = true; }
  const dt = Date.now() - t0;
  check(!threw, '★★ 连不上时**不抛异常**（它在消息处理链路上）');
  check(dt < 3000, '★ 连不上很快就返回（没有把消息处理卡住）', `${dt}ms`);
  config.sealdice.baseUrl = savedUrl;
}

console.log('\n【4】★ 跑团记录（用户要求独立分支，不塞 observe/）');
{
  hits = [];
  const { list, total } = await S.storyLogs({ pageNum: 2, pageSize: 30 });
  const u = hits.find((h) => h.url.startsWith('/sd-api/story/logs/page'));
  check(!!u, '★ 调了 story/logs/page');
  check(u?.url.includes('pageNum=2') && u?.url.includes('pageSize=30'), '★ 分页参数带上了', u?.url);
  check(Array.isArray(list) && list.length === 1, '★ 拿到记录列表');
  check(total === 1, '★ 拿到 total', `实得 ${total}`);

  // ⚠️ 这条约束现在搬到了 `dice-log.js`（读 log 的逻辑从 sealdice.js 独立出去了）
  const dj = readFileSync(join(ROOT, 'src', 'dice-log.js'), 'utf8');
  check(/混进 `observe\/`/.test(dj), '★★ dice-log.js 里写明了「混进 observe/ 会怎样」');
  // ⚠️ 删掉所有注释行后再查 —— 注释里也会提 observe/，那是文字而不是行为
  const codeOnly = dj
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
  check(!/observe/.test(codeOnly), '★★ 除了注释，**代码里**没有真的往 observe/ 写');
  check(
    /state\/dice-logs\.json|QQBOT_DICE_LOG_FILE/.test(dj),
    '★ 落点是 state/dice-logs.json（程序状态，不是 md）',
  );
}

console.log('\n【5】★★ 方案约束：不接 IM（自反馈死循环那条）');
{
  // ⚠️ 这是本方案最核心的决策，必须钉住 —— 否则哪天有人改成"海豹接 QQ"就炸了
  const js = readFileSync(join(ROOT, 'src', 'sealdice.js'), 'utf8');
  check(/自反馈死循环/.test(js), '★★ 模块注释里写明了「自反馈死循环」这个约束');
  const botjs = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  // ⚠️ 2026-09-30 修正：这条断言本来写的是「bot.js 完全没接 sealdice」，
  //   方案推进后**过时了** —— 现在 bot.js 确实要用 `sealdice.ask()` 转述骰点。
  //   真正要守的不变式是「**不把海豹接进 OneBot**」（那才是死循环的根源），
  //   所以改成查 onebot 那一段，而不是查有没有提到 sealdice。
  const ob = botjs.slice(botjs.indexOf('onebot'), botjs.indexOf('onebot') + 800);
  check(!/sealdice/i.test(ob), '★★ **OneBot 那一段没混入 sealdice**（海豹不碰 IM，防自反馈死循环）');
  check(
    !/onebot[\s\S]{0,400}sealdice|sealdice[\s\S]{0,400}onebot/i.test(ob),
    '★★ 海豹和 onebot 配置不相邻（防止有人把两者塞进同一段）',
  );
  const ex = readFileSync(join(ROOT, 'config.example.yml'), 'utf8');
  check(/token: ''/.test(ex), '★★ 模板里 token 是空的 ⇒ 照模板配的人不会被意外启用');
}

console.log('\n【6】★★ 触发词在界面上可改（用户要求）');
{
  // ⚠️ webui.js 自己的注释写着这个坑：「原来这里漏了 chat ⇒ 界面永远读不到值，
  //    用户以为保存没生效」。所以三处必须同步，漏一处就有那种诡异 bug。
  const wj = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  check(/diceMode: \{/.test(wj), '★★ ① configForUi 里有 diceMode（能读回来）');
  check(/put\('diceMode', patch\.diceMode\)/.test(wj), '★★ ② saveConfig 里 put 了它（能写进去）');
  check(
    /'diceMode',/.test(wj.slice(wj.indexOf('const HANDLED'), wj.indexOf('const HANDLED') + 700)),
    '★★ ③ HANDLED 白名单里有它（否则会静默丢弃 + 只吵一行 warn）',
  );
  // ⚠️ `indexOf` 会撞上 HANDLED 里那个（它在前），所以从 `const order` 之后再找
  check(
    wj.indexOf("'diceMode',", wj.indexOf('const order')) > 0,
    '★ order 数组里也有它（yaml 字段顺序可读）',
  );

  const wh = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');
  check(/id="dm-enable"/.test(wh), '★★ 界面有启用开关');
  check(/id="dm-tagger"/.test(wh), '★★ 界面有触发词标签区');
  check(/id="dm-duration"/.test(wh), '★★ 界面有超时时长');
  check(/function renderDiceMode\(/.test(wh), '★ 有回填函数');
  check(/function saveDiceMode\(/.test(wh), '★ 有保存函数');
  // ⚠️ 复用现成组件（tagRow 那套），别另写一遍增删逻辑
  check(/tagsSync\('dm-enter'\)/.test(wh), '★ 复用了现成的 tagsSync（人设昵称那套）');
  check(/pjList\(\$\('dm-enter'\)\.value\)/.test(wh), '★ 保存时用 pjList 拆（对应「、」分隔）');
  // ⚠️ 分钟⇄毫秒：填错会变成 1 分钟 = 1000 分钟那种离谱值
  check(/durationMs: Math\.max\(0, Number\(\$\('dm-duration'\)\.value\) \|\| 0\) \* 60000/.test(wh),
    '★★ 界面填分钟、保存乘 60000 存毫秒（别搞反）');
  check(/\(Number\(d\.durationMs\) \|\| 0\) \/ 60000/.test(wh), '★★ 回填时除 60000 还原成分钟');
  // ⚠️ 切换 tab 时要调 —— 漏了就是「进页面标签是空的」
  check(
    /b\.dataset\.tab === 'groups'[^\n]*renderDiceMode\(\)/.test(wh),
    '★★ 切到 groups 页时会加载它（漏了标签是空的）',
  );
  // ⚠️ 密钥不能进界面。⚠️ 要**排除注释行**再查 —— 否则注释里那句
//    「为什么不把 sealdice.token 放进界面」自己就把它自己判红了。
  const htmlCode = wh
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
  check(!/sealdice[.\-_]?token/i.test(htmlCode), '★★ 界面**没有** sealdice token 的输入框');
  check(/id="dm-enter"|dm-enter/.test(htmlCode), '★ 但触发词那部分是有的（确认没误删整张卡）');
}

srv.close();
try { rmSync(join(ROOT, CFG_REL), { force: true }); } catch {}

console.log('\n【7】★★★ 跑团记录：独立分支 + 分群 + 增量读 + 压缩（照 observe/storyline 那套）');
{
  // ⚠️ 海豹的 log 是**三层**：群 → 局 → 消息。
  //    `logs/page` 返回**局列表**（id/name/groupId/…），`items/page` 才返回消息。
  //    一开始只调了前者就去读 x.message ⇒ 记进去全是空串 —— 这里两条都造出来验。
  const GAMES = [
    { id: 9, name: '第一局', groupId: '700000001', updatedAt: 2000, size: 5 },
    { id: 8, name: '别群的局', groupId: '700000002', updatedAt: 3000, size: 1 },
  ];
  const LINES = [
    { id: 1, nickname: '甲', message: '我要调查书房', isDice: false, time: 1000 },
    { id: 2, nickname: '骰子', message: '检定结果：成功（45）', isDice: true, time: 1001 },
    { id: 3, nickname: '别群的人', message: '这不该被记进来', isDice: false, time: 1002 },
    { id: 4, nickname: '乙', message: '我害怕', isDice: false, time: 1003 },
    { id: 5, nickname: '骰子', message: '理智检定：失败', isDice: true, time: 1004 },
    { id: 6, nickname: '甲', message: '我们逃出书房', isDice: false, time: 1005 },
  ];
  const srv2 = createServer((req, res) => {
    const u = req.url || '';
    res.setHeader('Content-Type', 'application/json');
    if (u.startsWith('/sd-api/story/logs/page')) {
      // ⚠️ 照海豹真实行为：groupId 是 **LIKE 部分匹配**，这里故意也返回别的群
      res.end(JSON.stringify({ data: GAMES, total: GAMES.length, result: true }));
      return;
    }
    if (u.startsWith('/sd-api/story/items/page')) {
      res.end(JSON.stringify(LINES));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const p2 = srv2.address().port;

  const { config } = await import('../src/config.js');
  config.sealdice.baseUrl = `http://127.0.0.1:${p2}`;
  // ⚠️ 功能是**默认关闭**的（用户要求「先写出来但是不启用」），测试里要显式打开
  config.diceLog.enable = true;
  config.diceLog.minIntervalMs = 0;
  config.diceLog.compress.minEntries = 3;
  config.diceLog.compress.minIntervalMs = 0;

  const D = await import('../src/dice-log.js');
  const G = '700000001';

  // ① 分群：海豹那边是 LIKE 部分匹配，必须自己精确过滤
  const S = await import('../src/sealdice.js');
  const { list: games } = await S.storyLogs({ groupId: G });
  check(games.length === 1, '★★★ 分群过滤生效（海豹 LIKE 会多返回别的群，这里只剩 1 局）', `实得 ${games.length}`);
  check(games[0]?.name === '第一局', '★ 拿到的是本群那一局');

  // ⚠️ items/page 必须同时带 groupId 和 logName，只给群号海豹返回空数组
  const noName = await S.storyItems({ groupId: G, logName: '' });
  check(noName.length === 0, '★★ 缺局名时直接返回空（海豹那样也是空数组，别白跑一趟）');
  const items = await S.storyItems({ groupId: G, logName: '第一局' });
  check(items.length === 6, '★ 带局名才拿得到消息行');

  // ② note：两级拉取
  const r1 = await D.note({ groupId: G, force: true });
  check(r1.added === 6, '★ 拉进来 6 条', `实得 ${r1.added}`);
  check(r1.game === '第一局', '★★ 记下了这是哪一局', r1.game);
  check(D.statsOf(G).items === 6, '★ 存了 6 条');

  // ⚠️ 这条是上一版的真 bug：局列表里没有 message，记进去全是空串
  check(
    D.recent(G, 50).every((x) => x.text.length > 0),
    '★★★ 记下来的**都不是空字符串**（局列表没有 message 字段这个坑）',
  );

  const r2 = await D.note({ groupId: G, force: true });
  check(r2.added === 0, '★★ 再拉一次**不重复吃**（按 id 去重）', `实得 ${r2.added}`);

  // ③ isDice 分出来（压缩时骰子输出不能当剧情改写）
  const diceRows = D.recent(G, 50).filter((x) => x.dice);
  check(diceRows.length === 2, '★ 两条骰子输出标成 dice=true', `实得 ${diceRows.length}`);
  check(diceRows[0].text.includes('45'), '★ 骰子行数值原样留着（不许改）');

  // ③ 压缩：没注入 runner ⇒ 干净失败，不抛
  let threw = false;
  try { await D.compress({ groupId: G, force: true }); } catch { threw = true; }
  check(!threw, '★★ 没注入模型调用时**不抛**（压缩是后台活，抛了会打断机器人）');

  // ④ 注入假 runner ⇒ 压出章节
  let seen = '';
  config.diceLog.__runner = async (sys, user) => {
    seen = sys + '\n' + user;
    return '```json\n{"chapters":[{"text":"第一局：调查书房，最终逃出。"}]}\n```';
  };
  const c1 = await D.compress({ groupId: G, force: true });
  check(c1.ok === true && c1.chapters === 1, '★ 压出 1 章', JSON.stringify(c1));
  check(seen.includes('骰子'), '★★ 喂给模型时**标出了哪些是骰子输出**（它不能被当剧情改写）');
  check(seen.includes('700000001') === false, '★★ 喂的内容里不含群号（模型不需要知道）');
  check(D.statsOf(G).items === 0, '★ 压完原始条目清空了（否则每轮都在压同一批）');
  check(D.statsOf(G).chapters === 1, '★ 章节存下来了');

  // ⑤ promptBlock 喂进提示词
  const pb = D.promptBlock(G);
  check(pb.includes('这一局跑过什么'), '★ promptBlock 有标题');
  check(pb.includes('调查书房'), '★ promptBlock 带上了章节内容');
  check(pb.includes('已经整理过'), '★ 明说了这是整理过的（模型不会当成原始流水）');

  // ⚠️ 没有章节时必须返回空串（不然会注入一个空标题）
  check(D.promptBlock('700000009') === '', '★★ 没数据的群返回**空串**（不注入空标题）');

  // ⑥ parseJson：模型很爱包 ```json
  check(D.parseJson('```json\n{"chapters":[{"text":"a"}]}\n```')?.chapters?.length === 1, '★ parseJson 能剥 ```json 壳');
  check(D.parseJson('{"chapters":[{"text":"a"}]}')?.chapters?.length === 1, '★ 裸 JSON 也能解');
  check(D.parseJson('完全不是 JSON') === null, '★ 解不了返回 null（不抛）');

  // ⑦ 提示词里有「数值不许改」那条铁律
  const P = D.COMPRESS_PROMPT;
  check(/数值不许改/.test(P), '★★★ 压缩提示词写明「掷骰数值不许改」');
  check(/不许把失败写成成功/.test(P), '★★★ 写明「不许把失败写成成功」（最容易被模型悄悄改掉的地方）');
  check(/一章 = 一件事/.test(P), '★ 写明「一章 = 一件事」');

  srv2.close();

  // ⑧ 默认必须**关闭**（用户要求「先写出来但是不启用」）
  const ex2 = readFileSync(join(ROOT, 'config.example.yml'), 'utf8');
  check(
    /diceLog:\s*\n(?:[^\n]*\n)*?\s*enable: false/.test(ex2),
    '★★★ 模板里 diceLog.enable 是 false（默认不启用）',
  );
  check(/^\s*groups: \[\]/m.test(ex2), '★★ groups 默认空（不填就不去拉 log）');
  const cjs = readFileSync(join(ROOT, 'src', 'config.js'), 'utf8');
  check(
    /cfg\.diceLog\.enable = cfg\.diceLog\.enable === true;/.test(cjs),
    '★★★ config.js 里是 `=== true`（默认关；写成 `!== false` 会默认**开**，那就违背了）',
  );
  const dij = readFileSync(join(ROOT, 'src', 'dice-log.js'), 'utf8');
  check(
    /return cfg\(\)\.enable === true;/.test(dij),
    '★★ dice-log.js 的 enabled() 与 config.js 判据一致（别两处不同）',
  );
  // ⚠️ index.js 的接线必须整段在 `if (…enable === true)` 里 ⇒ 关闭时零调用
  const ij = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  check(/config\.diceLog\?\.enable === true/.test(ij), '★★ index.js 的接线整段在开关里（关闭时不注入 runner、不注册定时器）');
  check(/diceLog\.reload\(\)/.test(ij), '★ 启用时才 reload 状态');
  check(/__runner\s*=/.test(ij), '★ 启用时才注入 __runner（关闭时 compress 会干净返回，不花钱）');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
  // ⚠️ 钉住「前导点和命令名要原样传」—— 小祥只是转发，不能自己改写
  const b = JSON.parse(exec.body);
  check(b.message === '.ra 3d6', '★ 消息原样传给海豹（不吞掉前导点）', `实得「${b.message}」`);
  check(b.messageType === 'group', '★ messageType 传了 group');
  check(!!b.id, '★ 带上了 scopeId（海豹用它决定发到哪、记到哪）');
}
// ── 配置必须在 import src/* 之前就位 ────────────────────


