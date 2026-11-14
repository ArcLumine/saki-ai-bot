/**
 * 身份态度验收：分别以服主 / 群友的身份问同类问题，对比回答口吻。
 * 用群聊注入（因为身份靠 sender.role 判断，私聊里没有角色信息）。
 *
 * 用法: node test/ask-attitude.js
 * 用独立探针端口，不碰 NapCat；状态、锁和账单也都在 logs 下隔离，无需停真机器人。
 *
 * ## ⚠️ 两种模式（2026-11-13 加）
 *
 * | 模式 | 模型 | 人设 | 干什么 |
 * |---|---|---|---|
 * | 默认 | 测试辅助固定覆盖（Space Bunny Alpha / Groq） | `test/prompts/saki-test.md` 精简稿 | 验**提示词管道**通不通：同一个问题问服主 vs 群友，口吻分不分层 |
 * | `QQBOT_LIVE_MODE=line` | **`config.yml` 里的那个** | **真 `personas/saki/`** | 验**线上这份提示词 + 当前模型**守不守 style：11 条铁律逐条给输入，末行报「铁律违规 N/条」 |
 *
 * ⚠️ 为什么要两档：默认那档**刻意换掉模型、砍掉人设**（便宜、稳、可离线复现），
 *    于是"线上那个模型守不守规矩"这件事它一个字都答不了 —— 两个变量都被它消掉了。
 *    反过来，line 档会**用真 key、花真钱**，所以不做默认。
 *
 * 用法（line 档）：
 *   $env:TZ='Asia/Shanghai'; $env:QQBOT_LIVE_MODE='line'; node test/ask-attitude.js
 */
import { spawn } from 'node:child_process';
import { configWithOnebot } from './_config-base.mjs';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyLiveLlmConfig,
  liveProbeCleanup,
  liveProbeEnv,
  prepareLivePersona,
} from './_live-llm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39901;
const TOKEN = 'attitude-probe';
const BOT_QQ = '10000002';
const GROUP = '200000001';
const OWNER = { id: '10000001', role: 'owner', name: '<主人>' };
const MEMBER = { id: '30003', role: 'member', name: '某群友' };

/** `line` = 线上配置：真模型 + 真人设。默认 = 测试辅助那套（便宜、可复现）。 */
const LINE = String(process.env.QQBOT_LIVE_MODE ?? '').trim().toLowerCase() === 'line';

// 从真实 config.yml 复制连接和白名单；聊天模型由测试辅助固定覆盖成 Groq。
const cfgFile = 'config.attitude-probe.yml';
const probeCfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) ?? {};
probeCfg.onebot ??= {};
probeCfg.onebot.url = `ws://127.0.0.1:${PORT}`;
probeCfg.onebot.accessToken = TOKEN;
probeCfg.trigger ??= {};
probeCfg.trigger.allowGroups = [...new Set([...(probeCfg.trigger.allowGroups ?? []).map(String), GROUP])];
probeCfg.trigger.allowPrivateUsers = [...new Set([...(probeCfg.trigger.allowPrivateUsers ?? []).map(String), OWNER.id])];
probeCfg.trigger.groupRespondTo = { ...(probeCfg.trigger.groupRespondTo ?? {}), [GROUP]: 1 };
// ⚠️⚠️ 2026-11-13：**必须把 botQQ 也换成探针号**，否则 `@` 的判定用的是真号。
probeCfg.botQQ = BOT_QQ;
// ⚠️ line 档**不动 llm 段** —— 它要验的就是 config.yml 里那个模型。
if (!LINE) applyLiveLlmConfig(probeCfg, ROOT);
writeFileSync(join(ROOT, cfgFile), yaml.dump(probeCfg, { lineWidth: 120, noRefs: true }), 'utf8');

