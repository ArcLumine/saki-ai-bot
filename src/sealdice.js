/**
 * 海豹骰（SealDice）客户端 —— 小祥**主动**去问它算骰、读它的跑团记录。
 *
 * ## 用户需求（2026-09-30）
 *   「群里发 .ra 之类小祥能答」
 *
 * ## 为什么是「小祥主动调海豹」，而不是「海豹接 QQ 把消息推给小祥」
 *
 * 2026-09-30 用户定的方案是「甲」：**海豹不接 IM**。
 * 缘由是一条架构级的硬约束（实测 + 读源码得出）：
 *   小祥现在是通过 `onebot.url` 用 WebSocket 连 NapCat 的。海豹要接 QQ 也得连 NapCat。
 *   **同一个 NapCat 实例挂两个 WebSocket 客户端**会出三种问题，其中第三种无解：
 *     · 抢连接 —— 后连的顶掉先连的，小祥掉线
 *     · 重复处理 —— 同一条群消息两个都响应
 *     · ⚠️ **自反馈死循环** —— 同一个账号下，小祥发的消息海豹也当成"群友消息"，
 *       海豹插件再转回给小祥 ⇒ 她在跟自己对话。
 *   那是**架构问题，不是调参能解决的**。所以海豹干脆不碰 QQ。
 *
 * 于是职责变成：
 *   · 群里有人打 `.ra` / `.r` → **小祥**接过来 → 问海豹算 → **小祥**把结果说出来
 *   · 海豹只提供 **骰点规则库 + log**，不发言
 *   ·「骰娘模式」= 小祥把连转述也一起关掉 ⇒ 全程静默（这正是用户要的）
 *
 * ## 好处（不只是绕开冲突）
 *   · 零 IM 依赖：海豹起没起、用不用得上 QQ，小祥都照常干活
 *   · 她还是"那个什么都会一点的小祥"，不是变成海豹 —— 人格连续
 *   · 海豹那套 COC / DND 规则**照旧全用**，只是经由 API 而不是群里直接打指令
 *
 * ## 海豹侧接口（全部实测通，2026-09-30）
 *   · `POST /sd-api/dice/exec`   `{id, message, messageType}` → 算一条指令，返回 `"ok"`
 *   · `GET  /sd-api/dice/recentMessage` → 结果数组（算完去这里取）
 *   · `GET  /sd-api/story/logs/page?pageNum=&pageSize=` → 跑团记录分页
 *   ⚠️ API 前缀是 **`/sd-api`**（不是 `/api`）；除 `/sd-api/preInfo` 外都要请求头 `token`。
 *
 * ## 为什么用 http 而不是 WS
 *   顺带发现海豹的 Goja 里 `WebSocket` 也是 function，但那是**插件侧**的能力。
 *   小祥侧用裸 HTTP 就够 —— 这三个接口都是一问一答，没有推送需求。
 */
import { config } from './config.js';
import { log } from './log.js';

const cfg = () => config.sealdice ?? {};

/** 没配就不启用 —— 省得每个调用点都判一遍 */
export function enabled() {
  const c = cfg();
  return c.enable !== false && !!c.baseUrl && !!c.token;
}

/**
 * 调海豹一个 API。
 *
 * ⚠️ **超时必须给**：海豹没起来 / token 写错 / 网络不通时它会一直挂着，
 * 而这个函数是**在消息处理链路里被调的** —— 挂住 = 整条消息处理卡死。
 * 所以统一短超时 + 拿不到就当"海豹不在"，绝不让它拖住小祥。
 *
 * @param {string} path 例如 `/dice/exec`
 * @param {'GET'|'POST'} [method]
 * @param {object} [body] POST 时的 JSON
 * @returns {Promise<any>} 拿不到返回 null（**不抛** —— 调用点不必写 try/catch）
 */
