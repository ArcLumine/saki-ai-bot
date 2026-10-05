/**
 * 骰娘模式的回归（2026-09-30）。
 *
 * ## 用户需求（原话）
 *   「小祥日常的时候依旧回话，只有通过某些触发词才会触发骰娘模式，
 *     并且在当骰娘的时候全程静默」
 *   「进入骰娘模式，别人发 ra 之类的指令，她只会回复骰点结果。
 *     其他的情况下全程静默」
 *
 * ⚠️⚠️ 后半句是关键：**骰娘模式不是"全哑"，是"只做骰子这一件事"**。
 *   一开始按"全哑"理解就错了 —— 全哑的话没人算骰，那一局根本没法跑。
 *
 * ## 这组测试盯什么
 *   最要紧的不是状态机本身，而是**三处拦截点全都在**。
 *   小祥「说话」有三个入口：`decide()` / 复读 / `onRaw` 里的就地认指令。
 *   漏一处 → 表现是「她还是会复读 / 还是会冒一句」，而且只在特定群里偶发，
 *   **最难复现也最难查**。所以这里逐个验，而不是只验状态机。
 *
 * ⚠️ 纯离线：状态文件指到 logs/，不碰真 state/。
 *
 * 用法: node test/dice-mode.js
 */
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const CFG_REL = 'logs/__test-dicemode.yml';
const STATE_REL = 'logs/__test-dicemode-state.json';
const STATE = join(ROOT, STATE_REL);
rmSync(STATE, { force: true });

