/**
 * 真机验收的 LLM 配置与隔离环境。
 *
 * 凭据只从 `logs/*.key` 读取；这个目录已被 Git 忽略。调用方不应把 key
 * 写进 config.yml、测试输出或文档。
 *
 * ⚠️⚠️ 2026-10-03：**默认 provider 已从 Groq 改成 Space Bunny Alpha**
 *    （`stealth/space-bunny-alpha`，OpenRouter）。理由见 `applyLiveLlmConfig`
 *    那段：口吻验收必须用实际在跑的那个模型，否则验的是模型差异不是人设。
 *    Groq（`openai/gpt-oss-120b`）保留为备选 ——
 *    `QQBOT_LIVE_PROVIDER=groq node test/ask-attitude.js`。
 *
 *    ⚠️ OpenRouter 那把 key 明文进过聊天记录，**建议后台轮换**后再填
 *    `logs/openrouter.key`（已 .gitignore）。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIVE_LLM_BASE_URL = 'https://api.groq.com/openai/v1';
export const LIVE_LLM_MODEL = 'openai/gpt-oss-120b';
export const LIVE_PERSONA_PROMPT = 'test/prompts/saki-test.md';

// ⚠️⚠️ 2026-10-02 修（这次改动直接决定真机验收有没有意义）：
//
// ① **模型从 20B 换成 120B** —— 原来写 `gpt-oss-20b`，理由是「比 120B 快，适合反复验收」。
//    但 AGENTS.md 里记的「口吻分层比 DeepSeek 弱」很可能就是这个原因，而不是人设问题：
//    小模型的角色分层能力弱。验收的目的是**判断口吻**，那就必须用生产同款
//    （`config.yml` 里就是 `gpt-oss-120b`）。慢是应该的 —— 验收本来就不该快。
//
// ② **promptMaxChars 原本写死 5000**，注释是「精简测试人设约 2k 字，防意外撑大」。
//    ⚠️ 这个上限在 `_shared/style.md` 拆出去之后**就失效了**：共用层是 61,839 字节，
//    5000 会把它截掉一大半 ⇒ 验收等于在验一个**被腰斩的 style.md**。
//    现在按共用层的**实际注入长度**给上限，并留出知识库/动态上下文的余量。
//
// 这两条都是「共用层拆出去后，依赖旧假设的地方没跟着更新」—— 和
// `persona.md` 注释里写「style.md 那里 25K」（实际 61K）同一类问题。

// ⚠️⚠️ 2026-10-02 **我改错了又改回来**，动手前必读这段 ↓
//
// 【我犯的错】我把 `promptMaxChars: 5000` 调成了 120000，理由是「5000 会腰斩 style.md」。
// 【用户的纠正】**5000 是故意的**：有些模型上下文上限就那么长，**5000 是「跑快速」用的**。
//   —— 不是疏漏，不是「拆分前遗留的过时数字」，是**一个刻意选的快速档**。
// 【连带】我改 `test/live-persona.js` 那条钉死 5000 的断言，也是错的 ——
//   **那条断言正是在保护这个快速档**，它不是过时包袱。
//
// 【教训】`promptMaxChars: 5000` 看着像「没跟上共用层拆分」，实际是**人为选的档位**。
//   下次看到"数字和现状对不上"，**先问是 bug 还是有意为之**，别直接改。
//
// 【现在】两档都留着：
//   · 默认 120000 = 完整档，装得下整个共用层 style.md，用途是**验口吻**
//   · FAST  5000   = 快速档，**给上下文上限小的模型用**（用户 2026-10-02 说明）
//   切换：`QQBOT_LIVE_FAST=1 node test/ask-attitude.js`
// ⚠️ 快速档**会**截断 style.md ⇒ 只在验「代码有没有坏」这类不看口吻的场景用。
//    验口吻必须完整档，否则又是「验了个被腰斩的 style.md」。
const LIVE_PROMPT_MAX_CHARS = 120000;

/** 快速档 —— 用户 2026-10-02 明确说明：给上下文上限小的模型用，**别当成过时数字改掉**。 */
const LIVE_PROMPT_MAX_CHARS_FAST = 5000;

