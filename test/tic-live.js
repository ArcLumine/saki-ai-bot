/**
 * 口癖系统真机验收（手动运行，联网、会消耗 Groq 额度）。
 *
 * 用法：$env:TZ='Asia/Shanghai'; node test/tic-live.js
 *
 * 验证两层：
 *   1. Bot.buildSystemPrompt() 真的把句首/句末软提醒放进最终提示词；
 *   2. 把同一提示词交给 Groq，观察提醒前后的自然回答。
 *
 * ⚠️ 不进入 test/run-all.js：常规回归必须离线。
 * ⚠️ 使用 Saki 人设的临时副本；真实 identity.json、state/tic.json 都不改。
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  applyLiveLlmConfig,
  liveProbeCleanup,
  liveProbeEnv,
  prepareLivePersona,
} from './_live-llm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'tic-live';
const CFG_REL = `logs/__live-${NAME}.yml`;
const PERSONA_REL = prepareLivePersona(ROOT, NAME);
const PERSONA_DIR = join(ROOT, PERSONA_REL);
const REPORT = join(ROOT, 'logs', 'tic-live-last.json');
const GROUP = '200000001';
const QUESTIONS = [
  '给我一句不在深夜做任何决定的建议。',
  '今天有点累，怎么让自己轻松一点？',
  '我拿不定主意时应该先想什么？',
].slice(0, Math.max(1, Math.min(3, Number(process.env.TIC_LIVE_QUESTIONS) || 1)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Groq on-demand 只有 8000 TPM；429 时按服务端建议等待，再重试同一轮。 */
async function withRateLimitRetry(fn, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = String(error?.message ?? '');
      const seconds = Number(message.match(/try again in\s+([\d.]+)s/i)?.[1] ?? 0);
      if (attempt >= 3 || !/429 Too Many Requests|rate limit/i.test(message)) throw error;
      const waitMs = Math.ceil(Math.max(5, seconds + 3) * 1000);
      console.log(`${label} 遇到 TPM 限额，${Math.ceil(waitMs / 1000)} 秒后重试（${attempt}/2）…`);
      await sleep(waitMs);
    }
  }
}

const identityFile = join(PERSONA_DIR, 'identity.json');
const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
identity.style ??= {};
identity.style.verbalTics = { sentenceStart: ['其实'], sentenceEnd: ['呢'] };
writeFileSync(identityFile, JSON.stringify(identity, null, 2), 'utf8');

const cfg = yaml.load(readFileSync(join(ROOT, 'config.yml'), 'utf8')) ?? {};
applyLiveLlmConfig(cfg, ROOT);
writeFileSync(join(ROOT, CFG_REL), yaml.dump(cfg, { lineWidth: 120, noRefs: true }), 'utf8');

const env = liveProbeEnv(NAME);
Object.assign(process.env, env, {
  QQBOT_CONFIG: CFG_REL,
  QQBOT_PERSONA_DIR: PERSONA_REL,
});

const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/chat/completions') && typeof opts.body === 'string') {
    const body = JSON.parse(opts.body);
    requests.push({
      model: body.model,
      maxTokens: body.max_tokens,
      systemChars: (body.messages ?? [])
        .filter((m) => m.role === 'system')
        .reduce((n, m) => n + String(m.content ?? '').length, 0),
      promptChars: (body.messages ?? []).reduce((n, m) => n + String(m.content ?? '').length, 0),
      reasoningEffort: body.reasoning_effort ?? null,
      hasThinking: Object.hasOwn(body, 'thinking'),
    });
  }
  return realFetch(url, opts);
};

