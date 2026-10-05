/**
 * Groq 真机验收的精简人设门禁（纯离线，不联网）。
 *
 * 重点不是「文件存在」，而是：
 *   - 精简稿保留验收需要的核心规则；
 *   - identity.json 仍来自真实 Saki；
 *   - 三个真机套件确实使用精简人设；
 *   - 辅助函数绝不写回生产 personas/saki/。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLivePersona, LIVE_PERSONA_PROMPT } from './_live-llm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const prompt = readFileSync(join(ROOT, LIVE_PERSONA_PROMPT), 'utf8');
console.log('\n【1】精简人设本身');
check(prompt.length >= 1800 && prompt.length <= 3500, '长度在 1800～3500 字符', String(prompt.length));
for (const [label, needle] of [
  ['身份', '丰川祥子'],
  ['自称', 'Saki'],
  ['短而自然', '短不等于干巴巴'],
  ['保留语气词', '语气词可以保留'],
  ['禁客服腔', '不要客服腔'],
  ['禁标准答案', '别写说明书、报告或标准答案'],
  ['群友/服主差异', '对服主'],
  ['不编造', '绝不编造'],
  ['图片看得见', '不要问「图片是什么」'],
  ['工资边界', '红包、转账、付款码、代充一律不要'],
  ['口癖软提醒', '不是每句话的固定开头或结尾'],
]) check(prompt.includes(needle), `保留${label}规则`);

console.log('\n【2】临时人设包：身份取真实人设，正文取精简稿');
const name = 'live-persona-gate';
const rel = prepareLivePersona(ROOT, name);
const dir = join(ROOT, rel);
try {
  const realId = readFileSync(join(ROOT, 'personas', 'saki', 'identity.json'), 'utf8');
  const testId = readFileSync(join(dir, 'identity.json'), 'utf8');
  check(testId === realId, 'identity.json 与真实 Saki 逐字节一致');
  check(readFileSync(join(dir, 'persona.md'), 'utf8') === prompt, 'persona.md 使用固定精简稿');
  check(!existsSync(join(dir, 'persona-media.md')) && !existsSync(join(dir, 'persona-money.md')),
    '没有把媒体/工资长文一并复制进测试包');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n【3】三个真机套件都走精简人设');
for (const file of ['ask-private.js', 'ask-attitude.js', 'tic-live.js']) {
  const src = readFileSync(join(ROOT, 'test', file), 'utf8');
  check(src.includes('prepareLivePersona('), `${file} 调用 prepareLivePersona()`);
  check(src.includes('QQBOT_PERSONA_DIR'), `${file} 把临时目录传给子进程/模块`);
}

console.log('\n【4】生产人设没有被辅助函数写入');
const helper = readFileSync(join(ROOT, 'test', '_live-llm.js'), 'utf8');
check(!/writeFileSync\([^\n]*personas[\\/]saki/.test(helper), '辅助函数没有写生产 personas/saki/');
// ⚠️ 2026-10-02 **改过一次、又改回来**。经过：
//   我把 `promptMaxChars: 5000` 调成 120000，并把这行改成「必须 > 60000」——
//   **两处都是错的**。用户指出：5000 是**故意的快速档**（有些模型上下文上限就那么长），
//   这条断言正是在保护它，不是过时包袱。
// ⇒ 现在钉的是「**两档都必须在，且快速档仍是 5000**」：
//   既保住快速档这个有意为之的档位，也不让它被人悄悄删掉。
const fastKept = /const LIVE_PROMPT_MAX_CHARS_FAST = 5000/.test(helper);
const fullKept = /const LIVE_PROMPT_MAX_CHARS = (\d+)/.test(helper)
  && Number(helper.match(/const LIVE_PROMPT_MAX_CHARS = (\d+)/)[1]) > 60000;
check(
  fastKept && fullKept,
  'promptMaxChars 两档都在：快速档 5000（给上下文小的模型，别当过时数字删）+ 完整档装得下 style.md',
  fastKept ? '' : '快速档没了',
);
check(
  /promptMaxChars: process\.env\.QQBOT_LIVE_FAST/.test(helper),
  '两档可用 QQBOT_LIVE_FAST=1 切换',
);

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