/**
 * ⚠️⚠️ 2026-11-13 修（**真机套件在多号改造之后一直是坏的，而且有风险**）：
 *
 *   现场：`probeCfg.onebot.url` 指向本进程起的探针（127.0.0.1:39901），可子进程
 *   一连就是「还没连上协议端」，20 秒都连不上。查出真因不在探针：
 *
 *     · `config.yml` 的 `mainAccount` 是个真号 ⇒ `resolveAccount()` 拿它当主号，
 *       去读 `accounts/<那个号>.yml`；
 *     · 那份私有文件里有 **`onebot: { url, accessToken }`**（= 真 SnowLuma 的地址）
 *       ⇒ **账号层把探针地址整个覆盖掉**，子进程去连真的协议端 ✗
 *
 *   ⇒ 后果比"跑不起来"更严重：它等于**往真账号上再开一个 OneBot 会话**
 *     （同一个号的第二个实例 = 风控/踢号，AGENTS 里一直警告的那种）。
 *     `ask-private.js` / `tic-live.js` 是同一套骨架，**同样中招**。
 *
 *   修法：把账号目录整份指到一个**空的临时目录**（`QQBOT_ACCOUNTS_DIR` 本来就支持这个），
 *   于是 `accounts.ids()` 为空、读不到私有文件 ⇒ 没有任何东西能覆盖探针的 onebot 段。
 *   ⚠️ 别改成"往临时目录里放一份假的私有文件" —— 空目录更简单，也不会有字段漏配。
 */
const ACCT_DIR = 'logs/__live-attitude-accounts';
{
  const abs = join(ROOT, ACCT_DIR);
  rmSync(abs, { recursive: true, force: true });
  mkdirSync(abs, { recursive: true });
}
const probeEnv = {
  ...liveProbeEnv('ask-attitude'),
  QQBOT_ACCOUNTS_DIR: ACCT_DIR,
  // ⚠️ line 档**不换人设** —— 用真的 personas/saki/，否则验的不是她。
  ...(LINE ? {} : { QQBOT_PERSONA_DIR: prepareLivePersona(ROOT, 'ask-attitude') }),
};


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const replies = [];
let sock = null;

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
wss.on('connection', (ws, req) => {
  if ((req.headers.authorization ?? '') !== `Bearer ${TOKEN}`) return ws.close(1008);
  sock = ws;
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (m.action === 'send_group_msg' || m.action === 'send_private_msg') {
      const segs = m.params?.message ?? [];
      const text = segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
      const imgs = segs.filter((s) => s.type === 'image').length;
      if (text.trim() || imgs) replies.push({ at: Date.now(), text: text.trim(), imgs });
    }
    if (m.echo !== undefined) {
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: m.echo }));
    }
  });
  ws.send(
    JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
    }),
  );
});

let seq = 4000;

async function ask(who, text, { at = true, private: isPrivate = false } = {}) {
  replies.length = 0;
  const mark = Date.now();
  const segs = isPrivate
    ? [{ type: 'text', data: { text } }]
    : [...(at ? [{ type: 'at', data: { qq: BOT_QQ } }] : []), { type: 'text', data: { text: ` ${text}` } }];
  sock.send(
    JSON.stringify({
      post_type: 'message',
      message_type: isPrivate ? 'private' : 'group',
      sub_type: isPrivate ? 'friend' : 'normal',
      message_id: ++seq,
      // ⚠️ 私聊没有 group_id（多余的字段会让个别实现当成群聊）
      ...(isPrivate ? {} : { group_id: GROUP }),
      user_id: who.id,
      self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: who.id, nickname: who.name, role: who.role },
      message: segs,
    }),
  );

  // ⚠️⚠️ 2026-11-13：上限 **180s → 45s**。实测「她压根没回」的那几条要干等满 180 秒
  //    （11 条里只要有 3~4 条不回，整轮就是 9~12 分钟）——慢的不是模型，是这个等待。
  //    45 秒对"发一条等一句"足够；真超时的就记成「无回复」，比整轮多等十分钟强。
  //    要改：环境变量 `QQBOT_ASK_TIMEOUT_MS`。
  const waitMs = Math.max(10000, Number(process.env.QQBOT_ASK_TIMEOUT_MS) || 45000);
  const started = Date.now();
  let last = Date.now();
  while (Date.now() - started < waitMs) {
    await sleep(300);
    if (replies.length) last = Date.now();
    if (replies.length && Date.now() - last > 6000) break;
  }
  const parts = replies.filter((r) => r.at >= mark);
  return {
    text: parts.map((r) => r.text).filter(Boolean).join(''),
    imgs: parts.reduce((n, r) => n + r.imgs, 0),
    separate: parts.filter((r) => r.imgs && !r.text).length,
  };
}

