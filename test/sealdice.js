/**
 * 海豹骰（SealDice）客户端的回归（2026-09-30，方案「甲」）。
 *
 * ## 用户需求
 *   「群里发 .ra 之类小祥能答」+「小祥和海豹最后要落到同一个账号收发消息」
 *
 * ## 方案：默认「海豹不接 IM」，但同号接 IM 也是可行的（2026-10-06 更正）
 *   小祥主动调海豹的 HTTP API（`relay: true`）⇒ 海豹只做骰点引擎 + log。
 *   ⚠️ 当初「海豹绝不能接 IM，否则自反馈死循环 / 抢连接」的理由**经读源码已证伪**：
 *     · NapCat 的 WS 服务端支持多客户端（`napcat.mjs:95223`）
 *     · 海豹自己会丢弃同号发来的消息（`platform_adapter_gocq.go:1064`）
 *   ⇒ 用户 2026-10-06 拍板走**同号**（没有小号）。唯一真实的副作用是
 *     **「重复处理」**（两条骰点结果），由 `sealdice.relay` 开关解决。
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
    // ⚠️ `relay: fallback` 的在线探针打的就是这个（唯一免 token 的接口）
    if (u === '/sd-api/preInfo') { res.end(JSON.stringify({ result: true })); return; }
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

console.log('\n【5】★★ 方案约束：同号接 IM 的三条「硬约束」已证伪 + 防重复转述');
{
  // ⚠️⚠️ 2026-10-06 **整段重写**。原来这里钉的是「不接 IM，因为自反馈死循环」。
  //    那条理由**经读源码证伪**，继续钉它等于把错的结论写死成"不变式"。
  //    真正的三个依据（ NapCat 多客户端 / 海豹丢弃自己的消息 / 重复处理）如下。
  const js = readFileSync(join(ROOT, 'src', 'sealdice.js'), 'utf8');
  check(/已证伪/.test(js), '★★ 模块注释里标出了「已证伪」并给了源码依据');
  // ⚠️ 证伪的两条必须**带出处**，否则下次有人又会凭印象写回去
  check(
    /platform_adapter_gocq\.go:1064/.test(js) && /napcat\.mjs:95223/.test(js),
    '★★ 证伪结论引用了具体源码位置（gocq.go:1064 / napcat.mjs:95223）',
  );
  check(
    !/缘由是一条架构级的硬约束/.test(js),
    '★★ 旧的那句「架构级硬约束 / 调参解决不了」已被移除',
  );

  const botjs = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  // ⚠️ 仍然要守的不变式：**不把海豹塞进 onebot 配置段**（那是另一回事 ——
  //   海豹走 HTTP API，不占 OneBot 连接）。这条断言继续有效。
  const ob = botjs.slice(botjs.indexOf('onebot'), botjs.indexOf('onebot') + 800);
  check(!/sealdice/i.test(ob), '★★ **OneBot 那一段没混入 sealdice**（海豹走 HTTP，不占 OneBot 连接）');
  check(
    !/onebot[\s\S]{0,400}sealdice|sealdice[\s\S]{0,400}onebot/i.test(ob),
    '★★ 海豹和 onebot 配置不相邻（防止有人把两者塞进同一段）',
  );

  // ⚠️ 防「两条结果」：海豹自己接 IM 时小祥必须闭嘴，但仍要**消费掉**那条指令
  const h = botjs.slice(botjs.indexOf('async handleDiceMode'), botjs.indexOf('async handleDiceMode') + 3000);
  check(
    /sealdice\.shouldRelay\(/.test(h),
    '★★ handleDiceMode 里用 shouldRelay() 判「这条要不要由我转述」',
  );
  check(
    /shouldRelay[\s\S]{0,400}?return true/.test(h),
    '★★ 不转述时**照样 return true**（消费掉指令，别掉进 decide() 让她评论骰点）',
  );

  const ex = readFileSync(join(ROOT, 'config.example.yml'), 'utf8');
  check(/token: ''/.test(ex), '★★ 模板里 token 是空的 ⇒ 照模板配的人不会被意外启用');
  check(/^\s*relay:\s*true\s*$/m.test(ex), '★★ 模板里 relay 默认 true（不改变现有行为）');
}

console.log('\n【6】★★ relay 开关：海豹接了同号 IM 时不许重复回（2026-10-06）');
{
  // ⚠️ 这是「重复处理」那条**唯一真实**的副作用的对策，必须钉住行为本身，
  //    不能只靠注释。上游 12 行断言只验了「代码里写了 shouldRelay」，
  //    这里验的是**三种模式各自返回什么**。
  const savedRelay = config.sealdice.relay;

  // ① 默认 / true = 海豹不接 IM ⇒ 小祥转述
  config.sealdice.relay = true;
  check((await S.shouldRelay('group')) === true, '★★ relay=true ⇒ 由小祥转述（海豹不接 IM）');

  // ② false = 海豹自己收发 ⇒ 小祥闭嘴。⚠️ 这一条是防「两条结果」的核心。
  config.sealdice.relay = false;
  check(
    (await S.shouldRelay('group')) === false,
    '★★ relay=false ⇒ **小祥不转述**（否则海豹自己回一次 + 小祥回一次 = 两条）',
  );
  // ⚠️ 关键：不转述时**绝不能打海豹**。探一下有没有发网络请求。
  hits = [];
  await S.shouldRelay('group');
  check(hits.length === 0, '★★ relay=false 时一次网络请求都不发（不做在线探针，白跑一趟）');

  // ③ fallback = 海豹接了 IM，但离线时小祥兜底
  config.sealdice.relay = 'fallback';
  // 假海豹在线（上面加了 /sd-api/preInfo）⇒ 让位给海豹
  check((await S.shouldRelay('group')) === false, '★★ fallback + 海豹在线 ⇒ 让位，小祥不转述');
  hits = [];
  await S.shouldRelay('group');
  check(
    hits.some((h) => h.url === '/sd-api/preInfo'),
    '★ fallback 是靠打 /sd-api/preInfo 探在线的',
  );
  // ⚠️ 海豹探不通 ⇒ 兜底转述（宁可多转述，也别让群里的骰点没人应）
  const savedUrl2 = config.sealdice.baseUrl;
  config.sealdice.baseUrl = 'http://127.0.0.1:1';
  check((await S.shouldRelay('group')) === true, '★★ fallback + 海豹探不通 ⇒ 小祥兜底转述');
  config.sealdice.baseUrl = savedUrl2;

  // ⚠️ 没配这个键（老部署）必须还是转述，否则升级即回归
  delete config.sealdice.relay;
  check((await S.shouldRelay('group')) === true, '★★ 没配 relay（老配置）⇒ 仍转述，不回归');
  config.sealdice.relay = savedRelay;

  check(typeof S.shouldRelay === 'function', '★ 导出 shouldRelay()（bot.js 的唯一判定入口）');
}

console.log('\n【6.5】★★ relay 做进了 WebUI（2026-10-06）');
{
  const wj = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  const wh = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');

  // ⚠️ 「存得进去、显示不出来」的坑踩过一次（webui.js 自己注释里写了）：
  //    configForUi（读）和 saveConfig（写）**必须成对**。缺一个就是那种诡异 bug。
  const ui = wj.slice(wj.indexOf('function configForUi'), wj.indexOf('function saveConfig'));
  const sv = wj.slice(wj.indexOf('function saveConfig'), wj.indexOf('function saveConfig') + 6000);
  check(/sealdice:\s*\{/.test(ui), '★★ configForUi 里有 sealdice 段（界面读得到）');
  check(/relay/.test(ui), '★★ configForUi 回填 relay');
  check(/raw\.sealdice\.relay/.test(sv), '★★ saveConfig 里写 sealdice.relay（界面存得进去）');

  // ⚠️⚠️ **token 绝不能进界面**：`/api/config` 是明文 JSON，
  //    把本机密钥吐出去等于泄密。两处都要守住。
  //
  // ⚠️⚠️ 这两条断言**必须先剥掉注释行**再查 —— 否则它们会匹配到注释里
  //    自己写的「绝不能带 token」「别写 put('sealdice', …)」这些字，
  //    测出一个假的失败。（真踩过：第一次写没剥，红了，去掉才发现代码本来就是干净的。）
  //    代码里没有，但注释里有 —— 那正是要守住的东西，所以只查代码。
  const stripComments = (s) =>
    s.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  const uiCode = stripComments(ui);
  const svCode = stripComments(sv);
  check(!/token/.test(uiCode), '★★ configForUi **不含 token**（密钥不进 /api/config）');
  check(
    !/put\(\s*'sealdice'/.test(svCode),
    '★★⚠️ saveConfig 不用 `put(\'sealdice\', …)`（那等于让请求体覆盖 token）',
  );
  // ⚠️ 反向也钉一下：sealdice 段确实被写了（别为了躲上一条把功能删了）
  check(
    /raw\.sealdice\.relay/.test(svCode),
    '★★ 但 sealdice.relay 确实被写进去了（白名单式，不是没写）',
  );
  check(/=== false \? false/.test(svCode), '★★ 写入前归一化到三态（非法值不落 yaml）');

  // ⚠️ 三个选项都要在，且 fallback 是推荐项
  check(/id="sd-relay"/.test(wh), '★ 界面有 relay 的 select');
  check(/value="true"/.test(wh) && /value="false"/.test(wh) && /value="fallback"/.test(wh),
    '★★ 三个选项都在（true / false / fallback）');
  check(/saveSealdiceRelay/.test(wh) && /renderSealdiceRelay/.test(wh),
    '★ 保存 / 放弃修改两个按钮的函数都在');
  check(/dataset\.tab === 'groups'[\s\S]{0,200}renderSealdiceRelay/.test(wh),
    '★★ 进 groups 页时会调 renderSealdiceRelay（漏了就显示不出当前值）');
  // ⚠️ 独立一张卡：共用 save 会变成「改触发词顺带改了海豹开关」
  check(
    (wh.match(/onclick="saveDiceMode\(\)"/g) || []).length === 1
      && (wh.match(/onclick="saveSealdiceRelay\(\)"/g) || []).length === 1,
    '★★ 骰娘卡和海豹卡各自独立保存（不会顺带改对方）',
  );
}

console.log('\n【7】★★ 触发词在界面上可改（用户要求）');
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
  // ⚠️⚠️ 这里用 `[\s\S]{0,200}` 而不是 `[^\n]*`：2026-10-06 那行被拆成多行
  //    （加了 renderSealdiceRelay 之后单行太长了），`[^\n]*` 会匹配不到。
  //    别为了让这条断言过就把代码拼回一行 —— 那是把新调用挤出检查范围。
  check(
    /b\.dataset\.tab === 'groups'[\s\S]{0,200}renderDiceMode\(\)/.test(wh),
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

  // ⚠️⚠️ 2026-10-06 加：**真的把 renderDiceMode() 跑一遍**。
  //
  //  为什么非要执行、不能只查字符串：上面那些断言查的是「代码里写了 dm-enter」，
  //  而「触发词输入框不出现」这个 bug **照样能全过** —— 因为 renderDiceMode
  //  一进去就抛 `hintSplit is not defined`（它是 personaRenderFields 的局部 const），
  //  错误被自己的 catch 吞掉、只 flash 一行，**`dm-tagger` 一直是空的**。
  //  ⇒ 页面不炸、静态断言全绿、只有真人用的时候才发现。
  //  ⇒ 所以这条必须**执行**：给它最小 DOM + 假 api，看 dm-tagger 到底填没填上。
  const scriptBody = wh.slice(wh.indexOf('<script>') + 8, wh.lastIndexOf('</script>'));
  const grabFn = (name) => {
    const i = scriptBody.indexOf('async function ' + name);
    if (i < 0) return '';
    let d = 0;
    for (let k = scriptBody.indexOf('{', i); k < scriptBody.length; k++) {
      if (scriptBody[k] === '{') d++;
      else if (scriptBody[k] === '}') { d--; if (!d) return scriptBody.slice(i, k + 1); }
    }
    return '';
  };
  // ⚠️ 这里用**括号配对**找 `hintSplit` 的结尾，**别用 `indexOf('};')`** ——
  //    它会先匹配到函数体里那句 `return { ph: '', tip: '' };`，切出一段残缺的代码。
  //    （真踩过：切出来的东西报 `Unexpected token ')'`。）
  const pa = scriptBody.indexOf('const escHtml =');
  const pb = scriptBody.indexOf('const hintSplit =');
  let depth = 0;
  let pe = -1;
  for (let k = scriptBody.indexOf('{', pb); k < scriptBody.length; k++) {
    if (scriptBody[k] === '{') depth++;
    else if (scriptBody[k] === '}') {
      depth--;
      if (depth === 0) { pe = k; break; }
    }
  }
  const prelude = scriptBody.slice(pa, pe + 1);
  const store = {};
  const $stub = (id) => store[id] ?? (store[id] = { id, innerHTML: '', value: '', checked: false, textContent: '', style: {} });
  globalThis.document = {
    getElementById: $stub,
    createElement: () => ({ innerHTML: '', value: '', style: {}, setAttribute() {}, classList: { add() {}, remove() {} }, appendChild() {} }),
  };
  let flashText = '';
  const apiStub = async () => ({
    ok: true,
    config: { diceMode: { enable: true, durationMs: 0, enterKeys: ['骰娘'], exitKeys: ['散场'], skipDiceKeys: [] } },
  });
  try {
    const run = new Function('$', 'flash', 'api', 'tagsSync', `${prelude}\n${grabFn('renderDiceMode')}\nreturn renderDiceMode;`);
    // ⚠️ 这里传 `$stub`，不是 `$` —— 写 `run($, …)` 会因为 `$` 没定义而抛
    //    `$ is not defined`（真踩过，症状跟被测的 bug 一模一样，极易误判成"没修好"）。
    await run($stub, (el, ok, t) => { flashText += `[${ok ? 'ok' : 'err'}] ${t} `; }, apiStub, () => {})();
    check(!/err/.test(flashText), '★★★ renderDiceMode 不抛错（能被 catch 吞掉的那种也不行）', flashText);
    const box = store['dm-tagger']?.innerHTML ?? '';
    check(box.length > 0, '★★★ `dm-tagger` 真被填上了（触发词输入框会出现）', `长度 ${box.length}`);
    check(
      box.includes('dm-enter') && box.includes('dm-exit') && box.includes('dm-skip'),
      '★★★ 进去/退出/排除三个触发词输入框都在',
    );
    check(box.includes('骰娘'), '★★ 配置里的触发词被回填进去了（不是空框）');
  } catch (e) {
    check(false, '★★★ 真跑一遍 renderDiceMode', e.message);
  }
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


