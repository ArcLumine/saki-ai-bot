/**
 * `run-all.js` 参数解析（`test/_args.js`）的回归 —— 2026-09-29 加。
 *
 * ## 为什么盯这个
 *
 * `--only` 是"改一处只跑相关几套"的唯一入口，而它坏起来是**静默**的：
 *   · 把 `--jobs` 的值当套件名吞掉 ⇒ 至少还报错（好一些）；
 *   · 名字写错却"只跑认识的那几个" ⇒ **少跑几套 + 收尾仍写全过** ⇒ 假绿（最坏）；
 *   · 不带参数那条**默认路径**被改动 ⇒ 全量回归的行为悄悄变了。
 * 所以下面每条都对着**表现**断言，而不是对着实现。
 *
 * ⚠️ 纯离线：只 import 纯函数 + 读 `run-all.js` 的源码文本，**不起任何进程**
 *    （零 spawn、零网络）—— 这正是它自己能进回归名单的原因。
 * 用法: node test/run-all-cli.js
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, DEFAULT_JOBS } from './_args.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'test', 'run-all.js'), 'utf8');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

/** 一个假套件表：**故意只有 4 个**，好断言"报错时把全部名字都印出来" */
const SUITES = ['safety', 'sensitive-hit', 'knowledge-groups', 'webui'];

console.log('\n【1】★ 默认路径：不带参数 = 全量 + jobs=2（现状一字不改）');
{
  const r = parseArgs([], SUITES);
  check(r.only === null, 'only=null ⇒ 跑全量');
  check(r.jobs === DEFAULT_JOBS && r.jobs === 2, `并发默认 2（实际 ${r.jobs}）`);
  check(!r.error, '没有报错');
  check(r.warnings.length === 0, '也不该有警告（干净的调用）');
}

console.log('\n【2】★★ --only：筛套件');
{
  const r = parseArgs(['--only', 'safety'], SUITES);
  check(JSON.stringify(r.only) === JSON.stringify(['safety']), '--only safety ⇒ 只跑 safety');
  check(r.jobs === 2, '并发仍是默认 2');

  // ⚠️⚠️ 这条是整套里最容易破的：`--only` 收名字时如果一路吃到数字，
  //    `--jobs` 的 `4` 就会被当成套件名 ⇒ 报"未知套件 4"。
  const r2 = parseArgs(['--only', 'safety', '--jobs', '4'], SUITES);
  check(JSON.stringify(r2.only) === JSON.stringify(['safety']), '★★ --only safety --jobs 4 ⇒ 只跑 safety');
  check(r2.jobs === 4, '★★ 而且 --jobs 的 4 真的生效了（没被吞）');
  check(!r2.error, '不报错');

  const r3 = parseArgs(['--jobs', '4', '--only', 'safety'], SUITES);
  check(JSON.stringify(r3.only) === JSON.stringify(['safety']) && r3.jobs === 4, '换个顺序（--jobs 在前）也一样');

  const r4 = parseArgs(['--only', 'webui', 'knowledge-groups'], SUITES);
  check(r4.only.length === 2, '多条套件名都收下（2 个）');

  const r5 = parseArgs(['--only', 'safety', 'safety'], SUITES);
  check(r5.only.length === 1, '重复名字去重（不会跑两遍）');
}

console.log('\n【3】★★ --only 出错时：**绝不静默只跑认识的那几个**');
{
  const miss = parseArgs(['--only'], SUITES);
  check(!!miss.error && miss.only === null, '★ --only 缺值 ⇒ 报错且 only=null');
  check(/--only/.test(miss.error), '报错里点名了 --only 本身');

  const bad = parseArgs(['--only', 'nope'], SUITES);
  check(!!bad.error && bad.only === null, '★★ 未知名字 ⇒ 报错且 only=null（一套都不跑）');
  check(bad.error.includes('nope'), '★★ 报错指出了是哪个名字错');
  for (const n of SUITES) {
    check(bad.error.includes(n), `★★ 报错里印出了全部套件名：${n}`);
  }

  const mixed = parseArgs(['--only', 'safety', 'nope'], SUITES);
  check(
    !!mixed.error && mixed.only === null && mixed.error.includes('nope'),
    '★★ 一半对一半错 ⇒ 也报错（不许"静默只跑 safety"）',
  );
}

console.log('\n【4】★ --jobs 的边界（沿用老口径）');
{
  check(parseArgs(['--jobs', '5'], SUITES).jobs === 5, '--jobs 5 ⇒ 5');
  check(parseArgs(['--jobs', '0'], SUITES).jobs === 2, '--jobs 0 ⇒ 回默认 2（0 当"没填"）');
  check(parseArgs(['--jobs', 'abc'], SUITES).jobs === 2, '--jobs abc ⇒ 回默认 2');
  check(parseArgs(['--jobs', '-3'], SUITES).jobs === 1, '--jobs -3 ⇒ 夹到 1');
  const w = parseArgs(['--jobs', 'abc'], SUITES).warnings;
  check(w.length === 1 && /--jobs/.test(w[0]), '非数字时会有一条警告（不装看不见）');
}

console.log('\n【5】★ --list，以及"裸参数只警告、照旧全量跑"');
{
  const l = parseArgs(['--list'], SUITES);
  check(l.list === true && l.only === null && !l.error, '--list ⇒ 只列表、不筛、不报错');

  const bare = parseArgs(['safety'], SUITES);
  check(bare.only === null && bare.warnings.length === 1, '★ 裸参数 ⇒ 警告 + 按全量跑（保守）');
  check(/--only safety/.test(bare.warnings[0]), '警告里顺手告诉他正确写法');
  check(parseArgs(['--nope'], SUITES).warnings.length === 1, '认不出的选项同样只是警告');
}

console.log('\n【6】★★ 接线：run-all.js 真的用上了它（读源码文本断言，零 spawn）');
{
  check(SRC.includes("from './_args.js'"), 'run-all.js import 了 _args.js');
  check(SRC.includes('parseArgs(args, SUITES)'), '把 SUITES 传进去校验名字');
  check(SRC.includes('const RUN = only ?'), '筛出这次要跑的集合（RUN）');
  check(/pool\(RUN, jobs, runSuite\)/.test(SRC), '★ 真的跑 RUN（不是又跑回 SUITES）');
  // 两种收尾语：全量那句的关键词必须**唯一**（脚本和人都靠它判绿）
  check(/套件 \$\{results\.length - failed\.length\}\/\$\{results\.length\} 全过/.test(SRC), '★★ 全量收尾语仍是「套件 N/N 全过」');
  check(SRC.includes('部分运行') && SRC.includes('没跑'), '★★ 筛选模式收尾明说「部分运行 / 其余没跑」');
  check(SRC.includes('process.exit(2)'), '参数错误时是**独立的退出码 2**（跟"有套件没过"的 1 分开）');
}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