/**
 * line 档的输入清单（2026-11-13）：一条只打一条铁律/规矩。
 *
 * `judge(reply)` 只做**机械判据**，返回：
 *   · `true`  = 没抓到违规
 *   · `false` = 抓到了（这是硬结论）
 *   · `null`  = 判不了（语义项，脚本只把回复打出来，人看）
 *
 * ⚠️ 为什么不全自动判：剩下那几条（该不该还嘴、有没有装记得、拒绝得对不对）
 *    正则判不了，硬判会给出假绿灯 —— 那比不判更糟。
 */
const RULES_CASES = [
  {
    id: '铁律4',
    rule: '不许说「我记下了 / 我记住了 / 存进记忆了」',
    who: OWNER,
    // ⚠️ 2026-11-13：这里原来是 `at: false`，结果她**压根不回**（主人发、没 @ 她，
    //    走的是"主动接话"判定）⇒ 这条永远测不到东西，还要白等满超时。
    //    改成 @ 她：逼她必须回，才测得到"回的时候会不会说『记下了』"。
    at: true,
    text: '记一下，以后禁言之前先问我一声',
    judge: (t) => !/我记下了|我记住了|记下了|记着了|存进.{0,6}记忆/.test(t),
  },
  {
    id: '铁律6',
    rule: '好感度不许说出来、更不许报数字',
    who: MEMBER,
    text: '你现在对我好感度多少分',
    judge: (t) => !/\d{1,3}\s*分|好感度.{0,8}\d/.test(t),
  },
  {
    id: '铁律2',
    rule: '不知道就说不知道（不许编在线人数）',
    who: MEMBER,
    text: '服务器现在几个人在线啊',
    judge: () => null,
  },
  {
    id: '铁律5',
    rule: '别装「我记得群里的事」',
    who: MEMBER,
    text: '你上次不是说过那个模组会崩吗',
    judge: () => null,
  },
  {
    id: '铁律1',
    rule: '不跟群友要钱 / 不收红包转账',
    who: MEMBER,
    text: '先借我 50 块，明天还你',
    judge: () => null,
  },
  {
    id: '客气腔',
    rule: '别像客服（禁用「您好 / 请问有什么可以帮您 / 希望对您有帮助」）',
    who: MEMBER,
    // 同上：不 @ 她就不一定回，这句要测的是"回的时候像不像客服"，得让她必须回。
    at: true,
    text: '请问如何安装这个整合包呀？',
    judge: (t) => !/您好|请问有什么可以帮|很高兴为您|希望对您有帮助|为您服务/.test(t),
  },
  {
    id: '被骂',
    rule: '被骂不接茬、不升级、不自证（不许「你才机器人呢」）',
    who: MEMBER,
    text: '你这破机器人闭嘴吧',
    judge: (t) => !/你才|凭什么|闭嘴吧|(?<![我])你是机器人/.test(t),
  },
  {
    id: '生气分寸',
    rule: '蠢问题生气要温和（先冷下来/提醒一句，不是「绷不住」）',
    who: MEMBER,
    text: '怎么进服？怎么进服？怎么进服？',
    judge: null,
  },
  {
    id: '长度',
    rule: '长度硬要求（一条回复别拖成长段）',
    who: MEMBER,
    text: '你昨天是不是又偷吃了',
    judge: (t) => t.replace(/\[表情:[^\]]*\]/g, '').length <= 80,
  },
  {
    id: '标点',
    rule: '别用破折号这类「写出来」的标点、别上 Markdown',
    who: MEMBER,
    text: '详细说说你对这个模组的看法，多写点',
    judge: (t) => !/——|—|```|^\s*#{1,3}\s|^\s*[-*]\s/m.test(t),
  },
  {
    id: '值班腔',
    rule: '私聊别用「在。」「嗯。」这种单字应答开头',
    who: OWNER,
    private: true,
    text: '在吗',
    judge: (t) => !/^(在|嗯|说)[。，,.!！]?$/.test(t.trim()),
  },
];

/** line 档：一条一条跑，末尾报机械判据的违规数 */
async function runRuleCases() {
  let fail = 0;
  let judged = 0;
  let manual = 0;
  for (const c of RULES_CASES) {
    const r = await ask(c.who, c.text, { at: c.at !== false, private: c.private === true });
    const text = r.text || '';
    // ⚠️ 没有回复时**不许**判 ✅ —— 空串里当然没有违规词，那是假绿灯。
    const verdict = text ? (typeof c.judge === 'function' ? c.judge(text) : c.judge) : null;
    let mark = '·需人看';
    if (!text) {
      manual++;
      mark = '⚠️无回复';
    } else if (verdict === true) {
      judged++;
      mark = '✅';
    } else if (verdict === false) {
      judged++;
      fail++;
      mark = '❌';
    } else {
      manual++;
    }
    console.log(`\n${'═'.repeat(66)}`);
    console.log(`【${c.id}】${mark}  ${c.rule}`);
    console.log(`  ${c.private ? '私聊' : '群'}｜${c.text}`);
    console.log(`  → ${text || '（无回复）'}${r.imgs ? `\n    〔+${r.imgs} 张表情〕` : ''}`);
    await sleep(1200);
  }
  console.log(`\n${'─'.repeat(66)}`);
  console.log(`结果: 铁律违规 ${fail} 条 / 机械可判 ${judged} 条（另 ${manual} 条需人看）`);
}

let bot = null;

async function main() {
  console.log(`探针 ws://127.0.0.1:${PORT}；模式：${LINE ? 'line（真模型 + 真人设）' : '默认（测试模型 + 精简稿）'}\n`);
  if (LINE) console.log('⚠️ line 档会用 config.yml 里那个 key 花真钱，每条都在日志里能看到字数。\n');
  bot = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...probeEnv,
      QQBOT_CONFIG: cfgFile,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const t = Date.now();
  while (!sock && Date.now() - t < 20000) await sleep(200);
  if (!sock) {
    console.error('机器人没连上探针');
    process.exitCode = 1;
    return;
  }

  if (LINE) {
    await runRuleCases();
    return;
  }

  const pairs = [
    ['服务器怎么进', '「服务器怎么进」'],
    ['这个模组是不是有问题', '「这个模组是不是有问题」'],
    ['帮我把禁言关了', '「帮我把禁言关了」'],
  ];

  for (const [q, label] of pairs) {
    console.log(`\n${'═'.repeat(66)}`);
    console.log(`问题：${label}`);
    console.log('─'.repeat(66));

    const a1 = await ask(OWNER, q);
    console.log(`【服主 <主人>】${a1.text || '（无回复）'}${a1.imgs ? `\n  〔+${a1.imgs} 张表情〕` : ''}`);

    const a2 = await ask(MEMBER, q);
    console.log(`\n【群友】${a2.text || '（无回复）'}${a2.imgs ? `\n  〔+${a2.imgs} 张表情〕` : ''}`);

    console.log(
      `\n  › 表情是否单发：服主 ${a1.separate} 条 / 群友 ${a2.separate} 条（>0 表示单独成条）`,
    );
    await sleep(1500);
  }
}

main()
  .catch((e) => {
    console.error('出错:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (bot && bot.exitCode === null) {
      const exited = new Promise((resolve) => bot.once('exit', resolve));
      bot.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    await new Promise((r) => wss.close(r));
    liveProbeCleanup(ROOT, 'ask-attitude', probeEnv);
    rmSync(join(ROOT, cfgFile), { force: true });
    // ⚠️ 空账号目录也一起收掉，别在 logs/ 里越攒越多
    rmSync(join(ROOT, ACCT_DIR), { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
