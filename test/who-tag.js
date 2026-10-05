/**
 * `src/who.js` —— 「谁说的」统一格式。
 *
 * ⚠️ 2026-10-04 加（用户要求：「群聊私聊都是收到同一个格式的提示」）。
 *   改造前全项目有 **5 种**写法表示同一个人：
 *     `昵称(QQ号)` / `昵称（QQ 号）` / `**昵称**（QQ 号，昵称「…」）`
 *     / `[QQ 号] 昵称` / 压根不带号
 *   ⇒ 模型看到两种括号会当成两种语义，认人也全靠赌。
 *   现在统一成 `昵称(QQ号)`，谁说的都走 `who.js`。
 *
 * 纯函数、不联网、不花钱，几毫秒跑完。
 */
import { whoTag, senderTag } from '../src/who.js';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !extra ? '' : `\n      实际：${extra}`}`);
  if (!ok) failures++;
};

console.log('\n【1】标准形态');
check(whoTag('大豆', '123456789') === '大豆(123456789)', '昵称+号 → 昵称(QQ号)', whoTag('大豆', '123456789'));
check(!whoTag('大豆', '123456789').includes('（'), '用的是**半角**括号', whoTag('大豆', '123456789'));

console.log('\n【2】缺东西时的降级（不能炸，更不能出空括号）');
check(whoTag('大豆', '') === '大豆', '没号 → 只剩昵称', whoTag('大豆', ''));
check(whoTag('', '123456789') === '123456789', '没昵称 → 只剩号', whoTag('', '123456789'));
check(whoTag('', '') === '', '两个都没有 → 空串', JSON.stringify(whoTag('', '')));
check(whoTag('大豆', null) === '大豆', 'null 号当没有', whoTag('大豆', null));
check(whoTag(undefined, undefined) === '', '全 undefined 不炸', JSON.stringify(whoTag(undefined, undefined)));
check(
  whoTag('123456789', '123456789') === '123456789',
  '昵称就是号 → 不渲染成 `123(123)`',
  whoTag('123456789', '123456789'),
);
check(!whoTag('甲', '').includes('()'), '不会渲染出空括号', whoTag('甲', ''));

console.log('\n【3】数字型入参（NapCat 有时给 number）');
check(whoTag('大豆', 123456789) === '大豆(123456789)', 'number 号照样能用', whoTag('大豆', 123456789));

console.log('\n【4】senderTag：群名片优先于昵称');
check(
  senderTag({ user_id: '1', sender: { card: '群名片', nickname: '昵称' } }) === '群名片(1)',
  '有群名片就用群名片',
  senderTag({ user_id: '1', sender: { card: '群名片', nickname: '昵称' } }),
);
check(
  senderTag({ user_id: '1', sender: { nickname: '昵称' } }) === '昵称(1)',
  '没群名片才用昵称',
  senderTag({ user_id: '1', sender: { nickname: '昵称' } }),
);
check(senderTag({ user_id: '1' }) === '1', '连 sender 都没有 → 纯号', senderTag({ user_id: '1' }));
check(senderTag({}) === '', '空事件不炸', JSON.stringify(senderTag({})));
check(senderTag(null) === '', 'null 事件不炸', JSON.stringify(senderTag(null)));

console.log('\n【5】群聊私聊格式一致（用户明确要求的核心）');
const g = senderTag({ user_id: '123', sender: { nickname: '甲' } });
const p = senderTag({ message_type: 'private', user_id: '123', sender: { nickname: '甲' } });
check(g === p, '同一个人在群聊和私聊里格式完全相同', `群=${g} 私=${p}`);

// ⚠️ 收尾语**必须**是「全部通过」—— `run-all.js` 就是靠这个关键词判绿的
//    （`r.result.includes('全部通过')`，见那边第 504 行）。别改成别的说法。
console.log(`\n结果: ${failures ? `${failures} 项失败 ❌` : '全部通过 ✅'}`);
process.exit(failures ? 1 : 0);
