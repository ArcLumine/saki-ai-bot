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
 * 小祥要不要**替海豹转述**骰点（唯一判定入口，调用点只认这个）。
 *
 * ⚠️ 这是 2026-10-06 加的，用来解决「重复处理」—— 群里有人打 `.ra` 时，
 *   海豹自己算并回一次；若小祥同时转述，就变成**两条结果**。
 *
 *   `sealdice.relay` 三种取值：
 *   · `true`（**默认**）= 海豹**不接 IM**，一律由小祥转述（原来的方案甲）
 *   · `false`          = 海豹**已接同一个 QQ**、自己收发 ⇒ 小祥全程闭嘴
 *   · `'fallback'`     = 海豹接了 IM，但**离线时由小祥兜底**（在线自动让位）
 *
 * ⚠️ **默认 true 是刻意的**：海豹要是没接 IM 而这里关了，群里打 `.ra`
 *   就会彻底没人理 —— 那是更糟的故障。
 *
 * @param {'group'|'private'} [type] 探在线时要用的消息类型
 * @returns {Promise<boolean>} 该不该由小祥转述这一条
 */
export async function shouldRelay(type = 'group') {
  const mode = cfg().relay;
  if (mode === false) {
    // ⚠️ 海豹自己收发。仍然**消费掉**这条指令（bot.js 那侧照样 return true），
    //    别让它掉进 decide() 让小祥对骰点结果发表评论 —— 那样更吵。
    return false;
  }
  if (mode === 'fallback') {
    // ⚠️ 海豹在线就让它自己回；探不通（挂了/没起）才由小祥兜底。
    if (await sealdiceOnline()) return false;
    log.debug('[海豹] 在线探针不通 ⇒ 由小祥兜底转述（relay: fallback）');
    return true;
  }
  return true;
}

/**
 * 海豹现在在线吗？（只探在线，不探功能）
 *
 * ⚠️ 打的是 `/sd-api/preInfo` —— 那是**唯一免 token** 的接口。
 *   拿不到就当离线。宁可多转述一次，也别让群里的骰点没人应。
 *
 * @returns {Promise<boolean>} 探通了就是 true
 */
