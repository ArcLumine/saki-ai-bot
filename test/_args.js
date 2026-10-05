/**
 * `run-all.js` 的参数解析（**纯函数**）—— 2026-09-29 加。
 *
 * ## 为什么要有这个文件
 *
 * 「只想跑两套」以前做不到：`run-all.js` 永远跑全量，而其中有一批套件**不许裸跑**
 * （会写真 `state/*.json`、真 `knowledge/`，只有 run-all 的隔离能让它们安全）——
 * 于是"改一个字 → 等十几分钟"，人就开始偷懒不跑回归了。
 *
 * 抽成纯函数是为了**能单测**：`test/run-all-cli.js` 不起任何进程，把每条规则
 * （尤其是「`--only` 别把 `--jobs` 的值当套件名吞掉」「名字写错不许静默只跑认识的」）
 * 钉死。这两个坑破起来都是**静默少跑几套**，比报错难查得多。
 *
 * ⚠️ 这个文件**没有任何副作用**：不读盘、不打印、不 spawn。打印与退出由调用方做。
 */

/** 默认并发：**2**（理由见 `run-all.js` 里那段注释 —— 并发 5 会出假红） */
export const DEFAULT_JOBS = 2;

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 已经切好的参数（不含 node 与脚本名），如 `['--only','safety','--jobs','4']`
 * @param {string[]} suites 全部套件名（用来校验名字 + 报错时打印）
 * @returns {{only:string[]|null, jobs:number, list:boolean, error:string, warnings:string[]}}
 *   · `only === null` → **全量**（不带参数时的默认路径）
 *   · `error` 非空 → 调用方打印后**退出，不要继续跑**
 *   · `warnings` → 只提醒、不影响怎么跑
 */
export function parseArgs(argv, suites) {
  const args = (Array.isArray(argv) ? argv : []).map((x) => String(x));
  const names = (Array.isArray(suites) ? suites : []).map((x) => String(x));
  const known = new Set(names);
  const res = { only: null, jobs: DEFAULT_JOBS, list: false, error: '', warnings: [] };
  /** 已经**被某个选项吃掉值**的下标（别再把它们当成"裸参数"重复报警） */
  const eaten = new Set();

  // ── --jobs ───────────────────────────────────────────────────────────
  const ji = args.indexOf('--jobs');
  if (ji >= 0) {
    eaten.add(ji);
    eaten.add(ji + 1);
    const raw = args[ji + 1];
    // ⚠️ 老口径照旧（2026-09-13 就有的参数，行为别在这版里偷偷变）：
    //    读不到 / 不是数 / 写成 0 ⇒ 默认 2；负数夹到 1。
    const n = Number(raw);
    if (Number.isFinite(n) && n !== 0) res.jobs = Math.max(1, Math.trunc(n));
    else res.warnings.push(`--jobs 后面没跟上数字（拿到「${raw ?? ''}」）⇒ 按默认 ${DEFAULT_JOBS} 个并行跑`);
  }

  // ── --only ───────────────────────────────────────────────────────────
  const oi = args.indexOf('--only');
  if (oi >= 0) {
    eaten.add(oi);
    const picked = [];
    for (let i = oi + 1; i < args.length; i++) {
      // ⚠️⚠️ 遇到下一个选项就停 —— 这就是「`--only safety --jobs 4` 不能把 `4`
      //    当成套件名」的地方。少这一行，`4` 会被当成套件名 ⇒ 报"未知套件 4"。
      if (args[i].startsWith('--')) break;
      picked.push(args[i]);
      eaten.add(i);
    }
    const uniq = [...new Set(picked)];
    if (!uniq.length) {
      res.error = '「--only」后面要跟套件名（例：node test/run-all.js --only safety）';
      return res;
    }
    const unknown = uniq.filter((p) => !known.has(p));
    if (unknown.length) {
      // ⚠️⚠️ 这里**必须报错退出**，不许"只跑认识的那几个"：名字写错时会少跑几套，
      //    而收尾照样写"全过" —— 那是最坏的一种假绿。
      res.error =
        `未知套件名：${unknown.join('、')}\n` +
        `  这次**一套都没跑**（不认识的名字不会被悄悄忽略）。这次给的全部 ${names.length} 个套件名：\n` +
        names.map((n) => `    · ${n}`).join('\n');
      return res;
    }
    res.only = uniq;
  }

  // ── --list ───────────────────────────────────────────────────────────
  const li = args.indexOf('--list');
  if (li >= 0) {
    eaten.add(li);
    res.list = true;
  }

  // ── 其余（认不出的选项 / 裸参数）：警告，但**按全量跑** ────────────────
  //    ⚠️ 为什么是警告不是报错：现状本来就**静默忽略**裸参数，突然报错会打断
  //       已经习惯这么敲的人；但也不能装作没看见 —— 少跑套件的代价太大。
  for (let i = 0; i < args.length; i++) {
    if (eaten.has(i)) continue;
    const a = args[i];
    if (a.startsWith('--')) {
      if (a !== '--jobs' && a !== '--only' && a !== '--list') {
        res.warnings.push(`认不出的参数「${a}」⇒ 忽略（这次按**全量**跑）`);
      }
      continue;
    }
    res.warnings.push(`裸参数「${a}」⇒ 忽略（要只跑某几套请写 --only ${a}）`);
  }
  return res;
}