async function call(path, method = 'GET', body = null) {
  const c = cfg();
  const base = String(c.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) return null;
  const url = `${base}/sd-api${path}`;
  const ms = Math.max(500, Number(c.timeoutMs) || 4000);
  // ⚠️ `AbortSignal.timeout` 是 Node 17.3+ 的；老版本没有，所以给个兜底。
  const opt = { method, headers: { token: String(c.token ?? '') } };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  if (typeof AbortSignal?.timeout === 'function') opt.signal = AbortSignal.timeout(ms);
  try {
    const res = await fetch(url, opt);
    if (!res.ok) {
      // ⚠️ 不打 warn：海豹没配好时这会每条消息吵一次。只 debug。
      log.debug(`海豹 ${method} ${path} → HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log.debug(`海豹 ${method} ${path} 失败：${e.message}`);
    return null;
  }
}

/**
 * 调海豹一个 API（**要能看见状态码**的那一版）。
 *
 * ⚠️ 为什么要单独一版：`roll()` 得靠状态码判断「是不是被限流了」
 *    （海豹对 group 模式的 exec 有 **500ms 限流**，超了回 400「过于频繁」）。
 *    `call()` 把错误吞成 null，那样就分不清「限流」和「海豹没起来」。
 *
 * @returns {Promise<{ok:boolean, status:number, body:any}>} 永远 resolve，不抛
 */
async function callRaw(path, method = 'GET', body = null) {
  const c = cfg();
  const base = String(c.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) return { ok: false, status: 0, body: null };
  const url = `${base}/sd-api${path}`;
  const ms = Math.max(500, Number(c.timeoutMs) || 4000);
  const opt = { method, headers: { token: String(c.token ?? '') } };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  if (typeof AbortSignal?.timeout === 'function') opt.signal = AbortSignal.timeout(ms);
  try {
    const res = await fetch(url, opt);
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      /* 不是 JSON 就算了 */
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (e) {
    log.debug(`海豹 ${method} ${path} 失败：${e.message}`);
    return { ok: false, status: 0, body: null };
  }
}

/**
 * 让海豹算一条骰点指令。
 *
 * ⚠️⚠️ **海豹对 group 模式有 500ms 限流**（源码 `api/api_bind.go` 的 `DiceExec`：
 *    `if now-lastGroupExecTime < 500 { return 400 "过于频繁" }`）。
 *    连着发两条，第二条必被拒 —— 而"群里有人接连掷骰"恰恰是很常见的场景。
 *    ⇒ 这里识别「过于频繁」之后**退避重试**（最多 2 次），而不是把失败
 *    直接甩给调用方（那表现是"她说不出话"，但原因在海豹那边，很难查）。
 *
 * ⚠️ 另外：**`id` 参数其实被海豹完全忽略** —— 它内部把 group 写死成
 *    `UI-Group:2001`（同一个文件那几行）。所以按 scopeId 过滤结果永远为空。
 *    这里照实传，只是为了将来海豹真接了 IM 才对。
 *
 * @param {string} message 例如 `.ra 3d6` / `.r d100` —— **要带前导点和命令名**
 * @param {string} [scopeId] 目前海豹会忽略它
 * @param {'group'|'private'} [messageType]
 * @returns {Promise<boolean>} 有没有送进去
 */
export async function roll(message, scopeId = 'UI-Group:2001', messageType = 'group') {
  if (!enabled()) return false;
  const text = String(message ?? '').trim();
  if (!text) return false;
  const gap = Math.max(520, Number(cfg().minRollGapMs) || 520); // ⚠️ 比海豹的 500 略多，留余量
  let ok = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, gap * attempt));
    const res = await callRaw('/dice/exec', 'POST', { id: String(scopeId), message: text, messageType });
    if (res.ok) {
      ok = res.body === 'ok' || res.body?.result === true;
      if (!ok) log.debug(`海豹 exec 回了 ${JSON.stringify(res.body)}（不是 "ok"）`);
      return ok;
    }
    // ⚠️ 400 且 body 是「过于频繁」⇒ 退避重试；其它 400（如"格式错误"）直接放弃
    const msg = String(res.body ?? '');
    if (res.status === 400 && /过于频繁/.test(msg)) continue;
    log.debug(`海豹 exec → HTTP ${res.status} ${msg}`);
    return false;
  }
  return ok;
}

/**
 * 取走海豹刚算出来的结果（`recentMessage` 的内容）。
 *
 * ⚠️⚠️ **不能按 `uid` 过滤** —— 实测踩过的坑：
 *    `dice/exec` 走的是海豹的「UI 测试」适配器（`platform_adapter_http.go`），
 *    它内部把 scope **转成固定的 `UI-Group:2001`**。所以不管我们传什么群号，
 *    `recentMessage` 里的 `uid` 永远是 `UI-Group:2001` ——
 *    按 `UI-Group:<跑团群>` 去过滤的结果是**永远空**。
 *    ⇒ 改成「取最后一条」：我们刚发过去的那条就是最新的。
 *
 * ⚠️ 那为什么还保留 `scopeId` 参数？因为将来海豹真接了 IM，
 *    `recentMessage` 会有多个 uid，那时这个过滤就派上用场了（现在等于不过滤）。
 *
 * @param {string} [scopeId] 目前的 UI 测试模式下**用不上**，留着是为了将来
 * @returns {Promise<string>} 可直接发出去的话；没有则空串
 */
export async function takeResult(scopeId = '') {
  if (!enabled()) return '';
  const list = await call('/dice/recentMessage');
  if (!Array.isArray(list) || !list.length) return '';
  // ⚠️ 优先按 uid 过滤；**一条都没匹配上就退回「取最后一条」**。
  //    这样现在（UI 测试，uid 固定）和将来（真 IM，多 uid）都能用。
  const mine = scopeId ? list.filter((x) => x?.uid === scopeId) : [];
  const picked = mine.length ? mine : [list[list.length - 1]];
  return picked.map((x) => String(x.message ?? '').trim()).filter(Boolean).join('\n');
}

/**
 * 算一条并把结果一起拿回来（**小祥日常转述走这条**，省得调用方自己配对两步）。
 *
 * ⚠️⚠️ **必须轮询，不能取一次就完** —— 海豹的 `dice/exec` 是**异步**的：
 *    它立刻回 `"ok"`，结果过一小会儿才出现在 `recentMessage` 里。
 *    实测：exec 返回后马上读，拿到的是**上一次的旧结果或空**。
 *    所以这里「先记下当前有几条，再轮询到出现新的一条为止」。
 *
 * ⚠️ 超时后**不报错也不说话**（返回空串）—— 宁可漏答，也不要卡住消息处理。
 *
 * @param {string} message
 * @param {{scopeId?:string, messageType?:'group'|'private', timeoutMs?:number}} [opts]
 * @returns {Promise<string>} 结果文本；没算出来返回空串
 */
export async function ask(message, opts = {}) {
  const scopeId = opts.scopeId ?? '';
  // ⚠️ 先读一次「现在有几条」—— 之后按数量判断有没有新增。
  const before = await recentLength();
  if (!await roll(message, scopeId, opts.messageType ?? 'group')) return '';
  const wait = Math.max(150, Number(opts.timeoutMs) || Number(cfg().answerWaitMs) || 1500);
  const step = 250;
  for (let waited = 0; waited <= wait; waited += step) {
    if (waited) await new Promise((r) => setTimeout(r, step));
    const list = await rawRecent();
    if (list.length > before) {
      const last = list[list.length - 1];
      const text = String(last?.message ?? '').trim();
      if (text) return text;
    }
  }
  // ⚠️ 到点还没出现「新增」：兜底取最后一条。
  //    实测踩过：列表**从空开始**时那一次，条数判断会失手（before=0，
  //    但 exec 的结果落在别处 / 或被限流重试后时序错位）⇒ 结果明明在，
  //    我们却说"没算出来"。取最后一条比空手而归好。
  //    ⚠️ 代价：理论上可能拿到**上一条**的结果 —— 但那也是同一局的骰子，
  //    比完全不回答强，而且这属于兜底路径、极少走到。
  const tail = (await rawRecent()).slice(-1)[0];
  const text = String(tail?.message ?? '').trim();
  if (text) log.debug(`海豹：没等到新增条目，兜底取了最后一条（「${message}」）`);
  return text;
}

/** ⚠️ 取「结果之前已有几条」用的原始列表（不加工） */
async function rawRecent() {
  const list = await call('/dice/recentMessage');
  return Array.isArray(list) ? list : [];
}

async function recentLength() {
  try {
    return (await rawRecent()).length;
  } catch {
    return 0;
  }
}

/**
 * 列出某个群的**跑团局**（不是消息）。
 *
 * ⚠️⚠️ 这个接口返回的是「局列表」：`{id, name, groupId, createdAt, updatedAt, size}`。
 *    **它没有 message / isDice / time 字段** —— 消息在另一个接口（`storyItems`）。
 *    一开始我把这两个搞混了，害得 `note()` 读到一堆 undefined。
 *
 * @param {{pageNum?:number, pageSize?:number, groupId?:string}} [opts]
 * @returns {Promise<{list:Array, total:number}>} 拿不到返回 `{list:[],total:0}`
 */
export async function storyLogs(opts = {}) {
  if (!enabled()) return { list: [], total: 0 };
  const n = Math.max(1, Number(opts.pageNum) || 1);
  const size = Math.min(200, Math.max(1, Number(opts.pageSize) || 50));
  // ⚠️ 海豹这个 groupId 是 **`LIKE "%gid%"`**（源码 `service/log.go` 的 LogGetLogPage），
  //    也就是**部分匹配**：填 "123" 会连 "1234" 那个群一起捞出来。
  //    所以下面必须**再自己精确过滤一遍** —— 不能信服务端。
  const qs = new URLSearchParams({ pageNum: String(n), pageSize: String(size) });
  if (opts.groupId) qs.set('groupId', String(opts.groupId));
  const r = await call(`/story/logs/page?${qs.toString()}`);
  const all = Array.isArray(r?.data) ? r.data : [];
  const gid = opts.groupId ? String(opts.groupId).trim() : '';
  const list = gid ? all.filter((x) => String(x.groupId ?? '').trim() === gid) : all;
  return { list, total: Number(r?.total) || list.length };
}

/**
 * 读某一局里的**消息行**（这才是带 `message` / `isDice` / `time` 的那个接口）。
 *
 * ⚠️ 必须同时给 `groupId` **和** `logName`（局名）—— 海豹用这两样定位到具体哪一局
 *    （源码 `getIDByGroupIDAndName`）。只给群号会拿到「找不到」然后返回空数组。
 * ⚠️ 局名里可能有中文和空格，所以用 `URLSearchParams` 编码，别手拼字符串。
 *
 * @param {{groupId:string, logName:string, pageNum?:number, pageSize?:number}} opts
 */
export async function storyItems(opts = {}) {
  if (!enabled()) return [];
  const gid = String(opts.groupId ?? '').trim();
  const name = String(opts.logName ?? '').trim();
  if (!gid || !name) return [];
  const n = Math.max(1, Number(opts.pageNum) || 1);
  const size = Math.min(500, Math.max(1, Number(opts.pageSize) || 100));
  const qs = new URLSearchParams({
    groupId: gid,
    logName: name,
    pageNum: String(n),
    pageSize: String(size),
  });
  const r = await call(`/story/items/page?${qs.toString()}`);
  return Array.isArray(r) ? r : [];
}

/** 拿得到吗？（给状态显示用；**别在热路径调** —— 它是一次网络往返） */
export async function ping() {
  if (!enabled()) return { ok: false, reason: '未配置或已关闭' };
  const r = await call('/js/status');
  return { ok: r?.status === true, reason: r?.status ? '' : '海豹没响应' };
}