// ── 可选的第二把钥匙：OpenRouter（2026-10-02 用户加）────────────────────
// ⚠️ 为什么要第二把：Groq 那把和 `config.yml` 是**同一把**（实测前缀都是 gsk_4T…）。
//    一把钥匙同时用于生产与验收，意味着**验收烧的额度算在生产账上**，
//    而且哪天生产 key 失效，验收会跟着一起挂、看不出是哪边的问题。
//    两把分开才能独立判断「是验收环境坏了还是生产坏了」。
//
// 凭据：`logs/openrouter.key`（`logs/` 已被 .gitignore:12 忽略）。
// ⚠️ 这把 key 明文进过聊天记录，**建议在 OpenRouter 后台轮换**后再填进那个文件。
//
// 用法：`applyLiveLlmConfig(cfg, ROOT, 'openrouter')`；
//      或环境变量 `QQBOT_LIVE_PROVIDER=openrouter`（下面 applyLiveLlmConfig 会读）。
export const LIVE_PROVIDERS = {
  groq: {
    baseURL: LIVE_LLM_BASE_URL,
    model: LIVE_LLM_MODEL,
    keyFile: 'logs/groq.key',
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    // ⚠️ 用户 2026-10-02 指定：**Space Bunny Alpha**。
    //   slug 是实查 `GET /api/v1/models` 得到的（名字叫 "Space Bunny Alpha"，
    //   搜 bunny 才会命中，别猜 slug —— 隔壁一堆 SpaceXAI:* 是噪音）。
    model: 'stealth/space-bunny-alpha',
    keyFile: 'logs/openrouter.key',
  },
};

/**
 * 为真机验收准备临时人设包。
 *
 * identity.json 仍来自真实 Saki（名字、称呼、句首/句末口癖都测真实配置），
 * persona.md 则换成固定的精简测试稿。生产人设完全不动。
 */
export function prepareLivePersona(root, name, sourceId = 'saki') {
  const safe = String(name).replace(/[^\w.-]/g, '_');
  const rel = `logs/__live-${safe}-persona`;
  const dir = join(root, rel);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(root, 'personas', sourceId, 'identity.json'), join(dir, 'identity.json'));
  writeFileSync(join(dir, 'persona.md'), readFileSync(join(root, LIVE_PERSONA_PROMPT), 'utf8'), 'utf8');

  // 共用层：必须跟着人设包一起搬到 `logs/_shared`（见上方 2026-10-02 的说明）。
  // ⚠️ 拷的是**当时的** style.md 快照 —— 压缩 style.md 时，每次跑验收前重新
  // prepareLivePersona() 即可拿到最新版本，不要手动改这里。
  const sharedSrc = join(root, 'personas', '_shared');
  const sharedDst = join(root, 'logs', '_shared');
  if (existsSync(sharedSrc)) {
    rmSync(sharedDst, { recursive: true, force: true });
    cpSync(sharedSrc, sharedDst, { recursive: true });
  }
  return rel;
}

export function applyLiveLlmConfig(cfg, root, providerOrKeyFile) {
  // ⚠️⚠️ 2026-10-03 **默认从 Groq 换成 Space Bunny Alpha**（用户要求）。
  //
  // 为什么换：口吻验收的结论只对**实际在用的那个模型**成立。
  // 之前拿 Groq 验口吻、拿另一套跑生产 ⇒ 验出来的分层弱很可能是模型差异，
  // 不是人设问题（`_live-llm.js` 头部那段「20B→120B」的教训就是同一个坑）。
  // 想临时验 Groq：`QQBOT_LIVE_PROVIDER=groq node test/ask-attitude.js`。
  //
  // ⚠️ 优先级从高到低：
  //   ① 显式传参 `applyLiveLlmConfig(cfg, ROOT, 'groq')`
  //   ② 环境变量 `QQBOT_LIVE_PROVIDER=groq`（**默认走这条** ——
  //      `ask-private.js` / `ask-attitude.js` / `tic-live.js` 都是无参调用，
  //      所以改环境变量就能整体切换，三个脚本一行都不用改）
  //   ③ 不给 → **openrouter（Space Bunny Alpha）** —— 当前默认
  //
  // 🔙 想换回旧默认：把下一行的 `'openrouter'` 改成 `'logs/groq.key'`。
  const chosen = providerOrKeyFile ?? process.env.QQBOT_LIVE_PROVIDER ?? 'openrouter';
  // 两种传法都兼容：
  //   'openrouter'                      → 走 LIVE_PROVIDERS 里那套
  //   'logs/groq.key' / 'xxx.key'       → 老写法，显式指定 key 文件（base/model 仍取 Groq）
  const p = LIVE_PROVIDERS[chosen];
  const baseURL = p ? p.baseURL : LIVE_LLM_BASE_URL;
  const model = p ? p.model : LIVE_LLM_MODEL;
  const keyFile = p ? p.keyFile : chosen;
  const file = join(root, keyFile);
  if (!existsSync(file)) {
    throw new Error(`缺少验收用的 API key：${keyFile}（该文件必须保持被 Git 忽略）`);
  }
  const apiKey = readFileSync(file, 'utf8').trim();
  if (!apiKey) throw new Error(`Groq key 文件是空的：${keyFile}`);

  cfg.llm = {
    ...(cfg.llm ?? {}),
    baseURL,
    apiKey,
    model,
    timeout: 180000,
    timeoutMax: 180000,
    temperature: 0.6,
    thinking: 'off',
    reasoningEffort: 'low',
    // ⚠️ 2026-10-02：原写死 5000（注释「精简测试人设约 2k 字」）——
    //    那是在 style.md 还没拆成共用层之前的数。现在共用层 61,839 字节**必须全量进**，
    //    截断就等于在验一个腰斩的 style.md。见文件头 ②。
    promptMaxChars: process.env.QQBOT_LIVE_FAST ? LIVE_PROMPT_MAX_CHARS_FAST : LIVE_PROMPT_MAX_CHARS,
    maxTokens: 1200,
    adaptiveRateLimit: true,
  };
  // 真机验收只测聊天，不开管理台、在线记录、主动说说/日常/剧情，避免额外调用与写入。
  cfg.webui = { ...(cfg.webui ?? {}), enable: false };
  cfg.sessions = { ...(cfg.sessions ?? {}), enable: false };
  cfg.qzone = { ...(cfg.qzone ?? {}), enable: false, auto: false };
  cfg.life = { ...(cfg.life ?? {}), enable: false };
  cfg.quest = { ...(cfg.quest ?? {}), enable: false };
  cfg.imagegen = { ...(cfg.imagegen ?? {}), enable: false };
  return cfg;
}