writeFileSync(
  join(ROOT, CFG_REL),
  [
    'llm:',
    '  baseURL: http://127.0.0.1:1/v1',
    '  apiKey: "sk-test"',
    '  model: test-model',
    'diceMode:',
    '  enable: true',
    '  enterKeys: ["骰娘", "当骰娘"]',
    '  exitKeys: ["散场", "收摊"]',
    '  durationMs: 0',
    'sealdice:',
    '  enable: false',
    '',
  ].join('\n'),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
process.env.QQBOT_DICE_MODE_FILE = STATE_REL;

const M = await import('../src/dice-mode.js');
const { config } = await import('../src/config.js');
const ev = (gid = '400000001', type = 'group') => ({
  message_type: type,
  group_id: gid,
  user_id: '400000002',
  sender: { nickname: '服主', card: '' },
});

console.log('\n【1】★★ 触发词：必须整句相等（这是状态开关，不是关键词）');
{
  const c = { enterKeys: ['骰娘', '当骰娘'], exitKeys: ['散场', '收摊'] };
  check(M.matchTrigger('骰娘', c)?.act === 'on', '★ 「骰娘」⇒ 进');
  check(M.matchTrigger('当骰娘', c)?.act === 'on', '★ 「当骰娘」⇒ 进');
  check(M.matchTrigger('散场', c)?.act === 'off', '★ 「散场」⇒ 出');
  check(M.matchTrigger('收摊', c)?.act === 'off', '★ 「收摊」⇒ 出');
  // ⚠️ 这几条是本组最要紧的负向断言：用 includes 就会全中，
  //    而"群里正好在吵架"时误进骰娘模式，比误判安静指令更糟（那个只是闭嘴）
  check(M.matchTrigger('今天散场了吧', c) === null, '★★ 「今天散场了吧」**不触发**（整句相等，不是 includes）');
  check(M.matchTrigger('骰娘好可爱', c) === null, '★★ 「骰娘好可爱」不触发');
  check(M.matchTrigger('随便聊聊', c) === null, '★ 普通闲聊不触发');
  check(M.matchTrigger('', c) === null, '★ 空串不触发');
  // ⚠️ 空格容忍：QQ 上有人会打成「骰娘 」带个空格
  check(M.matchTrigger(' 骰娘 ', c)?.act === 'on', '★ 前后空格容忍');
}

console.log('\n【2】★★ 骰点指令识别（骰娘模式下唯一的开口理由）');
{
  const c = {};
  for (const t of ['.ra 3d6', '.r d100', '.rb', '.rd', '/st 1d10']) {
    check(M.isDiceCommand(t, c), `★ 「${t}」算骰点指令`);
  }
  // ⚠️ 这几条要是判错，群里日常聊天会被转给海豹 —— 白花网络往返还可能被海豹回一句
  check(!M.isDiceCommand('今天心情不错', c), '★★ 普通聊天不算指令');
  check(!M.isDiceCommand('。今天下雨', c), '★★ 中文句号开头不算（容易误判）');
  check(!M.isDiceCommand('.', c), '★★ 单个「.」不算（后面必须有命令词）');
  check(!M.isDiceCommand('', c), '★ 空串不算');
  // ⚠️ 前缀不只「.」：海豹也认「/」
  check(M.isDiceCommand('/help', c), '★ 「/help」也算（海豹认这个前缀）');
  // ⚠️ 黑名单可配
  check(!M.isDiceCommand('.ra', { skipDiceKeys: ['.ra'] }), '★ skipDiceKeys 能排除某条');
}

console.log('\n【3】★★ 状态机：进出 / 超时 / 分群');
{
  check(M.isOn(ev()) === false, '★ 一开始不在骰娘模式');
  M.turnOn(ev('500000001'));
  check(M.isOn(ev('500000001')) === true, '★ 进了 A 群');
  check(M.isOn(ev('500000002')) === false, '★★ B 群**没**跟着进（分群各判各的）');
  check(M.isOn(ev('500000001', 'private')) === false, '★★ 私聊**永远不算**骰娘模式');
  check(M.onGroups().includes('500000001'), '★ 列表里有 A 群');

  // ⚠️ 超时自动退（durationMs=0 = 永不自动退）
  M.turnOn(ev('500000003'), 1); // 1ms 后就该醒
  await new Promise((r) => setTimeout(r, 20));
  check(M.isOn(ev('500000003')) === false, '★★ 到点自动退出');
  check(!M.onGroups().includes('500000003'), '★ 过期的顺手清掉了（别让文件越攒越多）');

  // ⚠️ 没开过就退出 ⇒ 返回 null（调用方据此说「本来就没在当」）
  check(M.turnOff(ev('500000009')) === null, '★ 没开过就退出 ⇒ 返回 null（别假装成功）');
  check(M.turnOff(ev('500000001')) !== null, '★ 开着时退出返回原状态');
  check(M.isOn(ev('500000001')) === false, '★ 退出后不在模式里');
}

console.log('\n【5】★★★★ 三处拦截点全都在（最要紧的一组）');
{
  // ⚠️⚠️ 小祥「说话」有三个入口，**漏一处 = 她还是会冒一句**，
  //    而且只在特定群里偶发，最难复现。所以这里逐个验，不只验状态机。
  const bj = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');

  // ① decide()：最前面就要拦，且要在「骂她妈妈」那条之前
  const dec = bj.slice(bj.indexOf('  decide(event, voluntary'), bj.indexOf('  decide(event, voluntary') + 2600);
  check(/this\.isDiceMode\(event\)/.test(dec), '★★ decide() 里调了 isDiceMode');
  check(/diceMode\.isDiceCommand\(/.test(dec), '★★ decide() 用 isDiceCommand 判「这句能不能开口」');
  check(
    dec.indexOf('isDiceMode') < dec.indexOf('swearAtMom'),
    '★★ 放在「骂她妈妈」那条**之前**（用户显式下的令高于自动判定）',
  );
  check(
    /isDiceCommand\([\s\S]{0,300}?return null/.test(dec),
    '★★ 判完「不能开口」就 return null',
  );

  // ② 复读：复读也是"说话"
  // ⚠️ 用 `Math.random() < v.chance` 这段整块来找（`v.join && v.say` 会被注释行切到）
  const repAt = bj.indexOf('Math.random() < v.chance');
  const rep = bj.slice(repAt - 200, repAt + 200);
  check(/!this\.isDiceMode\(payload\)/.test(rep), '★★ 复读那一路也判了骰娘模式');
  check(
    repAt < rep.indexOf('isDiceMode') + repAt,
    '★ 判据放在概率判断**之后**（不然 random 那一支不执行，调概率会踩坑）',
  );

  // ③ onRaw：就地认指令（开关 + 骰点转述都在这儿）
  const raw = bj.slice(bj.indexOf('await this.handleDiceMode'), bj.indexOf('await this.handleDiceMode') + 400);
  check(/handleDiceMode\(payload, text\)/.test(bj), '★★ onRaw 里调了 handleDiceMode');
  check(
    bj.indexOf('await this.handleQuiet(payload, text)') < bj.indexOf('await this.handleDiceMode(payload, text)'),
    '★ 排在安静指令**之后**（两者语义不同，不能互相吞）',
  );

  // 权限：必须复用 canTeach()（用户明确「权限和安静指令一致」）
  const h = bj.slice(bj.indexOf('async handleDiceMode'), bj.indexOf('async handleDiceMode') + 2000);
  check(/this\.canTeach\(event\)/.test(h), '★★ handleDiceMode 用 canTeach() 判权限（同安静指令）');

  // 转述：只在骰娘模式下做
  check(/if \(!this\.isDiceMode\(event\)\) return false;/.test(h), '★★ 不在骰娘模式 ⇒ 不转述骰点');
  check(/sealdice\.ask\(/.test(h), '★ 转述走 sealdice.ask()');
  // ⚠️ 海豹没配时也必须**消费掉**这条，否则它会当普通消息走 decide
  check(/if \(!sealdice\.enabled\(\)\)/.test(h), '★ 海豹没启用时有专门分支');
  check(/!sealdice\.enabled\(\)\)[\s\S]{0,400}?return true/.test(h), '★★ 海豹没启用时**仍然消费掉**这条（别让它当普通消息走）');
}

console.log('\n【6】★ 重启后回归日常（用户要求）');
{
  // ⚠️ 用户原话：「重启之后回归日常」。所以**正常启动路径不许调 loadDiceMode**。
  const bj = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  check(!/loadDiceMode\(\)/.test(bj), '★★ bot.js 启动路径**没有**读 dice-mode 状态 ⇒ 重启回日常');

  // ⚠️ 先重新开一个再验落盘 —— 上面【4】组把 enable 关过一轮，
  //    那个分支下 `turnOn` 之前已经退出了，这里要一个确定还在的状态。
  M.turnOn(ev('600000001'));
  check(M.stateOf('600000001') !== null, '★ 状态落在内存里（UI 可查）');
  const fs = readFileSync(STATE, 'utf8');
  check(fs.includes('600000001'), '★ 也落了盘（给 WebUI 展示「上次哪个群开的」）');
  // ⚠️ 落盘里的群号必须是**字符串键**（JSON 的 object key 只能是字符串）
  check(/"600000001":\s*\{/.test(fs), '★ 落盘的键是字符串形式（JSON 要求）');
}

rmSync(STATE, { force: true });
rmSync(join(ROOT, CFG_REL), { force: true });

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
console.log('\n【4】★★ 关掉功能 ⇒ 一切都当没开');
{
  M.turnOn(ev('500000004'));
  config.diceMode.enable = false;
  check(M.isOn(ev('500000004')) === false, '★★ enable=false 时即便有状态也当没开');
  config.diceMode.enable = true;
  check(M.isOn(ev('500000004')) === true, '★ 改回来又生效');
}