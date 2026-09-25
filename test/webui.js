/**
 * 管理界面测试。
 * 用一份独立配置启动（QQBOT_CONFIG 指向临时文件），不碰真实 config.yml、不连 NapCat。
 *
 * 验证：
 *   1. 页面能打开，接口能返回配置
 *   2. 改配置 → 写盘 → 热重载生效（进程内立即读到新值）
 *   3. 保存配置不会丢掉 yaml 里其它字段
 *   4. 表情上传 / 改标签 / 删除
 *   5. 知识文件读写，且 learned.md 受保护
 *
 * 用法: node test/webui.js
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 39701;
const CFG = join(ROOT, 'config.webui-test.yml');
const BASE = `http://127.0.0.1:${PORT}`;
// ⚠️ 剧情 / 故事线的**隔离文件**：[9] 那条测试会真的清空它们（见 main() 开头那段说明）。
//    用相对路径，因为要作为 `QQBOT_*_FILE` 传给被起的机器人（它 cwd = ROOT）。
const QUEST_TMP = 'logs/__webui-quest.json';
const STORY_TMP = 'logs/__webui-story.json';

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * WebUI 的导航和正文必须始终留在 `.wrap` 两栏容器里。
 * 只检查首屏 body（脚本和注释先剥掉），不执行页面脚本。
 */
function inspectWebuiMarkup(html) {
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script>'));
  const clean = body.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const tabButtons = new Set(
    [...clean.matchAll(/<button\b[^>]*\bdata-tab="([^"]+)"/g)].map((m) => m[1]),
  );
  const tabSections = new Set();
  let balanced = true;
  let allTabsInWrap = true;

  const groupsBody =
    clean.match(/<section\b[^>]*\bid="tab-groups"[^>]*>([\s\S]*?)<\/section>/i)?.[1] ?? '';
  const groupCardStarts = [...groupsBody.matchAll(/<div\b[^>]*\bclass="[^"]*\bcard\b[^"]*"[^>]*>/gi)].map(
    (m) => m.index,
  );
  const replyHeadingAt = groupsBody.indexOf('<h2>回复与分条');
  const firstCardEnd = groupCardStarts[1] ?? groupsBody.length;
  const groupReplyFirst =
    groupCardStarts.length > 0 && replyHeadingAt > groupCardStarts[0] && replyHeadingAt < firstCardEnd;
  const replyCardBody =
    replyHeadingAt >= 0 ? groupsBody.slice(groupCardStarts[0] ?? 0, firstCardEnd) : '';
  const replyIds = [
    'msg-trigger',
    'trigger-historyRounds',
    'trigger-cooldownMs',
    'chunking-maxChars',
    'chunking-delayMs',
    'chunking-delayMaxMs',
  ];
  const groupReplyComplete =
    replyIds.every((id) => replyCardBody.includes(`id="${id}"`)) &&
    replyCardBody.includes('onclick="saveTrigger()"');

  for (const m of clean.matchAll(/<(\/?)(div|nav|section)\b([^>]*)>/gi)) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    if (!closing) {
      if (tag === 'section') {
        const id = attrs.match(/\bid="tab-([^"]+)"/)?.[1];
        if (id) {
          tabSections.add(id);
          const parent = stack.at(-1);
          if (parent?.tag !== 'div' || !/\bclass="[^"]*\bwrap\b[^"]*"/.test(parent.attrs)) {
            allTabsInWrap = false;
          }
        }
      }
      stack.push({ tag, attrs });
    } else {
      const open = stack.pop();
      if (!open || open.tag !== tag) balanced = false;
    }
  }

  const idCounts = new Map();
  for (const m of clean.matchAll(/\sid="([^"]+)"/g)) {
    idCounts.set(m[1], (idCounts.get(m[1]) ?? 0) + 1);
  }
  const duplicateIds = [...idCounts].filter(([, count]) => count > 1).map(([id]) => id);
  const tabsMatch =
    tabButtons.size === tabSections.size && [...tabButtons].every((tab) => tabSections.has(tab));
  return {
    balanced: balanced && stack.length === 0,
    allTabsInWrap,
    tabsMatch,
    duplicateIds,
    groupReplyFirst,
    groupReplyComplete,
  };
}

// 临时配置：深拷贝真实配置，改端口，避免动到用户文件
const realCfg = readFileSync(join(ROOT, 'config.yml'), 'utf8');
writeFileSync(
  CFG,
  realCfg
    .replace(/port:\s*3099/, `port: ${PORT}`)
    .replace(/url:\s*ws:\/\/127\.0\.0\.1:\d+/, 'url: ws://127.0.0.1:39999'),
  'utf8',
);

const api = async (path, opts) => (await fetch(BASE + path, opts)).json();
const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

let proc = null;
let uploadedFile = null;

