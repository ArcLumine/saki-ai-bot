/**
 * 合并转发（2026-10-20 用户报「sakibot 读不了合并转发」）。
 *
 * 现场日志（用户群里实测）：
 *   06:27:03 群友发合并转发（没 @ 她）→ 机器人只记了个 `[合并转发]` 占位
 *   06:27:15「小祥看这个转发」→ 她回「你那个转发到我这儿就剩一行字，我什么都看不到」
 *
 * 根因**不是**取不到（`get_forward_msg` 实测能取到，见【2】的假对端）——
 * 而是**展开动作只写在"要回复"的那条路径里**：转发那条没 @ 她、不进回复流程
 * ⇒ 没人展开 ⇒ 下一句追问时 `lastForward` 缓存是空的。
 * ⇒ 修法：收到带转发的消息就**先展开并缓存**（handle 里那段），下一条追问直接用得上。
 *
 * 这个套件盯四件（全离线，不联网、不花钱）：
 *   ① `forwardNodeText` 认得各家 `get_forward_msg` 的返回结构
 *   ② `expandForwards` 的参数名兜底（只认 `message_id` 的对端也能取到）
 *   ③ 同一条转发**按 id 缓存**，第二次不再打 API
 *   ④ 取不到时**给占位说明、不许编内容**（这条比"能取到"更重要）
 *
 * 用法: node test/forward.js
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ⚠️ 这里**不写临时配置**：DSH 沙盒给子进程的令牌在 `logs/` 下没有写权限
//    （报 EPERM），而本套件只需要 import 两个模块、不连网、不落盘。
//    读真实 config.yml 只读不写，跑起来没问题（日志写失败会自动降级到控制台）。
const { Bot } = await import('../src/bot.js');
const { forwardNodeText } = await import('../src/message.js');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// ════════════════════════════════════════════════════════════
// 【1】纯函数：各家返回结构都要认
// ════════════════════════════════════════════════════════════
console.log('\n【1】forwardNodeText：返回结构兼容');
{
  const t1 = forwardNodeText({
    messages: [{ sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '你好' } }] }],
  });
  check(t1 === '甲：你好', 'messages + message（最常见的那种）', JSON.stringify(t1));

  const t2 = forwardNodeText({
    message: [{ nickname: '乙', message: [{ type: 'text', data: { text: '在' } }] }],
  });
  check(t2 === '乙：在', 'message 包一层', JSON.stringify(t2));

  const t3 = forwardNodeText([
    { type: 'node', data: { nickname: '丙', message: [{ type: 'text', data: { text: '哈' } }] } },
  ]);
  check(t3 === '丙：哈', '数组 + node 包装（SnowLuma 一类）', JSON.stringify(t3));

  const t4 = forwardNodeText({
    messages: [{ sender: { card: '丁' }, content: [{ type: 'text', data: { text: '呃' } }] }],
  });
  check(t4 === '丁：呃', 'content 而不是 message', JSON.stringify(t4));

  const t5 = forwardNodeText({ messages: [{ nickname: '戊', message: { type: 'text', data: { text: '单段' } } }] });
  check(t5 === '戊：单段', 'message 是单个段对象（不是数组）', JSON.stringify(t5));

  check(forwardNodeText(null) === '' && forwardNodeText({}) === '', '空返回不炸、返回空串');
}

// ════════════════════════════════════════════════════════════
// 【2】expandForwards：参数名兜底 / 缓存 / 取不到时的说法
// ════════════════════════════════════════════════════════════
const EVENT = { message: [{ type: 'forward', data: { id: '7770001' } }] };
const NODES = { messages: [{ nickname: '甲', message: [{ type: 'text', data: { text: '转发里的真内容' } }] }] };

/** 造一个"只够 expandForwards 用"的假 Bot（不跑构造函数、不连网） */
function fakeBot(call) {
  const b = Object.create(Bot.prototype);
  b._fwdCache = new Map();
  b.lastForward = new Map();
  b.call = call;
  return b;
}

console.log('\n【2】参数名兜底（只认 message_id 的对端）');
{
  const calls = [];
  const b = fakeBot(async (action, params) => {
    calls.push({ action, params });
    // 模拟"只认 message_id、见到 id 就报错"的实现
    if (params.id !== undefined && params.message_id === undefined) throw new Error('invalid param: id');
    return { status: 'ok', data: NODES };
  });
  const out = await b.expandForwards(EVENT);
  check(calls.length === 1, '第一次就成功了（两个参数一起传）', `调用 ${calls.length} 次`);
  check(out.includes('转发里的真内容'), '正文真的进了提示词');
  check(out.includes('看得到'), '并明确告诉她「你看得到」（不许再说看不到）');
}

console.log('\n【3】同一条转发按 id 缓存，第二次不再打 API');
{
  let n = 0;
  const b = fakeBot(async () => {
    n++;
    return { status: 'ok', data: NODES };
  });
  const a1 = await b.expandForwards(EVENT);
  const a2 = await b.expandForwards(EVENT);
  check(n === 1, `只调了 1 次 API（实际 ${n} 次）`);
  check(a1 === a2, '两次输出一致');
  check(a1.includes('转发里的真内容'), '缓存里取到的仍然是真内容');
}

console.log('\n【4】取不到时：给说明，不许编内容');
{
  const b = fakeBot(async () => {
    throw new Error('boom');
  });
  const out = await b.expandForwards(EVENT);
  check(out.includes('没取到内容'), '明确说没取到');
  check(/别猜/.test(out), '并禁止她猜内容');
  check(!out.includes('真实内容'), '没有把「以下是真实内容」这段话放出去');
}

// ════════════════════════════════════════════════════════════
console.log('\n【5】源码接线：收到带转发的消息就预展开（handle 里那段）');
{
  const src = readFileSync(join(ROOT, 'src/bot.js'), 'utf8');
  check(/forwardIds\(msg\.toSegments\(payload\.message\)\)\.length/.test(src), 'handle 里能识别到转发段');
  check(/预展开合并转发失败/.test(src), '预展开失败有 warn（不是静默吞掉）');
  check(/rememberForward\(history\.sessionKey\(payload\)/.test(src), '预展开结果会进 lastForward 缓存');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
