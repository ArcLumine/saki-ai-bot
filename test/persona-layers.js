/**
 * 人设**共用层 / 专属层**的边界（2026-09-30）。
 *
 * ## 为什么要这个套件
 *
 * 抽出 `personas/_shared/style.md` 的那一次，用 PowerShell 手写长段中文做批量替换，
 * 把三节压烂了（出现了「一个都能省」这种**语义正好反掉**的字句），
 * 同时把 Saki 专属的东西（大小姐、高松灯、家道中落）漏在了共用层里。
 * 两者都**不会让任何现有测试变红** —— 所以要专门钉住。
 *
 * 这里盯四件事：
 *   ① 共用层**不含**任何 Saki 专属词（换个人设就不该出现）
 *   ② 共用层**不含**已知乱码词（再转接坏一次会直接红）
 *   ③ 共用层**不含**未替换的占位符（`<你的名字>` 这类会原样发给模型）
 *   ④ 专属内容**仍然在** `personas/saki/persona.md` 里（移走不许移丢）
 *
 * ⚠️ 全离线：只读仓库里的真实人设文件，**一个字都不写**。
 *
 * 用法: node test/persona-layers.js
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_DIR = join(ROOT, 'personas', '_shared');
const SHARED = join(SHARED_DIR, 'style.md');
const PERSONA = join(ROOT, 'personas', 'saki', 'persona.md');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

if (!existsSync(SHARED) || !existsSync(PERSONA)) {
  console.log('⏭️ 共用层或 Saki 人设包不存在 —— 跳过，不算失败');
  process.exit(0);
}

const shared = readFileSync(SHARED, 'utf8');
const persona = readFileSync(PERSONA, 'utf8');

console.log('【1】★★ 共用层不许出现 Saki 专属词（换个人设就不该成立的东西）');
{
  // ⚠️ 「睦」「灯」「喵」「呐」这类**单个字不能进名单**：
  //    "别拿反问当开场白"、"不要一个人吃饭" 都是正常用法，会误伤。
  //    只列**组合后才有意义**的、以及明确的专有名词。
  const exclusive = [
    '大小姐', '高松灯', '家道中落', '自己会偷', '丰川', '祥子', '小祥',
    'CRYCHIC', 'Mujica', '月之森', '羽丘', 'Oblivionis', '客服 Saki',
  ];
  for (const w of exclusive) {
    const n = shared.split(w).length - 1;
    check(n === 0, `共用层没有「${w}」`, n ? `出现 ${n} 次` : '');
  }
  // 「喵」「呐」只在"**禁止**这么演"的规则里出现是**对的**，
  // 所以只验"别把它们当口癖推荐"，不验是否出现。
  check(!/「好耶～」/.test(shared), '共用层没有推荐专属口癖「好耶～」');
}

console.log('\n【2】★★ 共用层不许有乱码（上次批量替换压出来的字）');
{
  // 这些词在拆分前的原文（`e7fb75d~1`）里**一个都不存在**，出现即说明被改坏过。
  const garbled = [
    '句子成量', '幅寸', '感台', '一个都能省', '嗘碎', '口牌', '成员属句',
    '比究', '姚姬', '预端', '常状零信息量', '切温柔你', '客服你', '傲娇你',
    '温柔你', '捧场你',
  ];
  for (const w of garbled) {
    const n = shared.split(w).length - 1;
    check(n === 0, `没有乱码「${w}」`, n ? `出现 ${n} 次` : '');
  }
  // 「⚠……」 是 emoji 被截断的痕迹（⚠️ 的变体选择符掉了）
  check(!/⚠…/.test(shared), '没有半截的 ⚠️（`⚠……` 这种被截断的 emoji）');
}

console.log('\n【3】★★ 没被替换的死占位符（尖括号会**原样**发给模型）');
{
  // ⚠️ 2026-09-28 已经踩过：`<主人>` 这种占位符从来没人替换，直接进了提示词。
  //    `identity.address.owner` 那种**真的会**被替换的除外 —— 那是契约的一部分。
  //    这里只盯"没人会替换、却留在共用层里"的。
  const known = ['<主人>', '<表情>', '<id>'];   // 会被 knowledge.js / webui 替换
  const found = [...shared.matchAll(/<[^\s>]{1,12}>/g)].map(m => m[0]);
  const unknown = [...new Set(found)].filter(t => !known.includes(t));
  check(
    unknown.length === 0,
    '共用层没有被替换的死占位符',
    unknown.length ? `残留 ${unknown.join(' ')}` : '',
  );
  check(!/你的名字/.test(shared), '共用层没有「你的名字」这种没填的名字槽');
  check(!/<人设名字>/.test(shared), '共用层没有「<人设名字>」（尖括号会原样进提示词）');
}

console.log('\n【4】★★ 专属内容移走不许移丢（人设包那一层必须还留着）');
{
  const mustStay = [
    ['大小姐', '身世 / 气质'],
    ['高松灯', '「怎么温柔」的那个参照物'],
    ['家道中落', '最要紧的背景'],
    ['客服腔', '别像客服'],
    ['Oblivionis', '代号'],
  ];
  for (const [w, why] of mustStay) {
    check(persona.includes(w), `persona.md 里还有「${w}」`, why);
  }
  // 移回来时写的那一节，得有明确的标题，方便以后再拆一层
  check(/你是大小姐，但别端着/.test(persona), 'persona.md 里有「你是大小姐，但别端着」那一节');
}

console.log('\n【5】★ 两层都要在，且共用层确实只讲"怎么回话"');
{
  check(existsSync(SHARED), '共用层 personas/_shared/style.md 在');
  const sharedFiles = readdirSync(SHARED_DIR).filter(n => n.toLowerCase().endsWith('.md'));
  check(sharedFiles.includes('style.md'), '共用层里有 style.md', sharedFiles.join(' '));
  // 共用层应该"看起来"是规则而不是人设：标题里不该出现角色名
  check(!/^#{1,4} .*(Saki|小祥|祥子)/m.test(shared), '共用层的小节标题里没有角色名');
  // 反向：persona.md 必须指回共用层，否则以后改规则会漏改
  check(/_shared\/style\.md/.test(persona), 'persona.md 指向了共用层（知道规则住在哪）');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