let report = { ok: false, baseline: '', start: [], end: [], requests: [] };
try {
  const { config } = await import('../src/config.js');
  const persona = await import('../src/persona.js');
  const tic = await import('../src/tic.js');
  const { streamChat } = await import('../src/llm.js');
  const { Bot } = await import('../src/bot.js');

  persona.reload();
  tic.__clear();
  const bot = new Bot();
  bot.selfId = '10000002';
  const event = (text) => ({
    message_type: 'group',
    group_id: GROUP,
    user_id: '10000003',
    self_id: '10000002',
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: '10000003', nickname: '某群友', role: 'member' },
  });

  let completedRequests = 0;
  async function answer(question) {
    const system = bot.buildSystemPrompt('', event(question), null, question);
    if (completedRequests > 0) await sleep(40000);
    completedRequests += 1;
    return withRateLimitRetry(async () => {
      let out = '';
      for await (const part of streamChat(
        [{ role: 'system', content: system }, { role: 'user', content: question }],
        undefined,
        { maxTokens: 1000, timeoutMs: 180000 },
      )) out += part;
      return out.trim();
    }, '本轮请求');
  }

  console.log(`\n【0】连通与配置：${config.llm.baseURL} / ${config.llm.model}`);
  report.baseline = await answer(QUESTIONS[0]);
  console.log(`\n【基线】${report.baseline}`);

  tic.__clear();
  for (let i = 0; i < 3; i++) tic.note(GROUP, `其实，第${i}条不同的建议`);
  for (const q of QUESTIONS) {
    const system = bot.buildSystemPrompt('', event(q), null, q);
    if (!system.includes('句首口癖') || !system.includes('不是禁用词')) {
      throw new Error('句首软提醒没有进入 Bot.buildSystemPrompt');
    }
    report.start.push(await answer(q));
  }
  console.log('\n【句首提醒后】');
  report.start.forEach((text, i) => console.log(`${i + 1}. ${text}`));

  tic.__clear();
  for (let i = 0; i < 3; i++) tic.note(GROUP, `第${i}条不同的建议交给你了呢`);
  for (const q of QUESTIONS) {
    const system = bot.buildSystemPrompt('', event(q), null, q);
    if (!system.includes('句末口癖') || !system.includes('不是禁用词')) {
      throw new Error('句末软提醒没有进入 Bot.buildSystemPrompt');
    }
    report.end.push(await answer(q));
  }
  console.log('\n【句末提醒后】');
  report.end.forEach((text, i) => console.log(`${i + 1}. ${text}`));

  report.requests = requests;
  const allAnswers = [report.baseline, ...report.start, ...report.end];
  if (allAnswers.some((text) => !text)) throw new Error('有模型回答为空');
  if (requests.some((r) => r.model !== config.llm.model || r.reasoningEffort !== 'low' || r.hasThinking)) {
    throw new Error('实际请求没有按 Groq 测试配置发送 reasoning_effort=low / thinking=off');
  }
  if (requests.some((r) => r.systemChars > config.llm.promptMaxChars)) {
    throw new Error('精简人设组装后的系统提示词仍超过测试上限');
  }
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const ticSrc = readFileSync(join(ROOT, 'src', 'tic.js'), 'utf8');
  if (/softenDao\s*\(/.test(botSrc) || /export function softenDao\s*\(/.test(ticSrc)) {
    throw new Error('仍存在发言出口硬改写');
  }

  const starts = report.start.filter((text) => /^\s*其实[，,、]?/.test(text)).length;
  const ends = report.end.filter((text) => /呢[。！？!?…]*\s*$/.test(text)).length;
  report.summary = {
    requests: requests.length,
    startKept: starts,
    endKept: ends,
    note: '软提醒不是禁用词；保留次数只供人工观感，不作为失败条件。',
  };
  report.ok = true;
  console.log(`\n结果: 全部通过 ✅（请求 ${requests.length} 次；句首仍保留 ${starts}/3，句末仍保留 ${ends}/3）`);
} catch (error) {
  report.error = error.message;
  console.error(`\n结果: 失败 ❌ ${error.message}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  report.requests = requests;
  writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
  liveProbeCleanup(ROOT, NAME, env);
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(PERSONA_DIR, { recursive: true, force: true });
  console.log(`\n脱敏报告: logs/tic-live-last.json`);
}