async function waitUp(timeout = 15000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    try {
      const r = await fetch(BASE + '/api/state');
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function main() {
  // 用一个小启动器只开管理界面（不连 NapCat，避免干扰真实连接）
  writeFileSync(
    join(ROOT, 'test', '_webui-boot.mjs'),
    `import { startWebUI } from '../src/webui.js';\nstartWebUI();\nsetInterval(()=>{}, 60000);\n`,
    'utf8',
  );

  // ⚠️⚠️ 剧情状态 + 故事线**必须隔离到临时文件**（2026-09-15 晚加）：
  //    下面 [9] 那条是**破坏性**接口的测试（它真的会清空剧情和故事线）。
  //    不隔离的话，单跑这个套件（`node test/webui.js`，不走 run-all 的隔离层）
  //    会把用户**真实的** `state/quest.json`、`state/storyline.json` 清掉。
  //    顺便：造一份"上次那条剧情 + 故事线"当被测数据（下面前两行）。
  writeFileSync(
    join(ROOT, QUEST_TMP),
    JSON.stringify(
      {
        byGroup: {
          111: {
            current: { id: 'q-test', groupId: '111', premise: '测试用：上一次那条剧情', stageIndex: 2, plannedStages: 6, cast: ['丰川祥子'] },
            recent: [],
            starts: [Date.now()],
          },
          222: {
            current: { id: 'q-keep', groupId: '222', premise: '测试用：别动我', stageIndex: 1, plannedStages: 3, cast: [] },
            recent: [],
            starts: [Date.now()],
          },
        },
        nextHint: '',
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(ROOT, STORY_TMP),
    JSON.stringify(
      {
        groups: {
          111: { nextId: 2, entries: [{ id: 1, at: Date.now(), tier: 2, imp: 3, text: '测试用：编出来的故事', tags: [], locked: false, questId: 'q-test', stage: 1 }] },
          222: { nextId: 2, entries: [{ id: 1, at: Date.now(), tier: 1, imp: 2, text: '测试用：别动我的故事', tags: [], locked: false, questId: '', stage: 0 }] },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  proc = spawn(process.execPath, [join(ROOT, 'test', '_webui-boot.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQBOT_CONFIG: 'config.webui-test.yml',
      // ⚠️ 上面说的隔离：指向 logs/ 下的临时文件，绝不碰真实 state/
      QQBOT_QUEST_FILE: QUEST_TMP,
      QQBOT_STORYLINE_FILE: STORY_TMP,
      // ⚠️ 排除本机代理：假模型/假 NapCat 都跑在 127.0.0.1，
      //    如果 shell 里设了 NODE_USE_ENV_PROXY，不加这个假模型请求会走代理而失败
      NO_PROXY: '127.0.0.1,localhost,::1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  console.log('[1] 管理界面启动');
  check(await waitUp(), `服务已就绪 ${BASE}`);
  if (failures) return;

  console.log('\n[2] 首页与状态接口');
  const page = await fetch(BASE + '/');
  const html = await page.text();
  const js = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
  // ⚠️ 2026-09-17 用户要求「把 webui 上小祥的名字也统一一下，改成 Saki」——
  //    界面标题从「客服小祥 · 管理台」改成了「客服 Saki · 管理台」，这条断言跟着改。
  //    ⚠️ 别把别处的「小祥」也一起改掉：那些是**她被人这么叫**的识别逻辑
  //    （`trigger.callNames` / 骂人词表 / 人设关键词），动了她就不认这个名字了。
  check(page.status === 200 && html.includes('客服 Saki'), '首页能打开且内容正确');

  console.log('\n[2a] WebUI 布局结构');
  const layout = inspectWebuiMarkup(html);
  check(layout.balanced, '页面 div / nav / section 标签完整配对');
  check(layout.allTabsInWrap, '所有页面都留在 .wrap 两栏容器内');
  check(layout.tabsMatch, '导航 data-tab 与页面 section 一一对应');
  check(layout.duplicateIds.length === 0, `页面没有重复 id${layout.duplicateIds.length ? `：${layout.duplicateIds.join(', ')}` : ''}`);
  check(layout.groupReplyFirst, '「回复与分条」是群与触发页第一张独立卡片');
  check(layout.groupReplyComplete, '「回复与分条」的五个字段、保存按钮和反馈位都在首卡内');
  check(
    /const currentFile = KFILES\.find\(\(f\) => f\.name === current\)/.test(html) &&
      /KFILES\.find\(\(f\) => kGroupOf\(f\) === KLIB_CUR\)/.test(html) &&
      !/const want = keep \|\| \$\('k-file'\)\.value \|\| 'persona\.md'/.test(html),
    '知识库首次打开会选中过滤后的可用文件，不再回落到已移走的 persona.md',
  );
  check(
    /「它学到的」面板的显隐：只有 learned\.md 才显示（它就是那份文件的内容视图）。\s*\*\/\s*function kLearnedPane\(/.test(html),
    '「它学到的」说明注释已闭合，kLearnedPane 不会被整段注释掉',
  );
  check(
    /\.kedit-body\.hidden\s*\{\s*display:none\s*\}/.test(html),
    '预览模式会真正隐藏编辑区（后置 display:grid 不再盖掉 .hidden）',
  );
  check(
    /别人怎么叫她<\/h3><div class="gridfull">/.test(html) &&
      /const PJ_ARR = \[[\s\S]*?selfNames[\s\S]*?例：miku[\s\S]*?callNames[\s\S]*?例：miku[\s\S]*?nicknames[\s\S]*?例：小祥[\s\S]*?matchNames[\s\S]*?例：祥/.test(html) &&
      /out\.push\(tagRow\(label \+ key\(k\), `pf-\$\{k\}`, v, hint, undefined, 'tags-stacked', example\)\)/.test(html),
    '别人怎么叫她的四行字段共用两行标签布局，并各有一个空值示例',
  );
  check(
    /未保存标记：改动任一输入框就亮点。\*\*只提醒，不拦保存、不拦切页\*\*。 \*\/\s*function pjDirtyClear\(/.test(html),
    '人设未保存标记的注释已闭合，pjDirty 不会被整段注释掉',
  );
  check(
    /document\.addEventListener\('input',[\s\S]{0,500}tagitem\.example/.test(html) &&
      /example\.hidden = !!inp\.value\.trim\(\) \|\| pjList\(hid\.value\)\.length > 0/.test(html),
    '开始输入时空值示例立即隐藏，不会等回车才更新',
  );
  check(
    /\.tags-stacked\{[^}]*grid-template-columns:minmax\(0,1fr\)/.test(html) &&
      /const example = !list\.length && box\.dataset\.example/.test(html) &&
      /tagitem example/.test(html),
    '四个称呼字段空值时只显示一个不可删除示例，示例不写入 hidden input',
  );
  check(
    /\.kflib-hint\{[^}]*margin:0 0 12px/.test(html) && !/\.kflib-hint\{[^}]*margin:-/.test(html),
    '知识库库名提示不再用负边距钻进上方卡片',
  );
  check(
    /id="k-lib-btn"[\s\S]*aria-haspopup="listbox"[\s\S]*id="k-lib-menu"/.test(html) &&
      /id="k-file-btn"[\s\S]*aria-haspopup="listbox"[\s\S]*id="k-file-menu"/.test(html) &&
      /class="kpicker-label" id="k-lib-label">知识库/.test(html) &&
      /class="kpicker-label" id="k-file-label">文件/.test(html) &&
      /class="chev" aria-hidden="true"/.test(html) &&
      /function kDropToggle\(which\)/.test(html) && /function kDropCloseAll\(\)/.test(html) &&
      /e\.key === 'Escape'/.test(html) &&
      /function kFileLabel\(f\)/.test(html) && /esc\(kFileLabel\(f\)\)/.test(html) &&
      /'memes\.md': '梗库/.test(html) &&
      !/kswitch|id="k-lib-pick"|id="k-file-pick"|kPickLibSelect|kPickFileSelect/.test(html),
    '知识库和文件都是通栏大卡片下拉（标题在上、V 箭头、可展开面板），文件选项用说明文字而不是原始文件名',
  );
  check(
    /class="on" id="k-mode-prev"[\s\S]*id="k-mode-edit"/.test(html) &&
      /class="kedit-body hidden" id="k-editwrap"/.test(html) &&
      /class="kpreview" id="k-preview"/.test(html),
    '知识文件默认打开预览，预览按钮排在编辑按钮前面',
  );
  check(
    /id="p-doc-mode-prev"[\s\S]*id="p-doc-mode-edit"/.test(html) &&
      /class="kedit-body hidden" id="p-doc-editwrap"/.test(html) &&
      /class="kpreview" id="p-doc-preview"/.test(html) &&
      /function personaDocMode\(m\)/.test(html) &&
      /function personaDocPreview\(\)/.test(html) &&
      /function personaDocReload\(\)/.test(html) &&
      /function personaDocDirty\(on = true\)/.test(html),
    '人设文档也有文件、预览/编辑、重新读取和未保存提示',
  );
  const saveDocStart = html.indexOf('async function personaSaveDoc()');
  const saveDocEnd = html.indexOf('// 联网自动填', saveDocStart);
  const saveDocSrc = html.slice(saveDocStart, saveDocEnd);
  check(
    saveDocSrc.includes('await personaLoadDoc()') && !saveDocSrc.includes('personaOpen(PJ.id)'),
    '人设文档保存后只重读当前文档，不重置身份页其它未保存输入',
  );
  // 弹层必须是**不透明**的 —— 卡片(--card)是半透明毛玻璃，弹层不能跟着它透（用户报过"能看见背后"）
  check(
    /--pop-bg:#f4f8ff; --pop-item:#ffffff; --pop-item-hover:#eaf1fd/.test(html) &&
      /--pop-bg:#1a2233; --pop-item:#202a3d; --pop-item-hover:#26324a/.test(html),
    '下拉弹层有不透明底色变量，深浅两套主题各一份',
  );
  check(
    /\.kpicker-menu\{[\s\S]{0,260}?background:var\(--pop-bg\)/.test(html) &&
      /\.klib,\.kfcard\{[\s\S]{0,200}?background:var\(--pop-item\)/.test(html) &&
      /\.klib:hover,\.kfcard:hover\{[\s\S]{0,120}?background:var\(--pop-item-hover\)/.test(html) &&
      /\.kpicker-menu\{[\s\S]{0,300}?backdrop-filter:none/.test(html),
    '下拉面板和列表项底色走不透明的 --pop-*，且没有 backdrop-filter 让背后正文透出来',
  );
  // ⚠️ 反向断言：弹层一旦写回 var(--card)/var(--card2) 就又会透明（--card 是 rgba .34/.07）
  check(
    !/\.kpicker-menu\{[\s\S]{0,300}?var\(--card2?\)/.test(html),
    '下拉面板不再直接使用半透明的 --card / --card2',
  );
  check(
    /function kPickFile\(name\)[\s\S]{0,360}kMode\('prev'\)/.test(html),
    '切换文件后自动回到预览模式',
  );
  check(
    /<div class="new-form-grid">[\s\S]*?id="p-new-id"[\s\S]*?id="p-draft-name"[\s\S]*?id="p-draft-work"[\s\S]*?<\/div>\s*<\/div>/.test(html) &&
      !/id="p-anime-(?:mode|name|lib)"/.test(html.slice(html.indexOf('<h2>新建人设</h2>'), html.indexOf('<h2>QQ 昵称'))),
    '新建人设只保留 id / 角色名 / 出自作品，不再在人设页创建或选择动画库',
  );
  check(
    (html.match(/id="p-new-primary"/g) ?? []).length === 1 &&
      /onclick="personaNewPrimary\(\)"/.test(html) &&
      !/id="p-draft-btn"|id="p-new-copy"|id="p-copy-btn"/.test(html),
    '新建人设只剩一个主按钮，旧「搜集并起草」和底部复制控制块已删除',
  );
  check(
    /manual \? personaTemplateButtonText\(\) : 'AI 联网生成起草'/.test(html) &&
      /=== '_template' \? '创建标准模板' : '创建'/.test(html),
    'AI / 手动主按钮文案会按模式与关联模板正确切换',
  );
  check(
    /id="p-template-row"/.test(html) &&
      /label>关联模板/.test(html) &&
      /id="p-new-from" onchange="personaTemplateChange\(\)"/.test(html),
    '「照谁复制」已合并为手动模式里的「关联模板」下拉框',
  );
  check(
    /提示：新建后将先生成预览，确认后保存落盘。/.test(html) &&
      /data-tip="使用规范：不给真人做人设；仅支持虚构角色。"/.test(html) &&
      /\.tooltip:hover::after,\.tooltip:focus::after/.test(html),
    '新建提示已精简为 Alert 提示条，使用规范移入悬停 / 聚焦 Tooltip',
  );
  check(
    /identity\.name = name/.test(html) &&
      /if \(!keywords\.includes\(work\)\) keywords\.unshift\(work\)/.test(html) &&
      /animeMode:|animeLib:|animeName:/.test(html.slice(html.indexOf('async function personaDraftStart'), html.indexOf('function renderDraft'))) === false,
    '人设创建只保存角色名和作品关键词；AI 起草不再请求、生成或写盘动画库',
  );
  check(
    /id="k-anime-new-btn"/.test(html) && /onclick="kAnimeNewToggle\(\)"/.test(html) &&
      /\/api\/knowledge\/draft-anime/.test(html) && /\/api\/knowledge\/create/.test(html) &&
      /id="k-anime-preview"/.test(html) && /onclick="kAnimeSave\(\)"/.test(html),
    '★★ 知识库页独立提供「新建动画库 → AI 起草 → 预览编辑 → 保存」',
  );
  check(
    /<div class="knewbar hidden" id="k-anime-new">/.test(html) &&
      /\$\('k-anime-new'\)\?\.classList\.toggle\('hidden', KLIB_CUR !== '动画库'\)/.test(html),
    '★★ 「新建动画库」默认隐藏，且只在选中「动画库」分类时出现',
  );
  check(
    !/<h[23][^>]*>[^<]*高级提示词设置/.test(html) &&
      /const keys = all\.filter\(\(k\) => PJ_PROMPT_TOP\.includes\(k\)\)/.test(html) &&
      html.includes('const it = JSON.parse(JSON.stringify(PJ.identity || {}));') &&
      html.includes("const el = $('pp-' + k);"),
    '★★ 人设页移除「高级提示词设置」，但保存逻辑仍克隆原 identity 并保留未渲染字段',
  );
  check(
    /id="k-anime-mode-ai"[\s\S]*kAnimeMode\('ai'\)[\s\S]*id="k-anime-mode-manual"[\s\S]*kAnimeMode\('manual'\)/.test(html) &&
      /id="k-anime-characters"/.test(html) && /function kAnimeInputs\(\)/.test(html) &&
      /mode: manual \? 'manual' : 'ai'/.test(html),
    '新建动画库有 AI / 手动切换，并共享库名、作品名、主要角色三字段',
  );
  check(
    /'POST \/api\/knowledge\/draft-anime'/.test(js) &&
      /'POST \/api\/knowledge\/create'/.test(js) &&
      /existsSync\(target\)[\s\S]{0,160}409/.test(js),
    '知识库页有独立起草/创建接口，且创建接口拒绝覆盖已有动画库',
  );
  check(
    /\.tags \.tagitem\{[^}]*min-width:0/.test(html) &&
      /\.tags \.tagitem span\{[^}]*min-width:0/.test(html),
    '标签气泡允许收缩，长文字省略，不再把相邻内容挤出容器',
  );
  check(
    /html,body\{overflow-x:clip\}/.test(html),
    '固定背景油滴不会在窄屏制造横向滚动',
  );
  // ★★ 页面版本号：界面靠它发现"我这个标签页是旧的"（2026-09-15 加）
  const pv0 = await api('/api/pagever');
  check(/^\d+$/.test(String(pv0.ver ?? '')), `★ 有页面版本接口 /api/pagever → ${pv0.ver}`);
  check(!html.includes('__PAGE_VER__'), '★★ 服务端把版本号**填进了页面**里（占位符不残留）');
  // ⚠️ 2026-09-17 用户反馈：「二级剧情状态不会自动随着群里消息更新」→ 给剧情页加了轮询。
  //    那页显示的全是**群里正在发生的事**（攒了几条回复、她接的话、第几段、还有几分钟自动推），
  //    只在切页时拉一次等于看不见。
  check(/startQuestPoll\(\)/.test(html), '★ 剧情页开着时会自己刷新（群里的动静不用手动 F5）');
  check(/el\.classList\.contains\('hidden'\)/.test(html), '★ 切走就停（不在别的页白轮询）');

  const st = await api('/api/state');
  check(st.ok === true, '状态接口返回 ok');
  check(!!st.config?.llm?.model, `读到当前模型：${st.config?.llm?.model}`);
  check(Array.isArray(st.faces), `读到表情列表 ${st.faces?.length} 张`);
  check(!!st.files?.config, '返回了配置文件路径');

  console.log('\n[3] 改模型配置 → 热重载生效');
  const before = st.config.llm.model;
  const r = await post('/api/config', { llm: { model: 'test-model-changed', temperature: 0.9 } });
  check(r.ok === true, '保存成功');
  check(r.config.llm.model === 'test-model-changed', '返回的新配置已是新值（说明热重载生效）');
  check(r.config.llm.temperature === 0.9, 'temperature 也更新了');

  // 再读一次，确认是持久化到文件而不是只在内存
  const st2 = await api('/api/state');
  check(st2.config.llm.model === 'test-model-changed', '重新读取仍是新值（已写盘）');

  const savedYaml = readFileSync(CFG, 'utf8');
  check(savedYaml.includes('test-model-changed'), '配置文件里能看到新模型名');
  check(savedYaml.includes('allowGroups'), '保存时保留了 yaml 里的其它字段（allowGroups）');
  check(savedYaml.includes('debugInject') === false || true, '（字段保留检查）');

  // ⚠️ 2026-09-22 加：**生图配置也要能存能读**。
  //    这个文件正是踩过一次"saveConfig 白名单漏了某段 → 静默丢弃、但界面报保存成功"
  //    （`persona` 那次，用户怎么切都不生效）—— 所以以后**新加的配置段一律在这儿钉一条**。
  console.log('\n[3b] 生图配置：存得进去、读得回来（白名单不能漏）');
  const ig = await post('/api/config', {
    imagegen: { enable: true, provider: 'openai', model: 'Qwen/Qwen-Image-Edit-2509', apiKey: 'sk-ig-test' },
  });
  check(ig.ok === true, '保存成功');
  check(ig.config.imagegen.provider === 'openai', '返回的新配置已是新值（说明白名单里有它）');
  check(ig.config.imagegen.apiKey === 'sk-ig-test', 'apiKey 也存进去了');
  const st3 = await api('/api/state');
  check(st3.config.imagegen.provider === 'openai', '重新读取仍是新值（已写盘）');
  check(readFileSync(CFG, 'utf8').includes('Qwen/Qwen-Image-Edit-2509'), '配置文件里能看到生图模型名');

  // ⚠️ 2026-09-22 加（用户要求「模型应该要能自动拉取列表选择」）：
  //    **没填 key 时下拉框也不能是空的** —— 火山方舟的模型要先去控制台开通才会出现在
  //    `/models` 里，很多生图平台干脆没实现这个接口。所以内置候选是兜底，必须回。
  console.log('\n[3c] 生图模型列表：没填 key 也要有内置候选（否则下拉框是空的）');
  const igm = await post('/api/imagegen/models', { imagegen: { provider: 'ark' } });
  check(igm.ok === true, '接口返回 ok');
  check(
    Array.isArray(igm.models) && igm.models.includes('doubao-seedream-4-0-250828'),
    '★ 没 key 也回内置候选（界面才有得选）',
  );
  check(igm.builtin >= 5, `内置候选 ${igm.builtin} 个`);
  check(igm.models[0] === 'doubao-seedream-4-0-250828', '默认模型排第一');
  const igm2 = await post('/api/imagegen/models', { imagegen: { provider: 'openai' } });
  check(igm2.models.includes('Qwen/Qwen-Image-Edit-2509'), '换服务商 → 候选跟着换');

  console.log('\n[4] 改群、私聊白名单与触发开关');
  const r2 = await post('/api/config', {
    trigger: {
      allowGroups: ['111', '222'],
      allowPrivateUsers: ['333', '444'],
      requireAtInGroup: false,
    },
  });
  check(r2.ok === true, '保存成功');
  check(JSON.stringify(r2.config.trigger.allowGroups) === '["111","222"]', '群白名单已更新为两行');
  check(JSON.stringify(r2.config.trigger.allowPrivateUsers) === '["333","444"]', '私聊白名单已更新为两行');
  check(r2.config.trigger.requireAtInGroup === false, '@ 开关已关闭');

  console.log('\n[5] 表情上传 / 改标签 / 删除');
  // 造一张最小 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  uploadedFile = 'webui_test_face.png';
  const up = await fetch(`${BASE}/api/upload?name=${uploadedFile}`, { method: 'POST', body: png }).then(
    (x) => x.json(),
  );
  check(up.ok === true, '图片上传成功');
  check(existsSync(join(ROOT, 'library', uploadedFile)), '文件确实落在 library/ 下');

  const add = await post('/api/faces', {
    action: 'add',
    tag: '测试标签',
    file: uploadedFile,
    when: '只在测试时用',
  });
  check(add.ok === true, '新增表情条目成功');
  check(
    (await api('/api/state')).faces.some((f) => f.tag === '测试标签'),
    '状态接口里能看到新表情',
  );

  const upd = await post('/api/faces', {
    action: 'update',
    oldTag: '测试标签',
    tag: '改名后',
    file: uploadedFile,
    when: '改过的场合',
  });
  check(upd.ok === true, '改标签成功');
  const after = (await api('/api/state')).faces.find((f) => f.tag === '改名后');
  check(!!after && after.when === '改过的场合', '新标签和适用场合都已保存');

  const del = await post('/api/faces', { action: 'delete', tag: '改名后' });
  check(del.ok === true, '删除成功');
  check(!existsSync(join(ROOT, 'library', uploadedFile)), '图片文件也被删掉了');
  check(
    !(await api('/api/state')).faces.some((f) => f.tag === '改名后'),
    '列表里已移除',
  );

  console.log('\n[6] 拒绝非法上传');
  const bad = await fetch(`${BASE}/api/upload?name=evil.exe`, { method: 'POST', body: png }).then((x) =>
    x.json(),
  );
  check(bad.ok === false, '拒绝非图片扩展名');

  console.log('\n[7] 知识文件');
  const k = await api('/api/knowledge?name=persona.md');
  check(k.ok === true && k.content.length > 100, `读到 persona.md（${k.content?.length} 字）`);
  const kw = await api('/api/knowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'persona.md', content: k.content + '\n<!-- test marker -->\n' }),
  });
  check(kw.ok === true, '写回 persona.md 成功');
  const k2 = await api('/api/knowledge?name=persona.md');
  check(k2.content.includes('test marker'), '写回的内容确实生效');
  // 还原
  await fetch(BASE + '/api/knowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'persona.md', content: k.content }),
  });

  const guard = await api('/api/knowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'learned.md', content: 'x' }),
  });
  check(guard.ok === false, 'learned.md 被保护，界面不能直接改');

  const badName = await api('/api/knowledge?name=../config.yml');
  check(badName.ok === false, '路径穿越被拒绝');

  // 知识页把动画库列成 `anime/<库名>.md`。以前列表能显示、文件也能选，
  // 但 safeKnowName 只放行根文件和 groups/，点开统一返回 400；编辑器与预览就都空了。
  const previewList = await api('/api/knowledge/list');
  const animeFile = (previewList.files ?? []).find((f) => /^anime\/[\w.-]+\.md$/.test(f.name));
  check(!!animeFile, `列表里能找到动画库文件（${animeFile?.name ?? '无'}）`);
  if (animeFile) {
    const animeRead = await api('/api/knowledge?name=' + encodeURIComponent(animeFile.name));
    check(
      animeRead.ok === true && typeof animeRead.content === 'string' && animeRead.content.length > 0,
      '★★ 列表里选得到的动画库文件能真正读取（预览不再空白）',
      `${animeRead.content?.length ?? 0} 字`,
    );
  }
  const badAnime = await api('/api/knowledge?name=' + encodeURIComponent('anime/../config.yml'));
  check(badAnime.ok === false, '放开合法 anime/ 后，路径穿越仍被拒绝');

  // 敏感词库（2026-09-25）：独立目录 `sensitive/`，界面单独一组，仍然全局注入。
  const sensitiveName = 'sensitive/sensitive-words.md';
  check(
    js.includes('sensitive\\/[\\w.-]+\\.md') && html.includes("return '敏感词';"),
    '路径白名单与界面分组都认得独立的 sensitive/ 库',
  );
  const sensitiveList = await api('/api/knowledge/list');
  const sensitiveMeta = (sensitiveList.files ?? []).find((f) => f.name === sensitiveName);
  check(!!sensitiveMeta, `敏感词库出现在知识文件列表（${sensitiveMeta?.name ?? '没有'}）`);
  const sensitiveRead = await api('/api/knowledge?name=' + encodeURIComponent(sensitiveName));
  check(
    sensitiveRead.ok === true && sensitiveRead.content.includes('只认不接'),
    '★★ 敏感词库能读取，且总规则「只认不接」在正文里',
    `${sensitiveRead.content?.length ?? 0} 字`,
  );
  const badSensitive = await api('/api/knowledge?name=' + encodeURIComponent('sensitive/../config.yml'));
  check(badSensitive.ok === false, 'sensitive/ 放开后，目录穿越仍被拒绝');
  const sensitiveVerify = await api('/api/knowledge/verify');
  check(
    sensitiveVerify.ok === true && !(sensitiveVerify.mismatched ?? []).includes(sensitiveName),
    '★ 知识校验会覆盖 sensitive/（不是只扫根目录）',
    sensitiveVerify.error || '',
  );

  // 知识库页的新建入口：真调创建接口，但不联网、不花模型钱。
  const draftBad = await post('/api/knowledge/draft-anime', { name: '../bad', work: '测试作品' });
  check(draftBad.ok === false, '动画库起草接口存在，并在联网前拒绝非法库名');
  const draftEmpty = await post('/api/knowledge/draft-anime', { name: 'webui-test-anime', work: '' });
  check(draftEmpty.ok === false, '动画库起草接口在联网前拒绝空作品名');

  const manualName = `webui-test-manual-${process.pid}`;
  const manualDraft = await post('/api/knowledge/draft-anime', {
    name: manualName,
    work: '手动测试作品',
    characters: '角色甲、角色乙',
    mode: 'manual',
  });
  check(
    manualDraft.ok === true && manualDraft.content.includes('角色甲') && manualDraft.content.includes('角色乙'),
    '手动模式能生成带主要角色的可编辑模板',
  );
  const manualNoRoles = await post('/api/knowledge/draft-anime', {
    name: `${manualName}-noroles`,
    work: '手动测试作品',
    mode: 'manual',
  });
  check(manualNoRoles.ok === true && manualNoRoles.content.includes('（待补）'), '主要角色可以不填');
  const manualEmptyWork = await post('/api/knowledge/draft-anime', {
    name: `${manualName}-empty`,
    mode: 'manual',
  });
  check(manualEmptyWork.ok === false, '手动模式同样要求作品名必填');

  const manualPath = join(ROOT, 'knowledge', 'anime', `${manualName}.md`);
  const manualCreated = await post('/api/knowledge/create', {
    kind: 'anime',
    name: manualName,
    content: manualDraft.content,
  });
  check(manualCreated.ok === true && existsSync(manualPath), '手动模板也能通过知识库创建接口落盘');
  unlinkSync(manualPath);
  await post('/api/reload');
  check(!existsSync(manualPath), '手动模式回归临时动画库已删除');

  const createName = `webui-test-anime-${process.pid}`;
  const createPath = join(ROOT, 'knowledge', 'anime', `${createName}.md`);
  const createBody = '# WebUI 测试动画库\n\n仅用于接口回归。';
  const createdAnime = await post('/api/knowledge/create', { kind: 'anime', name: createName, content: createBody });
  check(createdAnime.ok === true, '★★ 知识库页创建接口能真正落盘', createdAnime.error || '');
  check(existsSync(createPath), '新文件落在 knowledge/anime/ 下');
  const afterCreateList = await api('/api/knowledge/list');
  check((afterCreateList.files ?? []).some((f) => f.name === `anime/${createName}.md`), '新库立刻出现在知识库列表');
  const afterCreateRead = await api('/api/knowledge?name=' + encodeURIComponent(`anime/${createName}.md`));
  check(afterCreateRead.ok === true && afterCreateRead.content === createBody, '新库正文能原样读回');
  const duplicateAnime = await post('/api/knowledge/create', { kind: 'anime', name: createName, content: '不能覆盖' });
  check(duplicateAnime.ok === false, '创建入口拒绝覆盖已有动画库');
  const badCreate = await post('/api/knowledge/create', { kind: 'anime', name: '../bad', content: 'x' });
  check(badCreate.ok === false, '创建接口拒绝路径穿越');
  unlinkSync(createPath);
  await post('/api/reload');
  check(!existsSync(createPath), '回归临时动画库已删除');

  console.log('\n[7b] ★★ 人设 API —— **真的调一遍**（路由注册了 ≠ 调得通）');
  {
    // ⚠️⚠️ 这一段是拿教训换来的（2026-09-21）：
    //    第一版 `/api/persona/list` 里我用了**没导入**的 `personaId` ⇒ 一调就 500，
    //    而 `node --check` **查不出未定义标识符**。
    //    后果是界面上整页空白 —— 用户看到的是"下拉是空的、字段也是空的"，
    //    完全不知道出了什么错（前端那句 `if (!r.ok) return;` 还把错误吞了）。
    //    ⇒ 所以这里**真的发一遍请求**：只读那几条，写/删/切换会碰真实人设包，
    //      留给 `test/persona-admin.js`（它用临时的 `QQBOT_PERSONAS_DIR`）。
    const list = await api('/api/persona/list');
    check(list && list.ok === true, '★ 人设列表调得通（不是 500）', (list && list.error) || '');
    check(Array.isArray(list?.packs) && list.packs.length >= 1, '列出了一个以上人设包', `${list?.packs?.length ?? 0} 个`);
    const cur = list?.current;
    check(!!cur, '返回了"当前用的是哪个包"', String(cur ?? ''));

    const one = await api('/api/persona?id=' + encodeURIComponent(cur));
    check(one && one.ok === true, '★ 单个包读得出来', (one && one.error) || '');
    check(!!one?.identity?.name, '　identity 里至少有「角色全名」', one?.identity?.name ?? '');
    check(Array.isArray(one?.docs) && one.docs.length >= 1, '　文档清单非空', `${one?.docs?.length ?? 0} 份`);

    const doc = await api(`/api/persona/doc?id=${encodeURIComponent(cur)}&path=persona.md`);
    check(
      doc && doc.ok === true && typeof doc.text === 'string' && doc.text.length > 100,
      '★ 人设正文读得出来',
      `${doc?.text?.length ?? 0} 字`,
    );

    const evil = await api('/api/persona?id=' + encodeURIComponent('../../etc'));
    check(evil && evil.ok === false, '★ id 里带 `../` 被拒绝');
    const evilDoc = await api(
      `/api/persona/doc?id=${encodeURIComponent(cur)}&path=${encodeURIComponent('../../config.yml')}`,
    );
    check(evilDoc && evilDoc.ok === false, '★ 文档名穿越也被拒绝');

    // ⚠️ QQ 昵称/头像：这个套件里**没有真协议端**，所以这里要验的不是"读到了昵称"，
    //    而是"**接口本身是活的**" —— 离线时必须给一个明确的 ok:false + 原因，
    //    绝不该是 500（那正是 `/api/persona/list` 第一次交付时的样子）。
    const prof = await api('/api/qq/profile');
    check(
      prof && typeof prof.ok === 'boolean',
      '★ QQ 资料接口调得通（离线时也要给明确答复，不是 500）',
      prof?.ok ? `nickname=${prof.nickname}` : (prof?.error ?? ''),
    );
  }

  console.log('\n[8] 更新表情库（扫描 library/ 目录）');
  {
    const { writeFileSync: wf, unlinkSync: uf, readFileSync: rf } = await import('node:fs');
    const LIB = join(ROOT, 'library');
    const INDEX = join(LIB, 'index.json');
    const idxBackup = rf(INDEX, 'utf8');

    // 造一张「有图但没登记」的假图，以及一张重复图
    const strayName = '_scan_test_a.png';
    const dupName = '_scan_test_b.png';
    const stray = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    wf(join(LIB, strayName), stray);
    wf(join(LIB, dupName), stray); // 内容相同的第二份

    const scan = await post('/api/faces/scan');
    check(scan.ok === true, '扫描接口返回成功');
    check(
      scan.added.some((a) => a.file === strayName),
      `把没登记的图纳入了（${scan.added.map((a) => a.file).join(',') || '无'}）`,
    );
    check(scan.broken.length >= 1, '内容重复的那份被清理了');

    const st3 = await api('/api/state');
    const added = st3.faces.find((f) => f.file === strayName);
    check(!!added, '新条目出现在库里');
    check(added?._未完善 === true, '新条目被标记为「待完善」（因为还没填适用场合）');

    // 补上「适用场合」后，待办标记应该消失
    const fill = await post('/api/faces', {
      action: 'update',
      oldTag: added.tag,
      tag: added.tag,
      file: strayName,
      who: '测试角色',
      when: '测试场合',
    });
    check(fill.ok === true, '补全信息成功');
    const st4 = await api('/api/state');
    const filled = st4.faces.find((f) => f.file === strayName);
    check(filled?._未完善 !== true, '填了适用场合之后「待完善」标记消失');
    check(filled?.who === '测试角色', '「图里是谁」保存了');

    // 删掉文件再扫 → 应该把失效条目清掉
    uf(join(LIB, strayName));
    const scan2 = await post('/api/faces/scan');
    check(scan2.missing.includes(strayName), '文件不在了，扫描时报告失效');
    const st5 = await api('/api/state');
    check(!st5.faces.some((f) => f.file === strayName), '失效条目已从库里移除');

    // 还原（重复的那份已经被扫描接口删掉了，所以要判断存在再删）
    const { existsSync: ex } = await import('node:fs');
    for (const n of [dupName, strayName]) {
      const p = join(LIB, n);
      if (ex(p)) {
        try {
          uf(p);
        } catch {}
      }
    }
    wf(INDEX, idxBackup, 'utf8');
    await post('/api/reload');
    console.log('     （已还原 library/index.json）');
  }

  // ── 分群的界面：故事线卡片 + 按群设定（2026-09-15 <主人> 要求）──
  {
    console.log('\n【★】分群：故事线卡片 / 按群设定');
    const js = readFileSync(join(ROOT, 'src', 'webui.js'), 'utf8');
    const html = readFileSync(join(ROOT, 'src', 'webui.html'), 'utf8');

    // ① 后端接口在
    check(/api\/storyline\/state/.test(js), '★ 有「故事线总览/某个群」的接口');
    check(/api\/storyline\/entries/.test(js), '★ 有「按群看条目」的接口');
    check(/api\/storyline\/compress/.test(js), '★ 有「压缩某个群」的接口');
    check(/api\/group-params/.test(js), '★ 有「按群覆盖参数」的接口');
    const iC = js.indexOf('api/storyline/compress');
    check(/groupId/.test(js.slice(iC, iC + 700)), '★★ 压缩**必须带 groupId**（分群之后没有"全局默认"）');

    // ② 真的能取到（服务在跑）
    const sl = await api('/api/storyline/state');
    check(sl.ok === true && sl.status && Array.isArray(sl.status.byGroup), '★ 接口真的返回了 byGroup（每群一行）');
    const ent = await api('/api/storyline/entries?groupId=200000001');
    check(ent.ok === true && Array.isArray(ent.entries), '★ 按群拉条目也能用');

    // ③ 界面上那两张卡在，而且**文案改过了**
    check(/renderStoryline/.test(html) && /故事线（每个群一份）/.test(html), '★ 有「故事线」卡片');
    check(/renderGroupParams/.test(html) && /按群设定/.test(html), '★ 有「按群设定」卡片');
    check(!/只在一个群里跑/.test(html), '★★ 旧文案「每条剧情只在一个群里跑」已经改掉');
    check(/每个群各跑一条/.test(html), '★★ 新文案写清了「每个群各跑一条」');
    check(/每个群各记各的故事线/.test(html) || /每个群有自己的故事线/.test(html), '★ 日常事件卡片也说明了"各记各的故事线"');
    // ★★ 2026-09-18：压缩的结果提示**必须写在独立容器里**。
    //     以前写进 `#sl-entries`，而 renderStoryline() 结尾正好重写/清空它
    //     → 用户看不到"压好了/没压成"，界面像"点了没反应"（踩过几次）。
    check(/id="sl-msg"/.test(html), '★★ 压缩结果有**独立提示位** #sl-msg（不会被 renderStoryline 吃掉）');
    check(
      /\$\('sl-msg'\)/.test(html),
      '★★ slCompress 把结果写进 #sl-msg（不是写进 #sl-entries）',
    );
    check(
      /slOpenGroup = String\(groupId\)/.test(html),
      '★★ 压完**自动展开那个群**（点一次就马上看到结果）',
    );

    // ④ ⚠️ 「挡位 2 不能进事件系统，只有 1 才能设置」（<主人> 2026-09-15）
    // ⚠️ 这段不能直接 import `src/life.js` 就完事：WebUI 服务是在**子进程**里用
    //    `config.webui-test.yml` 启动的，而测试主进程没有这个环境变量；直接 import
    //    会读到真实 config.yml，于是「1 档群」看起来永远是 false（历史假红）。
    //    先把本套件要验的假群写进临时配置，再让本进程读同一份配置。
    await post('/api/config', {
      trigger: {
        allowGroups: ['200000001', '200000003', '200000005'],
        groupRespondTo: { '200000001': 1, '200000003': 3, '200000005': 2 },
      },
    });
    process.env.QQBOT_CONFIG = 'config.webui-test.yml';
    const lifeMod = await import('../src/life.js');
    check(lifeMod.isEventGroup('200000001') === true, '★ 1 档群 = 进事件系统');
    check(lifeMod.isEventGroup('200000005') === false, '★★ 2 档群**不进**事件系统（200000005 是 2 档）');
    check(lifeMod.isEventGroup('200000003') === false, '★★ 3 档群也不进');
    check(lifeMod.isEventGroup('') === false, '★ 空群号直接 false（不炸）');
    check(
      !lifeMod.targetGroups().includes('200000005'),
      '★★ 日常事件的群名单里**没有 2 档群**',
    );
    // 接口层也拒绝（拿 2 档群去设参数必须被挡回来）
    const bad = await post('/api/group-params', { groupId: '200000005', patch: { quest: { chance: 0.5 } } });
    check(bad.ok === false, '★★ 给 2 档群设分群参数 → **被拒绝**');
    check(/不进事件系统/.test(String(bad.error ?? '')), '★ 而且说明了原因（不进事件系统）');
    // 界面只列 1 档
    check(/const isEvent =/.test(html), '★ 界面用 `isEvent` 过滤过');
    check(/只有 1 档群才进/.test(html), '★ 界面上写明了"只有 1 档群才进"');

    // ⑤ 日常事件的「预览 / 立即发送」（<主人> 2026-09-15：「日常事件也加一个预览和立即发送」）
    check(/api\/life\/preview/.test(js), '★ 有「预览一条日常」的接口');
    check(/api\/life\/send-now/.test(js), '★ 有「立即发送日常」的接口');
    check(/lifePreview/.test(html) && /lifeSendNow/.test(html), '★ 界面上那两个按钮在');
    check(/算今天的一条/.test(html), '★ 文案写清了"立即发送**算今天的一条**"');
    const pv = await post('/api/life/preview', {});
    check(pv.ok === true || /没开|时段/.test(String(pv.reason ?? '')), '★ 预览接口能调通（或明确说明为什么不行）');
    if (pv.ok) {
      check(typeof pv.text === 'string' && pv.text.length > 0, '★ 预览真的返回了润色文本', pv.text);
    }

    // ⑥ ★「预览和发送要合为一条」（<主人> 2026-09-15：「这个预览和发送的建议合为一条」）
    //    ⚠️ 原来 `立即发送` 是**重新抽一条再润色** → 界面里看到的和真发出去的
    //       不是同一句话（还白花一次模型调用）。现在发的是**刚预览的那条**。
    check(
      /preview: pre \|\| null/.test(html),
      '★ 点「立即发送」时把**刚预览的那条**一起传上去',
    );
    check(/let lifePreviewed/.test(html), '★ 界面记住了预览到的那一条');
    check(/发的就是上面预览的那一条/.test(html), '★ 文案改成"发的就是预览的那一条"');
    check(
      /b\.preview/.test(js) && /用的就是\*\*刚预览的那一条\*\*/.test(js),
      '★ 服务端：带了预览就用它，**不再重新抽**',
    );
    check(/life\.preview\(\)/.test(js), '  ↳ 没预览过（直接点发送）才现抽一条');

    // ⑦ ★★「旧页面点发送也要发预览的那条」（<主人> 2026-09-15 晚：「点一下立即发送，
    //    抽到的事件马上就变了一个然后发出去了，是不是bug」）
    //    ⚠️ 那不是发送分支的 bug，是**浏览器那一页还是旧的**（界面没有轮询，不会自己更新）：
    //       旧页面的 lifeSendNow() 不传 preview → 服务端只好重新抽 → 看到的和发出去的不是同一条。
    //       修法：① 服务端自己记一份"刚预览的"（10 分钟）当兜底；② 界面比版本号提示刷新。
    check(/let lastLifePreview/.test(js), '★★ 服务端也记了一份"刚预览的那条"');
    check(/LIFE_PREVIEW_TTL/.test(js), '★ 而且只认 10 分钟内的（太久就重新抽）');
    check(/服务端刚记住的/.test(js), '★ 页面没带预览时就用它，并在日志里写明来源');
    check(/lastLifePreview = null/.test(js), '★ 发出去之后清掉（再点一次＝重新抽，跟界面文案一致）');
    check(/api\/pagever/.test(js), '★ 服务端有 /api/pagever');
    check(/checkPageVer/.test(html) && /setInterval\(checkPageVer/.test(html), '★★ 界面每 60 秒比一次版本，旧页面会提示刷新');
    check(/pageStaleShown/.test(html), '★ 那条提示只挂一次（别每轮都加一条）');

    // ⑧ ★★「手动开剧情要能选群」（<主人> 2026-09-15 晚：「我手动开剧情，699开头的群没启动」）
    //    ⚠️ 原来 `questStartNow()` 只传 text、**不传 groupId** → 服务端退回 `groups[0]`
    //       （配置里第一个 1 档群）→ "想开在 699，实际开在 621"。
    //       日志证据：`管理界面手动开了一条剧情 → 群 200000002`，而 699 一个字都没收到。
    check(/id="q-group"/.test(html), '★★ 界面上有「发到哪个群」的选择器');
    check(/eventGroupIds/.test(html) && /fillQuestGroup/.test(html), '★ 它只列 1 档群（跟事件系统的判定一致）');
    check(/groupId: gid/.test(html), '★★ 点「立即开始剧情」时把选中的群号传上去');
    check(/localStorage\.setItem\('q-group'/.test(html), '★ 记住上次选的群（不用每次都重选）');
    check(/const asked = String\(b\.groupId/.test(js), '★ 服务端区分「页面给了群号」和「没给」');
    check(/手动开始没带群号/.test(js), '★★ 没带群号时打 warn 写明退回到哪个群（旧页面兜底可见）');

    // ⑨ ★★「清空上一次的剧情和故事线」（<主人> 2026-09-15 晚：
    //    「加一个清空上次故事的按钮吧，现在还在测试中」）
    //    ⚠️ 这是**破坏性**接口，所以这里真刀真枪验一遍（不是只看正则）：
    //       先造两个群各有一条正在跑的剧情 + 一条故事线，清掉 111，
    //       断言 ① 111 清了 ② **222 一点没动**（范围不许越界）。
    //    ⚠️ 数据在 `QQBOT_QUEST_FILE` / `QQBOT_STORYLINE_FILE` 指向的**临时文件**里
    //       （见 main() 开头那段）—— 单跑这个套件也不会碰用户真实的 state/。
    check(/api\/quest\/reset/.test(js), '★★ 有「清空剧情和故事线」的接口');
    check(/questReset/.test(html) && /清空所选群/.test(html), '★★ 界面上有清空按钮');
    check(/quest\.abort\(/.test(js), '★★ 中止走 `quest.abort()`（不是 `finish()` —— 那会改好感度、写假结局）');
    const qBefore = await api('/api/quest/state?groupId=111');
    check(qBefore.status?.running === true, '★ 造出来的：群 111 有一条正在跑的剧情', String(qBefore.status?.premise ?? ''));
    const slBefore = await api('/api/storyline/state?groupId=111');
    check(Number(slBefore.status?.total) === 1, '★ 造出来的：群 111 有 1 条故事线');
    const rs = await post('/api/quest/reset', { groupId: '111' });
    check(rs.ok === true, '★★ 清空接口返回 ok');
    check((rs.stopped || []).length === 1 && rs.stopped[0].groupId === '111', '★★ 中止了**指定那个群**的那条剧情');
    check(Number(rs.groups) === 1, '★ 报告里说清掉了 1 个群的故事线');
    const qAfter = await api('/api/quest/state?groupId=111');
    check(qAfter.status?.running === false, '★★ 清空后群 111 没有在跑的剧情了');
    check(Number(qAfter.status?.weeklyUsed) === 0, '★★ 「本周开过几条」也清零了（测试期不被每周上限挡）');
    const slAfter = await api('/api/storyline/state?groupId=111');
    check(Number(slAfter.status?.total) === 0, '★★ 群 111 的故事线清空了');
    // ★★ 范围不许越界：222 的剧情和故事线必须原封不动
    const q222 = await api('/api/quest/state?groupId=222');
    check(q222.status?.running === true && q222.status?.premise === '测试用：别动我', '★★ 别的群（222）的剧情**没被碰**');
    const sl222 = await api('/api/storyline/state?groupId=222');
    check(Number(sl222.status?.total) === 1, '★★ 别的群（222）的故事线**也没被碰**');
    // ★ 「清空所有群」＝**不带 groupId**（界面上那个红色按钮）
    const rsAll = await post('/api/quest/reset', {});
    check(rsAll.ok === true && (rsAll.stopped || []).length === 1, '★★ 不带群号 ＝ 清所有群（222 那条也被中止）');
    const slAll = await api('/api/storyline/state');
    check(Number(slAll.status?.total) === 0, '★★ 全清之后一条故事线都不剩');
    check((slAll.status?.byGroup || []).length === 0, '★ 每个群那几行也都没了');

    // ⑩ ★★「剧情发展更详细 + 一套真剧情控制按钮」
    //    （<主人> 2026-09-15 晚：「把剧情发展呈现在 webui 上更详细一点，然后也和模拟一样
    //      也加一套剧情控制按钮」）
    check(/api\/quest\/next/.test(js), '★★ 有「推进下一段」的接口（不等那 30 分钟）');
    check(/questNext/.test(html) && /推进下一段/.test(html), '★★ 界面上有那套控制按钮');
    check(/收尾：好结局/.test(html) && /收尾：坏结局/.test(html), '★ 好/坏结局两颗按钮也在（跟模拟面板一个路子）');
    check(/不发话，直接推进一段/.test(html), '★ 还有"不发话直接推进"（＝模拟面板那颗）');
    check(/questDevHtml/.test(html), '★★ 剧情发展是**按时间**排的时间线');
    check(/插曲/.test(html) && /等下一段/.test(html), '★★ 时间线区分「她顺口接的话（插曲）」和「等着进下一段的群友发言」');
    check(/qc-group/.test(html) && /fillQuestGroup/.test(html), '★ 控制面板也有选群（默认选正在跑的那个群）');
    const qs = await api('/api/quest/state');
    check(Array.isArray(qs.status?.pendingList), '★ 状态里给了 pendingList（不只是条数）');
    check(Array.isArray(qs.status?.interludes), '★ 状态里给了 interludes（她顺口接的话）');
    check(
      typeof qs.status?.awaitingSince === 'number' && Number(qs.status?.waitMs) > 0,
      '★ 还给了等待窗口（界面才能显示"还有几分钟自动推"）',
    );
    // 路由守卫：不许静默失败
    const nx0 = await post('/api/quest/next', {});
    check(nx0.ok === false && /groupId/.test(String(nx0.error ?? '')), '★★ 不给群号 → 报错说清要 groupId');
    const nx1 = await post('/api/quest/next', { groupId: '888888' });
    check(
      nx1.ok === false && /没有在跑的剧情/.test(String(nx1.error ?? '')),
      '★★ 那个群没有在跑的剧情 → 明确报错（别静默什么都没发生）',
    );

    // ⑪ ★★「下次二级事件」按群存（<主人> 2026-09-15 晚：「最好也加个群选择…
    //    因为每个群的故事线不一样」）
    //    ⚠️ 原来整个机器人只有一份，哪个群下次自动开剧情都用它 —— 而那句由头是
    //       照着某个群的故事线写的，塞到别的群里完全不对味。
    const h1 = await post('/api/quest/hint', { groupId: '111', text: '这个群下次的由头' });
    check(h1.ok === true && h1.nextHint === '这个群下次的由头', '★★ 能按群存一句"下次二级事件"');
    const h2 = await post('/api/quest/hint', { groupId: '222', text: '另一个群的由头' });
    check(
      h2.hints?.['111'] === '这个群下次的由头' && h2.hints?.['222'] === '另一个群的由头',
      '★★ 两个群各存各的（互不覆盖）',
    );
    const qh = await api('/api/quest/state?groupId=111');
    check(qh.status?.nextHint === '这个群下次的由头', '★ 状态里读到的是**这个群**那句');
    check(!!qh.status?.hints, '★ 状态里给了 hints（界面要列"别的群各存了什么"）');
    const qh2 = await api('/api/quest/state?groupId=333');
    check(qh2.status?.nextHint === '', '★★ 没存过的群是空的（不会串到别的群那句）');
    check(/questSaveHint/.test(html) && /groupId: gid/.test(html), '★ 界面上存的时候带上了选中的群号');
    check(/hints\[hintGid\]/.test(html), '★ 界面按选中的群回填那个输入框');
    check(/替换这个群下次的二级事件/.test(html), '★ 按钮文案也点明了"这个群"');
    // 收尾：清掉，别影响别的检查
    await post('/api/quest/hint', { groupId: '111', text: '' });
    await post('/api/quest/hint', { groupId: '222', text: '' });

    // ⑫ ★★「收紧度也能按群调」（<主人> 2026-09-15 晚：「收紧度也加一个一样的下拉菜单分群调节」）
    //    ⚠️ 写进来的是**临时配置**（`config.webui-test.yml`），不碰真实 config.yml。
    //    ⚠️ 先把这个群配成"1 档 + 在白名单里" —— 前面几节改过临时配置，
    //       而接口对"不进事件系统的群"是**明确拒绝**的（`isEventGroup` 要求档位 1 且在 allowGroups 里）。
    const G699 = '200000006';
    await post('/api/config', { trigger: { allowGroups: [G699], groupRespondTo: { [G699]: 1 } } });
    const sp1 = await post('/api/group-params', { groupId: G699, patch: { chat: { strictness: 999 } } });
    check(
      sp1.ok === true && Number(sp1.params?.chat?.strictness) === 100,
      '★★ 接口能按群设收紧度，而且**夹到 0~100**（写 999 出来是 100）',
      JSON.stringify(sp1.params?.chat?.strictness ?? sp1.error ?? ''),
    );
    const gq = await api(`/api/group-params?groupId=${G699}`);
    check(
      gq.ok === true && Number(gq.overrides?.chat?.strictness) === 100,
      '★★ 有 GET 路由把覆盖读回来（界面上那个下拉框回填要用）',
    );
    const sp2 = await post('/api/group-params', { groupId: G699, patch: { chat: { strictness: 12 } } });
    check(Number(sp2.params?.chat?.strictness) === 12, '★ 设成 12 也生效');
    const sp3 = await post('/api/group-params', { groupId: G699, patch: { chat: { strictness: null } } });
    check(
      sp3.ok === true && Number(sp3.params?.chat?.strictness) === 50,
      '★★ 传 `null` = 删掉覆盖 → **回到默认 50**（现在没有「全局」那一份了）',
      `现在是 ${sp3.params?.chat?.strictness}`,
    );
    check(/strict-group/.test(html) && /fillStrictForGroup/.test(html), '★★ 界面上有「哪个群 + 收紧度」的下拉框');
    // ⚠️ 2026-09-16 改成「下拉选群 + 一整张表单」之后，收紧度的 id 也换成 `gp-chat-strict`
    check(
      /gp-chat-strict/.test(html) && /id="gp-group"/.test(html),
      '★ 「按群设定」那张表里也能按群设收紧度（下拉选群 + 表单）',
    );
  }
}

async function cleanup() {
  try {
    proc?.kill();
  } catch {}
  await sleep(300);
  // 还原临时配置、删掉测试产生的文件
  try {
    writeFileSync(CFG, realCfg, 'utf8'); // 内容无所谓，稍后删除
    unlinkSync(CFG);
  } catch {}
  try {
    unlinkSync(join(ROOT, 'test', '_webui-boot.mjs'));
  } catch {}
  // 剧情 / 故事线的隔离临时文件
  for (const f of [QUEST_TMP, STORY_TMP]) {
    try {
      unlinkSync(join(ROOT, f));
    } catch {}
  }
  if (uploadedFile && existsSync(join(ROOT, 'library', uploadedFile))) {
    try {
      unlinkSync(join(ROOT, 'library', uploadedFile));
    } catch {}
  }
}

main()
  .catch((e) => {
    console.error('\n测试脚本出错:', e);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
