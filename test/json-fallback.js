/**
 * 大模型出口的 JSON 兜底（2026-09-29）。
 *
 * ## 这个套件是为什么建的
 *
 * `speak-judge` / `attribution-guard` / `face-annotate` 三处都是同一套写法：
 *   ```js
 *   const m = String(raw).match(/\{[\s\S]*\}/);
 *   if (!m) { ...兜底... }        ← 注释写着「模型没按格式回就走兜底」
 *   const j = JSON.parse(m[0]);    ← 但这里还能抛
 *   ```
 *
 * 作者只想到了「模型完全不给 JSON」，漏了**「给了、但是不合法」**这一半。
 * 正则只是截一段「长得像 JSON 的」，不等于能解析：
 * 模型在 JSON 后面补一段带花括号的说明时，贪婪的 `[\s\S]*` 会一路吃到
 * 最后一个 `}`，截出来的是 `{"a":1} 补充 {"b"}` 这种，直接 parse 抛。
 *
 * ⚠️ 说清楚严重性：**这三处外面本来就有 catch 兜底，不会崩、不影响回复。**
 *    真正的问题只是：它会走进「出错」分支打 `warn` 日志，
 *    而这其实是「模型没按格式回」这种**日常**情况 —— 排查时满屏 warn，
 *    反而把真出事的那条埋掉了。所以修的是「别刷错误日志」，不是「防崩溃」。
 *
 * 另外钉住 webui：请求体 JSON 不合法要返 **400** 而不是 500
 * （「你发来的 JSON 写错了」不等于「服务端崩了」）。
 *
 * ⚠️ 纯源码断言 + 纯函数，**不联网、不花钱**。
 *
 * 用法: node test/json-fallback.js
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, 'src', f), 'utf8');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'}${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

/**
 * 把源码里那段「正则 → 解析」的真实行为抽出来复现一遍。
 * ⚠️ 这里刻意**不用 import 真模块**（那会连配置/网络），
 *    而是把三处共同的形状原样摆出来，喂各种畸形输入看会不会抛。
 */
function parseModelJson(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  return JSON.parse(m[0]); // 没有 try —— 就是修之前的行为
}

/** 三处各自的「解析不了就怎么办」 */
const FALLBACKS = {
  'speak-judge': (r) => ({ ...r, speak: true }),          // 兜底「照常说」
  'attribution-guard': (r) => ({ ...r, ok: true }),       // 兜底「放行」
};

/** 去掉注释，免得注释里提到的 `startWebUI()` 被当成真调用 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

console.log('\n【1】★★★ 畸形 JSON 真的会抛（先证明这个 bug 是真的，不是臆想）');
{
  const cases = [
    // ⚠️ 这一列是「修之前的 `parseModelJson` 对这个输入的表现」，
    //    两种都算「要靠兜底接住」，只是原因不同：
    //      null = 正则没截到（模型压根没给花括号）
    //      throw = 截到了但不合法 ← **这才是漏掉的那一半**
    ['纯 JSON（正常）', '{"speak":true}', 'ok'],
    ['完全没 JSON', '好的，我来说两句', 'null'],
    ['截断的 JSON（连 } 都没有）', '{"speak":tr', 'null'],
    ['JSON + 带花括号的后续说明', '{"speak":true} 补充：{"x":1}', 'throw'],
    ['花括号里带裸文字', '{speak:true}', 'throw'],
  ];
  for (const [name, raw, expect] of cases) {
    let got = 'ok';
    let msg = '';
    try {
      const r = parseModelJson(raw);
      got = r === null ? 'null' : 'ok';
    } catch (e) {
      got = 'throw';
      msg = `(${e.message.slice(0, 28)})`;
    }
    check(got === expect, `「${name}」→ ${expect}`, msg);
  }
  console.log('  ℹ️ 「throw」那两行就是漏掉的一半：截到了、但 parse 不了');
}

console.log('\n【2】★★★ 三处都必须自己兜住，不能只靠外面的 catch');
{
  for (const f of ['speak-judge.js', 'attribution-guard.js', 'face-annotate.js']) {
    const s = read(f);
    // 「正则截到 → JSON.parse」之间必须隔着一个 try
    check(
      /match\(\/\\\{[\s\S]*\\?\}\/\)/.test(s),
      `★ ${f} 仍在用正则截 JSON 块（确认我们找对了地方）`,
    );
    check(
      /try\s*\{\s*[\s\S]{0,40}?j\s*=\s*JSON\.parse\(/.test(s),
      `★★ ${f} 的 JSON.parse 被 try 包住了`,
    );
    check(
      !/const j\s*=\s*JSON\.parse\(/.test(s),
      `★★ ${f} 不再是裸的 const j = JSON.parse(...)`,
    );
  }
}

console.log('\n【3】★★ 解析不了要回到各自的兜底语义（不是随便返回）');
{
  const sj = read('speak-judge.js');
  check(
    /catch\s*\{[\s\S]{0,200}?log\.debug[\s\S]{0,120}?return\s*\{\s*\.\.\.fallback/.test(sj),
    '★ speak-judge：解析不了 → 兜底「照常说」（返回 fallback）',
  );
  check(
    !/catch\s*\{\s*log\.warn/.test(sj),
    '★★ speak-judge：解析不了不再打 warn（那是日常情况，不是故障）',
  );

  const ag = read('attribution-guard.js');
  check(
    /catch\s*\{[\s\S]{0,200}?log\.debug[\s\S]{0,120}?return\s*\{\s*\.\.\.pass/.test(ag),
    '★ attribution-guard：解析不了 → 兜底「放行」（返回 pass）',
  );
  check(
    !/catch\s*\{\s*log\.warn/.test(ag),
    '★★ attribution-guard：解析不了不再打 warn',
  );

  const fa = read('face-annotate.js');
  check(
    /catch\s*\{[^}]*throw new Error\([^)]*JSON[^)]*解析不了/.test(fa),
    '★ face-annotate：这里抛是允许的（批量那边逐张 try/catch），但要说人话',
  );
  check(
    !/catch\s*\{\s*throw e\s*;?\s*\}/.test(fa),
    '★ face-annotate：不再把 parse 的原话（"Unexpected token"）原样抛出',
  );
}

console.log('\n【4】★★ 兜底语义本身必须保持原样（别把 bug 修成行为变更）');
{
  const sj = read('speak-judge.js');
  check(/speak: true/.test(sj) || /fallback\s*=\s*\{[^}]*speak/.test(sj), '★ speak-judge 的 fallback 仍是「说」');
  check(
    /catch \(e\)\s*\{[\s\S]{0,200}?照常说/.test(sj),
    '★ 超时/网络错那条 catch 仍在（外层兜底没被我拆掉）',
  );

  const ag = read('attribution-guard.js');
  check(
    /核对出错一律\*\*放行\*\*/.test(ag),
    '★ attribution-guard 外层 catch 仍在（核对失效不能就不说话）',
  );
}