/** 与 run-all 同一原则：探针的 state / lock / request 文件全部放 logs，绝不碰真实状态。 */
export function liveProbeEnv(name, pid = process.pid) {
  const safe = String(name).replace(/[^\w.-]/g, '_');
  const p = (what) => `logs/__live-${safe}-${what}.json`;
  return {
    QQBOT_SPEND_FILE: p('spend'),
    QQBOT_SPEND_BASE: p('spendbase'),
    QQBOT_BALANCE_FILE: p('balance'),
    QQBOT_MONTHLY_FILE: p('monthly'),
    QQBOT_TIC_FILE: p('tic'),
    QQBOT_RECENT_FILE: p('recent'),
    QQBOT_HANDLED_FILE: p('handled'),
    QQBOT_AFFINITY_FILE: p('affinity'),
    QQBOT_NAMES_FILE: p('names'),
    QQBOT_FRIEND_FILE: p('friend'),
    QQBOT_STORYLINE_FILE: p('storyline'),
    QQBOT_LIFE_FILE: p('life'),
    QQBOT_QUEST_FILE: p('quest'),
    QQBOT_MEAL_FILE: p('meal'),
    QQBOT_WHERE_FILE: p('where'),
    QQBOT_REMIND_FILE: p('remind'),
    QQBOT_MAMA_FILE: p('mama'),
    QQBOT_QZONE_FILE: p('qzone'),
    QQBOT_DIGEST_FILE: p('digest'),
    QQBOT_OBSERVE_FILE: p('observe'),
    QQBOT_OUTBOX_FILE: p('outbox'),
    QQBOT_SESSIONS_FILE: p('sessions'),
    QQBOT_NAPCAT_REQ_FILE: p('napcat'),
    QQBOT_LOCK_FILE: p(`pid-${pid}-lock`),
    NO_PROXY: '127.0.0.1,localhost,::1',
  };
}

export function liveProbeCleanup(root, name, env) {
  const safe = String(name).replace(/[^\w.-]/g, '_');
  for (const [key, rel] of Object.entries(env)) {
    if (!key.startsWith('QQBOT_') || !String(rel).startsWith('logs/')) continue;
    // 临时人设目录由下面的按测试名清理统一处理；这里只删状态文件。
    if (key === 'QQBOT_PERSONA_DIR') continue;
    rmSync(join(root, rel), { force: true });
    rmSync(join(root, `${rel}.tmp`), { force: true });
  }
  rmSync(join(root, `logs/__live-${safe}-persona`), { recursive: true, force: true });
  // ⚠️ 2026-10-02 加：共用层副本也必须清。
  // 不清的话它会**残留到下一个探针**里 —— 压缩 style.md 后重跑，
  // 拿到的还是上一次的旧共用层 ⇒ 看起来像「改了没生效」。这个假象最难查。
  rmSync(join(root, 'logs', '_shared'), { recursive: true, force: true });
}