async function sealdiceOnline() {
  const c = cfg();
  const base = String(c.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) return false;
  const ms = Math.max(500, Number(c.timeoutMs) || 4000);
  const opt = { method: 'GET', headers: { token: String(c.token ?? '') } };
  if (typeof AbortSignal?.timeout === 'function') opt.signal = AbortSignal.timeout(ms);
  try {
    const res = await fetch(`${base}/sd-api/preInfo`, opt);
    return res.ok;
  } catch (e) {
    log.debug(`海豹在线探针失败（按离线处理）：${e.message}`);
    return false;
  }
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
 *    `UI-Group:2001`（`api/api_bind.go` 的 `DiceExec` 同一个文件那几行）。
 *    所以按 scopeId 过滤结果永远为空。这里照实传，只是为了将来海豹真接了 IM 才对。
 *
 * ⚠️⚠️⚠️ **为什么每次都要先 `.nn` 改昵称**（2026-10-06 实测 + 读 `sealdice-core-src`）：
 *    `DiceExec` 把发件人**写死**成 `SenderBase{Nickname:"User", UserID:"UI:1002"}`，
 *    body 里**没有任何字段能传昵称**（只有 id/message/messageType/messageSplitLen）。
 *    ⇒ 直接转发的话，海豹那边永远是 `<User>`，输出一律是「<User>的"敏捷5"检定结果为…」。
 *    而海豹的 `.nn <昵称>`（改昵称）在 UI 测试模式下**是可用的**：
 *      `.nn 阿祥` → `<User>(UI:1002)的昵称被设定为<阿祥>`，随后 `.ra` 就变成 `<阿祥>的…`。
 *    ⇒ 所以调用方要在转发前先 `setName()`，让结果里出现的是**真的那个人的昵称**，
 *      而不是占位符 `<User>`。这正是用户 2026-10-06 报的「只会回预设/占位符」。
 *    ⚠️ 由此带来的**已知限制**：`UserID` 仍是固定的 `UI:1002`，所以海豹那边
 *      **所有群友共用一张卡**（`.st` 属性、`.li` 列表都是同一份）。
 *      要真正每人一张卡，只能让海豹自己接 IM —— 那是架构问题，见文件头「方案甲」。
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
    // ⚠️ messageSplitLen: 不传 ⇒ 海豹按 QQ 风格分段（实测 `.st` 回 3 段
    //    「[1/3]…[3/3]」）。**我们要的是完整的一段**，不然调用方只取最后一条就会
    //    拿到 `[ 3 / 3 ]` 那一截（这是 2026-10-06 用户报「别的指令都不对」的第二个原因）。
    //    0 = 无限分段。海豹的取值校验在 `isValidUITestReplySplitLen`。
    const body = { id: String(scopeId), message: text, messageType, messageSplitLen: 0 };
    const res = await callRaw('/dice/exec', 'POST', body);
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
 * 告诉海豹「接下来这条是**这个人**发的」。
 *
 * ⚠️⚠️ 为什么需要这个（2026-10-06 实测）：海豹的 `/dice/exec` 把发件人写死成
 *    `Nickname:"User"` / `UserID:"UI:1002"`（源码 `api/api_bind.go` 的 `DiceExec`），
 *    API **不接受**昵称字段。所以不先改名的话，海豹所有输出都是 `<User>` 占位符。
 *    `.nn <昵称>` 是海豹自己的「改昵称」指令，在 UI 测试模式下可用。
 *
 * ⚠️ **为什么用 `setName` 而不是「干脆不改」**：海豹很多指令的结果里带说话人
 *    （`.ra` → `<名字>的"敏捷5"检定结果为…`、`.st show` → `<名字>的个人属性为…`）。
 *    不改就是满屏 `<User>`，用户 2026-10-06 明确说「回复正常的东西而不是占位符」。
 *
 * ⚠️ 顺序上**必须先改名再 exec 指令**，所以这里返回的是「改名成功没」，
 *    由 `ask()` 决定要不要继续 —— 改名失败不该让整条骰点丢掉。
 *
 * @param {string} nickname 昵称（**别带空格和尖括号**，海豹指令按空格切参数）
 * @returns {Promise<boolean>} 有没有改成（改不了就当没改，让后面的指令照发）
 */
export async function setName(nickname, messageType = 'group') {
  if (!enabled()) return false;
  // ⚠️ 海豹指令按空格切参数；尖括号是它的「显示名」包裹符，自己带上会被吃掉。
  const name = String(nickname ?? '').trim().replace(/[\s<>]/g, '').slice(0, 24);
  if (!name) return false;
  // ⚠️ 海豹对 group 模式有 500ms 限流（`DiceExec` 的 `lastGroupExecTime`），
  //    连着两条必须隔开，否则第二条回 400「过于频繁」。这里睡够再发指令。
  await sleep(cfg().nameGapMs || 520);
  const ok = await roll(`.nn ${name}`, '', messageType);
  if (!ok) log.debug(`海豹：改昵称为「${name}」失败，后续输出可能还是 <User>`);
  return ok;
}

/** 小睡（内部用，别导出 —— 导出只会让调用点到处 spread 一堆 setTimeout） */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
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
 * @param {{scopeId?:string, messageType?:'group'|'private', timeoutMs?:number,
 *          nickname?:string}} [opts]
 *   ⚠️ `nickname`（2026-10-06 加）：海豹那边发件人写死成 `User`，给昵称才会先 `.nn` 改掉。
 * @returns {Promise<string>} 结果文本；没算出来返回空串
 */
export async function ask(message, opts = {}) {
  const scopeId = opts.scopeId ?? '';
  const type = opts.messageType ?? 'group';
  // ⚠️⚠️⚠️ **串行化**：海豹的「UI 测试」适配器只有**一个**作用域
  //    （`DiceExec` 里写死的 `UI-Group:2001` / `UserID:"UI:1002"`），
  //    而且 `/dice/recentMessage` 是**读后即清**（源码 `DiceRecentMessage`
  //    结尾 `defer pa.RecentMessage = []{}`）。
  //    ⇒ 两个人同时掷骰，A 的结果会被 B 读走；名字也会互相覆盖。
  //    ⇒ 这里排队，一条一条来。多等一会儿总比回错人的话好。
  return enqueue(() => askNow(message, { ...opts, scopeId, messageType: type }));
}

/** 极简串行队列（`ask` 的并发闸）—— 不引 p-queue，整个项目没有这个依赖 */
let chain = Promise.resolve('');
function enqueue(fn) {
  const next = chain.then(fn, fn);
  // ⚠️ 兜底：队列本身**永不 reject**，否则一次失败会把后面全卡住。
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function askNow(message, opts = {}) {
  const scopeId = opts.scopeId ?? '';
  const type = opts.messageType ?? 'group';

  // ⚠️⚠️ **先「清场」**：读一次 recentMessage 就是把它清空
  //    （上面 `DiceRecentMessage` 的 defer）。所以这里读一次不是为了看内容，
  //    是为了**丢掉上一条指令的残留结果**，免得当成这条的答案发出去。
  await rawRecent();

  // ① 先报上名字：海豹那边发件人写死成 `User`，不 `.nn` 的话输出全是 `<User>` 占位符
  //    ⚠️ 只在**给了昵称**时才做 —— 没名字就别多花一次网络往返 + 500ms 限流。
  if (opts.nickname) {
    await setName(opts.nickname, type);
    // ⚠️⚠️ 改昵称自己也会产生一条 recentMessage（`<User>(UI:1002)的昵称被设定为<X>`），
    //    不清掉就会跟着指令结果一起发到群里 ⇒ 每次掷骰多一句废话。
    //    ⚠️⚠️ 但**光靠「读完即清」不够**：`dice/exec` 是异步的（立刻回 `ok`，
    //    结果过一会儿才进列表），所以刚 `setName` 完就清**通常清不到** ——
    //    实测那条 ack 还是漏进了 `.help ra` 的结果里。
    //    ⇒ 双保险：① 先睡一小会儿让 ack 落进列表再清；② 清完再滤一遍正文
    //      （`resultTexts()` 里按 `昵称被设定为` 过滤），任一条路生效就行。
    await sleep(cfg().ackWaitMs || 400);
    await rawRecent();
  }

  // ② 送指令
  if (!await roll(message, scopeId, type)) return '';

  // ③ 轮询到出现结果为止
  //    ⚠️ 判据是「**读到了东西**」而不是「条数变多」—— 因为读操作本身会清空列表，
  //    条数永远是 0→n→0，用长度差判断必然时序错位（这正是旧实现拿到
  //    「上一个人的结果」的原因）。
  const wait = Math.max(150, Number(opts.timeoutMs) || Number(cfg().answerWaitMs) || 1500);
  const step = 250;
  for (let waited = 0; waited <= wait; waited += step) {
    if (waited) await sleep(step);
    const list = await rawRecent();
    // ⚠️ 取**全部**条目，不是只取最后一条：海豹一条指令可能回好几段
    //    （实测 `.help ra` 回 `[1/2]` `[2/2]`；`messageSplitLen=0` 只关掉
    //    「按长度切段」，关不掉指令自己分多条回复的情况）。
    //    只取最后一条 = 群里只看到最后一段（用户 2026-10-06 报的就是这个）。
    const text = resultTexts(list);
    if (text) return text;
  }
  // ⚠️ 到点还没结果：**宁可不说**。
  //    旧实现在这里会「兜底取最后一条」—— 但列表已被清空，取到的是空/别人的，
  //    只会把噪音发到群里。空串 ⇒ 调用点静默（这本来就是「骰娘模式」要的）。
  log.debug(`海豹：等到 ${wait}ms 仍没结果，放弃（「${message}」）`);
  return '';
}

/**
 * 把 `recentMessage` 的原始列表拼成**能直接发群里**的文本。
 *
 * ⚠️ 两条处理规则，都是实测踩出来的：
 *   ① **全要**，不只取最后一条 —— 海豹一条指令能回好几段（`.help ra` 回 `[1/2] [2/2]`）。
 *   ② **滤掉「改昵称」的 ack** —— `<X>(UI:1002)的昵称被设定为<Y>` 是我们自己的
 *      `.nn` 引起的，**不该出现在群里**。`askNow()` 里已经尽力在改完名字后清场，
 *      但 `dice/exec` 是异步的（立刻回 `ok`，结果稍后才进列表）⇒ 竞态仍在，
 *      这里再兜一道底。宁可漏滤也不能误发。
 *
 * @param {Array} list `/dice/recentMessage` 的返回
 * @returns {string} 拼好的正文；全是噪音时返回空串
 */
function resultTexts(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => String(x?.message ?? '').trim())
    // ⚠️ 只滤「整条就是 ack」的，不做 includes —— 海豹正常回复里也可能提到「昵称」。
    //   实测原文：`<User>(UI:1002)的昵称被设定为<阿祥>` ⇒ 必须吃到结尾那个 `>`。
    .filter((s) => s && !/昵称被设定为<[^>]*>$/.test(s))
    .join('\n')
    .trim();
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