/**
 * 海豹骰（SealDice）客户端 —— 小祥**主动**去问它算骰、读它的跑团记录。
 *
 * ## 用户需求（2026-09-30）
 *   「群里发 .ra 之类小祥能答」
 *
 * ## 为什么是「小祥主动调海豹」，而不是「海豹接 QQ 把消息推给小祥」
 *
 * 2026-09-30 起方案是「甲」：**海豹不接 IM**，小祥主动调它的 HTTP API。
 * 2026-10-06 复核源码后**推翻了当初选方案甲的三条理由**（详见下面「已证伪」）。
 *
 * ## ⚠️ 已证伪：「同号接 IM 会死循环 / 会抢连接」是错的（2026-10-06 读源码）
 *
 * 当初写的三条硬约束，逐条核过源码，**没有一条成立**：
 *
 *   ① ❌「后连的顶掉先连的」—— NapCat 的 WS 服务端**本来就能挂多个客户端**。
 *      `napcat.mjs:95223` 起 `wsClients = []` / `wsClientWithEvent = []`，
 *      连接时 `push` 进去（:95367），事件**广播给数组里所有客户端**
 *      （:95232 `wsClientWithEvent.map(...)`），断开时按 `indexOf` + `splice`
 *      精确移除那一个（:95352）。⇒ 多客户端是被显式支持的，不是竞态。
 *      （`AGENTS.md` 里「NapCat 的 WebSocket 服务端只允许一个客户端」是同一条错误。）
 *
 *   ② ❌「自反馈死循环」—— **海豹自己就会丢弃自己账号发的话**。
 *      `sealdice-core-src/dice/platform_adapter_gocq.go:1064`：
 *      ```go
 *      if msgQQ.MessageType == "group" || msgQQ.MessageType == "private" {
 *          if msg.Sender.UserID == ep.UserID {
 *              // 以免私聊时自己发的信息被记录
 *              return
 *          }
 *      ```
 *      `ep.UserID` 是海豹登录的那个号（:532 由登录信息刷新），两边都经
 *      `FormatDiceIDQQ()` 归一成 `QQ:<uin>`，格式一致 ⇒ 同号时**必然相等**。
 *      ⇒ 同号方案下，小祥发的每条消息在海豹那里直接 `return`，
 *        不会触发任何指令、不会回话。而小祥那侧也早就按 `selfId` 过滤掉了
 *        海豹发的话（`bot.js` 的 `decide()` 与 `onRaw` 多处）。
 *        **回路在两端各被切一刀，根本不成环。**
 *
 *   ③ ⚠️「重复处理」—— 这条**是真的**，也是唯一还需要设计决策的地方。
 *      群里有人打 `.ra`，海豹自己算并回一次；若小祥同时在转述，就会**两条结果**。
 *      对策见下面的 `relayEnabled()`（`sealdice.relay` 开关）：
 *      海豹接了 IM 就把小祥的转述关掉，只留一条；海豹没接才由小祥兜底。
 *
 * ⇒ 结论：**同号接 IM 是可行的**，用户 2026-10-06 拍板走同号（没有小号）。
 *    「方案甲」保留不是因为它安全，而是因为**转述要能配昵称**（见 `setName`）
 *    —— 这仍是 API 路径独有的好处，代价是海豹那边所有群友共用一张卡。
 *
 * ## 职责划分（现状）
 *   · 海豹**不接 IM**（`relay` 开着）：群里 `.ra` → 小祥转述给海豹 → 小祥说出来
 *   · 海豹**接了同号 IM**（`relay` 关掉）：海豹自己收发，小祥**全程不碰骰点**
 *   · 两种形态下海豹都照旧提供 COC / DND 规则库 + log
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

/** 极简串行队列（`ask` 的并发闸）—— 不引 p-queue，整个项目没有这个依赖 */
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
  //
  // ⚠️⚠️ 2026-10-23 修（用户问「她读了多少」时实测抓到的，一直读数 0）：
  //    海豹把群记成 **`QQ-Group:<群号>`**（带前缀），而这里原来传的是**纯群号**
  //    ⇒ `LIKE "%<跑团群>%"` 一条都匹配不到，返回 `data:null`、
  //    `total` 却是 1（那是 total 的另一套口径）⇒ 调用方永远拿到空列表 ✗
  //    实测：
  //      ?groupId=<跑团群> → {"data":null,"total":1,"pageSize":0}
  //      ?（不带 groupId）    → {"data":[{"groupId":"QQ-Group:999000001",...}]}
  //    ⇒ 传参时补上 `QQ-Group:` 前缀；下面精确过滤也按「带前缀 / 纯号」两种都认。
  const qs = new URLSearchParams({ pageNum: String(n), pageSize: String(size) });
  const gid = opts.groupId ? String(opts.groupId).trim() : '';
  if (gid) {
    // 已经带前缀（`QQ-Group:` / `UI-Group:`）就原样传，否则补 `QQ-Group:`
    qs.set('groupId', /^[A-Za-z]+-Group:/.test(gid) ? gid : `QQ-Group:${gid}`);
  }
  const r = await call(`/story/logs/page?${qs.toString()}`);
  const all = Array.isArray(r?.data) ? r.data : [];
  const list = gid
    ? all.filter((x) => {
        const s = String(x.groupId ?? '').trim();
        // ⚠️ 两种都认：`QQ-Group:123` / 纯 `123`；用 `endsWith(':' + gid)` 避免 "123" 匹配到 "1234"
        return s === gid || s.endsWith(`:${gid}`) || s.includes(gid);
      })
    : all;
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
  // ⚠️⚠️ 2026-10-23 修（和 `storyLogs` 同一类，实测抓到的）：
  //    海豹按 **`QQ-Group:<群号>`** 定位局；传纯群号时它"能开出局"但只返回 1 条
  //    （实测：纯号 → 1 条；`QQ-Group:999000001` → **200 条** 真实跑团内容）。
  //    ⇒ 传参时补前缀；已经带前缀（`QQ-Group:` / `UI-Group:`）就原样传。
  const qs = new URLSearchParams({
    groupId: /^[A-Za-z]+-Group:/.test(gid) ? gid : `QQ-Group:${gid}`,
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