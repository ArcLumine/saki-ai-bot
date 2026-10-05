/**
 * 「谁说的」—— **全项目唯一的发件人显示格式**。
 *
 * ⚠️ 2026-10-04（用户要求：「群聊私聊都是收到同一个格式的提示」）：
 *   改造前**一共有 5 种写法**在提示词/日志里表示同一个人：
 *     · `昵称(QQ号)`          —— `[收到]` 日志、群上下文行、引用行（半角）
 *     · `昵称（QQ 号）`        —— 私聊身份块、群友块（全角）
 *     · `**昵称**（QQ 号，昵称「昵称」）` —— 群聊主人块（异形、还把名字重复了一遍）
 *     · `[QQ 号] 昵称`        —— observe.js 的观察素材（**顺序还反了**）
 *     · `昵称` / `发送者：昵称` / `昵称说：` —— digest.js、speak-judge.js、故事线、affinity.js
 *       （**压根不带号** ⇒ 多人高密度发言时认错人）
 *   ⇒ 模型看到两种括号的写法会当成两种语义，认人也全靠赌。
 *
 * ⇒ 现在统一成**一种**：`昵称(QQ号)`（半角，跟本来就已经统一的群上下文一致）。
 *   凡是要出现「谁说的」的地方，一律走这里 —— 别再自己拼。
 *
 * 为什么两个都要（用户原话：「显示 qq 名而不是 qq 号」—— 实际是**两个都要**）：
 *   昵称会改、会重名（两个群友都叫「小明」），**只靠名字根本认不出人**；
 *   只给号又难读。两个一起最稳。
 */

/**
 * @param {string} [name] 昵称（群名片优先）
 * @param {string|number} [userId] QQ 号
 * @returns {string} `昵称(QQ号)`；缺号退化成纯昵称，缺昵称退化成纯号
 */
export function whoTag(name, userId) {
  const n = String(name ?? '').trim();
  const u = String(userId ?? '').trim();
  // 昵称就是号（某些接口只给数字）→ 别渲染成 `123(123)`
  if (!n || n === u) return u || n;
  return u ? `${n}(${u})` : n;
}

/**
 * 从 IM 事件拿发件人显示串。群聊私聊共用 —— 这就是「同一个格式」的关键。
 *
 * @param {{sender?:{card?:string,nickname?:string}, user_id?:string|number}} event
 * @returns {string} 形如 `大豆(123456789)`；什么都拿不到时返回 `''`
 */
export function senderTag(event) {
  return whoTag(
    event?.sender?.card || event?.sender?.nickname || '',
    event?.user_id,
  );
}