console.log('\n【5】★★ webui：请求体不合法要 400，不是 500');
{
  const w = read('webui.js');
  check(/async function jsonBody\(req\)/.test(w), '★ 有统一的 jsonBody() 读请求体');
  check(/err\.badBody = true/.test(w), '★ 解析失败给错误打 badBody 标记');

  // 除了 jsonBody 内部，路由里不该再有裸的 JSON.parse(await readBody(...))
  const bare = (w.match(/JSON\.parse\(\(await readBody/g) ?? []).length;
  check(bare === 0, `★ 路由里不再有裸的 JSON.parse(await readBody(...))`, `剩 ${bare} 处`);

  const uses = (w.match(/await jsonBody\(req\)/g) ?? []).length;
  check(uses >= 20, `★ 路由都改用了 jsonBody()`, `${uses} 处`);

  check(
    /if \(e\.badBody\)[\s\S]{0,120}?send\(res, 400/.test(w),
    '★★ 外层 catch 认 badBody → 返 400',
  );
  check(
    /e\.badBody[\s\S]{0,400}?send\(res, 500/.test(w),
    '★ badBody 分支在 500 之前 return（别又落回 500）',
  );
}

console.log('\n【6】★ webui：IPv6 回落不许用递归');
{
  const w = read('webui.js');
  const fnStart = w.indexOf('export async function startWebUI');
  check(fnStart > 0, '★ startWebUI 还在');
  const body = stripComments(w.slice(fnStart, fnStart + 4000))
    .replace(/export\s+(async\s+)?function\s+startWebUI\s*\([^)]*\)/, ''); // 去掉函数声明本身
  check(!/startWebUI\s*\(/.test(body), '★★ 函数体内不再自我递归调用（注释已排除）');
  check(/for \(let attempt = 0; attempt < 2/.test(body), '★★ 改成最多 2 次的循环');
  check(
    !/startWebUI\s*\(\s*\)/.test(stripComments(w)),
    '★ 全文件（去注释）没有裸的自我递归调用了',
  );
  check(
    /export async function startWebUI/.test(w),
    '★ startWebUI 是 async（要等 listen 出结果才能决定要不要重来）',
  );
  // 递归的真正危害：递归那层调 startWebUI() 没带 botInstance，bot 被重新赋成 null
  check(
    !/startWebUI\s*\(\s*\)/.test(body),
    '★★ 没有「不传 bot 就重来」的调用（那会把 bot 悄悄置 null）',
  );
}

// ⚠️ `run-all.js` 是靠这一行判断套件绿不绿的（`结果:` + 「全部通过」），
//    少这一行会被判成「（无结果行）」＝失败。别改这个格式。
console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);