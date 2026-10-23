/**
 * 模型页（`tab-model`）的全部前端逻辑 —— 2026-10-22 从 `webui-app.js` 拆出来。
 *
 * ## 里面有什么
 *   · 身份卡（主人 / 机器人 + 她的称呼）
 *   · 模型提供商（多提供商列表 / 存档 / 降级）
 *   · 备选模型 / 慢消息 / 思考链开关
 *   · 保存 + 连通性测试
 *
 * ## ⚠️ 无构建方案的约定
 *   这份脚本由 `webui.html` **在 `webui-app.js` 之后**加载，
 *   所以它**直接用**那些全局：`$` / `api` / `flash` / `esc` / `kv` /
 *   `fillModelSelect` / `loadModels` / `fillDatalist` / `STATE` / `CUR_ACCOUNT`。
 *   ⚠️ 别在这里 `import`、也别写 `export` —— 这是浏览器里的普通脚本，不是模块。
 *   ⚠️ 以后加"模型页专属"的函数就写在这个文件里，别再往 `webui-app.js` 里塞。
 */

// ── 保存：模型 ──
/**
 * 保存「主人 / 机器人」这两个 QQ。
 *
 * ⚠️ 2026-09-15 用户要求：「把群主改成可编辑的，并且**改称主人**」。
 * 原来它在状态页上只是**只读一行字**（`kv('群主', …)`），想改只能去编辑 config.yml。
 *
 * ⚠️ 两个都要**只留数字**再存：填了空格/引号的话，
 *    `start-all.ps1`（一键启动）读 `botQQ` 做快速登录时会读不到（那个脚本的正则只认数字）。
 */
async function saveIdentity() {
  const el = $('msg-id');
  const ownerQQ = String($('id-ownerQQ').value || '').replace(/\D/g, '');
  const botQQ = String($('id-botQQ').value || '').replace(/\D/g, '');
  // ⚠️ 2026-09-28：主人的各种叫法跟着这张卡一起存。
  //    `pjList` 负责按 `、,，` 拆行、trim、去空 —— 手打成「粥粥、舟老师」一整行也认。
  const ownerAliases = pjList($('id-ownerAliases')?.value);
  if (!ownerQQ) return flash(el, false, '主人 QQ 不能空');
  if (!botQQ) return flash(el, false, '机器人 QQ 不能空');
  if (ownerQQ === botQQ) return flash(el, false, '主人和机器人不能是同一个 QQ');
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ ownerQQ, botQQ, ownerAliases }),
  });
  if (!r.ok) return flash(el, false, '保存失败：' + r.error);

  // ⚠️⚠️ 2026-10-05 加（用户要求：「群友下的项目不知道怎么改，最好在 webui 上加一个修改入口」）：
  //    **顺手把她对主人的称呼也改了** —— 那两个框就在上面。
  //    原来是藏在「人设」页的称呼区里（还要懂 owner / ownerFormal / ownerRule 三个字段），
  //    刚拿到项目的人根本找不到。
  //    ⚠️ 只在她**填了**的时候改；留空 = 不动人设（免得手滑把称呼清掉）。
  //    ⚠️ 写的是**当前这个人设包**的 identity.json（"称呼"是每个角色各存一份的）。
  const ownerName = String($('id-ownerName')?.value ?? '').trim();
  const ownerFormal = String($('id-ownerFormal')?.value ?? '').trim();
  let nameMsg = '';
  if (ownerName || ownerFormal) {
    try {
      // ⚠️ `GET /api/persona` **必须带 id**（不带会 400），而 `/api/state` 里**没有** persona 段
      //    ⇒ 当前角色从 `/api/persona/list` 的 `current` 取（那个接口就是给人设页用的）。
      const lst = await api('/api/persona/list');
      const curId = lst?.current ?? '';
      const cur = await api(`/api/persona?id=${encodeURIComponent(curId)}`);
      const it = JSON.parse(JSON.stringify(cur?.identity ?? {}));
      it.address = { ...(it.address ?? {}) };
      if (ownerName) it.address.owner = ownerName;
      if (ownerFormal) it.address.ownerFormal = ownerFormal;
      const r2 = await api('/api/persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: curId || it.id, identity: it }),
      });
      nameMsg = r2?.ok ? '；她对他的称呼也改了' : `；称呼**没**改成（${r2?.error ?? '不知道为啥'}）`;
    } catch (e) {
      nameMsg = `；称呼**没**改成（${e.message}）`;
    }
  }
  flash(el, true, `已保存并生效${nameMsg}`);
  reloadAll();
}

/**
 * ⚠️ 2026-10-05 加：把当前人设里「她怎么称呼主人」读出来填进那两个框。
 * ⚠️ 挂在那两个框的 `onfocus` 上（点进去才读）—— 不用改 `loadConfig` 的加载顺序，
 *    而且读不到就留空（留空 = 保存时不碰人设）。
 */
async function loadOwnerName() {
  try {
    // ⚠️ 同样要带 id（见上面 `saveIdentity` 里那条注释）；`current` 来自 persona/list
    const lst = await api('/api/persona/list');
    const curId = lst?.current ?? '';
    const p = await api(`/api/persona?id=${encodeURIComponent(curId)}`);
    const a = (p && p.identity && p.identity.address) || {};
    const n = $('id-ownerName');
    const f = $('id-ownerFormal');
    if (n && !n.value) n.value = a.owner ?? '';
    if (f && !f.value) f.value = a.ownerFormal ?? '';
  } catch {}
}

/* ══════════════════════════════════════════════════════════════════
 * ⚠️ 2026-10-22 加：**多提供商 + 拖动排序 + 设定存档**
 *   用户：「给主模型加个可保存之前的模型设定并新加一个模型提供商的功能，
 *   再加一个模型优先级卡片滑动排序设置」
 *
 * ## 拖动排序用的是**原生 HTML5 drag & drop**（不引库：这页面是自包含单文件）
 * ## ⚠️ 顺序 = 优先级，但**真正用哪个由 activeId 决定**（别让用户以为拖一下就切换了）
 * ══════════════════════════════════════════════════════════════════ */
let PROV = [];        // 提供商列表（顺序=优先级）
let PROV_ACTIVE = ''; // 当前启用的 id
let PF_LIST = [];     // 存档列表
let dragIdx = -1;     // 正在拖第几个

function provCardHtml(p, i) {
  const on = i === 0;                      // ⚠️ 第 0 个 = 主模型（顺序即优先级）
  const numOr = (v) => (v === null || v === undefined || v === '' ? '' : v);
  return `<div class="prov-item" draggable="true" data-idx="${i}"
       style="border:1px solid ${on ? '#4a9eff' : 'rgba(255,255,255,.12)'};border-radius:10px;
              padding:12px;margin-bottom:10px;background:${on ? 'rgba(74,158,255,.08)' : 'transparent'};cursor:grab">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="opacity:.5;cursor:grab">⠿</span>
      <b style="flex:1">${esc(p.name || '未命名')}</b>
      ${on ? '<span style="color:#4a9eff;font-size:12px">● 主模型（优先级最高）</span>' : ''}
      ${on ? '' : `<button class="ghost" style="padding:4px 10px" onclick="promoteProvider(${i})">设为主模型</button>`}
      <button class="ghost" style="padding:4px 10px;color:#f85149" onclick="delProvider(${i})">删除</button>
    </div>
    <div class="row" style="gap:8px">
      <div style="flex:1;min-width:120px"><div class="d" style="display:block">名字</div>
        <input type="text" value="${esc(p.name || '')}" oninput="PROV[${i}].name=this.value" style="width:100%"></div>
      <div style="flex:2;min-width:180px"><div class="d" style="display:block">API 地址（baseURL）</div>
        <input type="text" value="${esc(p.baseURL || '')}" oninput="PROV[${i}].baseURL=this.value" placeholder="https://api.deepseek.com/v1" style="width:100%"></div>
    </div>
    <div class="row" style="gap:8px;margin-top:6px">
      <div style="flex:2;min-width:180px"><div class="d" style="display:block">模型名（点右边可拉列表，也能直接手打）</div>
        <div style="display:flex;gap:6px">
          <input type="text" list="prov-models-${i}" value="${esc(p.model || '')}" oninput="PROV[${i}].model=this.value"
                 placeholder="deepseek-chat" style="width:100%">
          <button class="ghost" style="padding:4px 8px;white-space:nowrap" onclick="provLoadModels(${i})">拉列表</button>
        </div>
        <datalist id="prov-models-${i}"></datalist></div>
      <div style="flex:2;min-width:180px"><div class="d" style="display:block">API Key（留空 = 沿用原来的）</div>
        <input type="password" value="${esc(p.apiKey || '')}" oninput="PROV[${i}].apiKey=this.value" placeholder="sk-..." style="width:100%"></div>
    </div>
    <div class="row" style="gap:8px;margin-top:6px">
      <div style="flex:1;min-width:110px"><div class="d" style="display:block">temperature（0~2）</div>
        <input type="number" step="0.1" min="0" max="2" value="${numOr(p.temperature)}"
               oninput="PROV[${i}].temperature=this.value===''?null:Number(this.value)" placeholder="1" style="width:100%"></div>
      <div style="flex:1;min-width:110px"><div class="d" style="display:block">单次最大 token</div>
        <input type="number" value="${numOr(p.maxTokens)}"
               oninput="PROV[${i}].maxTokens=this.value===''?null:Number(this.value)" placeholder="8000" style="width:100%"></div>
      <div style="flex:1;min-width:110px"><div class="d" style="display:block">超时（毫秒）</div>
        <input type="number" value="${numOr(p.timeout)}"
               oninput="PROV[${i}].timeout=this.value===''?null:Number(this.value)" placeholder="60000" style="width:100%"></div>
    </div>
    <div style="margin-top:6px">
      <div class="d" style="display:block">同家备用模型（<b>限流时按顺序换</b>，逗号分隔；留空 = 直接跨到下一家）</div>
      <input type="text" value="${esc((p.fallbackModels || []).join(','))}"
             oninput="PROV[${i}].fallbackModels=this.value.split(/[,，、\\n]/).map(s=>s.trim()).filter(Boolean)"
             placeholder="例：kimi-k2.8-preview,glm-5.3-flash" style="width:100%">
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
      <button class="ghost" style="padding:4px 10px" onclick="provTest(${i})">测试连通性</button>
      <span class="msg" id="prov-msg-${i}"></span>
    </div>
  </div>`;
}

function renderProviders() {
  const box = $('prov-list');
  if (!box) return;
  if (!PROV.length) {
    box.innerHTML = '<div class="d" style="display:block;padding:14px;text-align:center">'
      + '还没有提供商 ⇒ 点下面的「＋ 添加提供商」加一个，第 1 个就是主模型 ✓</div>';
    return;
  }
  box.innerHTML = PROV.map((p, i) => provCardHtml(p, i)).join('');
  // 绑拖动
  [...box.querySelectorAll('.prov-item')].forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      dragIdx = Number(el.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
      el.style.opacity = '0.4';
    });
    el.addEventListener('dragend', () => { el.style.opacity = '1'; });
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const to = Number(el.dataset.idx);
      if (dragIdx < 0 || dragIdx === to) return;
      const [moved] = PROV.splice(dragIdx, 1);
      PROV.splice(to, 0, moved);
      dragIdx = -1;
      renderProviders();
      const m = $('msg-prov');
      if (m) flash(m, true, '顺序已改，记得点「保存列表」');
    });
  });
}

function addProvider() {
  const n = PROV.length + 1;
  PROV.push({
    id: `p${Date.now().toString(36)}`,
    name: `提供商 ${n}`,
    baseURL: '', apiKey: '', model: '',
    // ⚠️ 2026-10-22：**留空 = 沿用主模型那套**（`null` 存进配置，`llmCfg()` 会回落）✓
    temperature: null, maxTokens: null, timeout: null,
  });
  renderProviders();
}

function delProvider(i) {
  const p = PROV[i];
  if (!p) return;
  if (!confirm(`删掉「${p.name}」？`)) return;
  PROV.splice(i, 1);
  renderProviders();
}

/**
 * 把第 i 个**提到第一位**（= 设为主模型）并立刻保存。
 *
 * ⚠️ 2026-10-22 改：原来这个按钮叫「启用」，靠 `activeId` 决定用谁 ——
 *    那和"拖动排序 = 优先级"是**两套互相打架的机制**（拖到第一位的可能不是 activeId 指的）。
 *    用户要的是「排在模型提供商的第一个」⇒ 现在**顺序就是唯一的判据**，
 *    这个按钮等价于"挪到第一位 + 保存" ✓
 */
async function promoteProvider(i) {
  const p = PROV[i];
  if (!p) return;
  if (!p.baseURL) { flash($('msg-prov'), false, '这个提供商还没填 API 地址'); return; }
  if (i > 0) {
    const [moved] = PROV.splice(i, 1);
    PROV.unshift(moved);
  }
  PROV_ACTIVE = PROV[0]?.id || '';
  renderProviders();
  await saveProviders();
  flash($('msg-prov'), true, `已把「${PROV[0]?.name || ''}」设为主模型 ✓`);
}

/** 拉某个提供商的模型列表（用**它自己**的地址和密钥，不碰别的卡） */
async function provLoadModels(i) {
  const p = PROV[i];
  const m = $(`prov-msg-${i}`);
  if (!p) return;
  if (!p.baseURL) { flash(m, false, '先填 API 地址'); return; }
  if (m) { m.textContent = '正在拉取…'; m.style.color = '#888'; }
  try {
    const r = await api('/api/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL: String(p.baseURL || '').trim(), apiKey: String(p.apiKey || '').trim() }),
    });
    const dl = $(`prov-models-${i}`);
    if (r.ok && r.models && r.models.length) {
      if (dl) dl.innerHTML = [...new Set(r.models)].map((x) => `<option value="${esc(x)}"></option>`).join('');
      flash(m, true, `拉到 ${r.models.length} 个，点输入框就能选`);
    } else {
      flash(m, false, `拉取失败：${r.error || '未知'} —— 可以直接手打模型名`);
    }
  } catch (e) {
    flash(m, false, '拉取出错：' + e.message);
  }
}

/** 测某个提供商能不能通（只测这一套，不改真实配置） */
async function provTest(i) {
  const p = PROV[i];
  const m = $(`prov-msg-${i}`);
  if (!p) return;
  if (m) { m.textContent = '测试中…'; m.style.color = '#888'; }
  try {
    const r = await api('/api/test-llm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: {
        baseURL: String(p.baseURL || '').trim(),
        model: String(p.model || '').trim(),
        apiKey: String(p.apiKey || '').trim(),
      } }),
    });
    flash(m, r.ok, r.ok ? `连通，${r.ms}ms，返回「${r.reply}」` : `失败：${r.error}`);
  } catch (e) {
    flash(m, false, '测试出错：' + e.message);
  }
}

async function saveProviders() {
  const m = $('msg-prov');
  /* ⚠️ 2026-10-22：**必须走 `api()`**（它会带 `x-saki-account` 头）——
   *    裸 `fetch` 不带那个头 ⇒ 后端永远当成主号，改的是**主号**的配置，
   *    而界面上看着像改成功了 ✗（语音那个 tab 就踩过一次） */
  const r = await api('/api/llm-providers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers: PROV, activeId: PROV_ACTIVE }),
  });
  if (!r.ok) { flash(m, false, '保存失败：' + (r.error || '')); return; }
  PROV = r.providers || PROV;
  PROV_ACTIVE = r.activeId || (PROV[0]?.id || '');
  renderProviders();
  flash(m, true, `已保存 ${PROV.length} 个提供商 ✓ 主模型 = ${PROV[0]?.name || ''}`);
}

async function loadProviders() {
  try {
    const j = await api('/api/llm-providers');
    if (!j.ok) return;
    PROV = Array.isArray(j.providers) ? j.providers : [];
    PROV_ACTIVE = String(j.activeId || (PROV[0]?.id || ''));
    PF_LIST = Array.isArray(j.profiles) ? j.profiles : [];
    renderProviders();
    renderProfiles();
    renderFallback(j.fallback);
  } catch { /* ignore */ }
}

/* ⚠️ 2026-10-22：**降级状态条**
 *   用户要求：「优先级在前的模型不可用，兜底自动使用后一级的模型 10 分钟，
 *   10 分钟之后自动重试」⇒ 这里把"降到哪一级 / 还剩多久 / 为什么降"显示出来 ✓ */
function renderFallback(fo) {
  const box = $('prov-fallback');
  if (!box) return;
  // ⚠️ 2026-10-22：**同家换模型也算降级中**（`sameVendor`）——
  //    用户要求「主模型被限流时先换相同供应商的正常模型」⇒ 界面上要能看出"没换家，只换了模型" ✓
  if (!fo || (!fo.level && !fo.modelIdx)) { box.style.display = 'none'; return; }
  const mm = Math.floor((fo.secondsLeft || 0) / 60);
  const ss = (fo.secondsLeft || 0) % 60;
  box.style.display = 'block';
  if (fo.sameVendor) {
    box.innerHTML = `⚠️ <b>主模型被限流</b> ⇒ 同一家（${esc(fo.activeName || '?')}）换成
      「<b>${esc(fo.activeModel || '?')}</b>」
      <br>${mm} 分 ${String(ss).padStart(2, '0')} 秒后<b>自动回主模型重试</b>
      <span style="opacity:.7;font-size:12px">（这家还剩 ${fo.fbLeft || 0} 个备用模型没试）</span>
      ${fo.lastErr ? `<br><span style="opacity:.7;font-size:12px">原因：${esc(fo.lastErr)}</span>` : ''}
      <div style="margin-top:8px"><button class="ghost" style="padding:4px 10px" onclick="resetFallback()">立刻回主模型重试</button></div>`;
    return;
  }
  box.innerHTML = `⚠️ <b>正在降级运行</b>：主模型「${esc(fo.mainName || '?')}」不可用
    ⇒ 现在用第 ${fo.level + 1} 级「<b>${esc(fo.activeName || '?')}</b>」（${esc(fo.activeModel || '')}）
    <br>${mm} 分 ${String(ss).padStart(2, '0')} 秒后<b>自动回主模型重试</b>
    ${fo.lastErr ? `<br><span style="opacity:.7;font-size:12px">原因：${esc(fo.lastErr)}</span>` : ''}
    <div style="margin-top:8px"><button class="ghost" style="padding:4px 10px" onclick="resetFallback()">立刻回主模型重试</button></div>`;
}

async function resetFallback() {
  const r = await (await fetch('/api/llm-fallback/reset', { method: 'POST' })).json();
  renderFallback(r.fallback);
  flash($('msg-prov'), true, '已复位 ⇒ 下次调用就用主模型');
}

/* ── 设定存档 ─────────────────────────────────── */
function renderProfiles() {
  const box = $('pf-list');
  if (!box) return;
  if (!PF_LIST.length) {
    box.innerHTML = '<div class="d" style="display:block;padding:10px">还没有存过设定</div>';
    return;
  }
  box.innerHTML = PF_LIST.map((p) => {
    const when = p.savedAt ? new Date(p.savedAt).toLocaleString('zh-CN', { hour12: false }) : '';
    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08)">
      <div style="flex:1">
        <b>${esc(p.name || '')}</b>
        <div class="d" style="display:block;font-size:12px">${esc(p.model || '')} · ${esc((p.baseURL || '').replace(/^https?:\/\//, ''))} · ${when}</div>
      </div>
      <button class="ghost" style="padding:4px 10px" onclick="loadProfile('${esc(p.name || '')}')">载入</button>
      <button class="ghost" style="padding:4px 10px;color:#f85149" onclick="delProfile('${esc(p.name || '')}')">删除</button>
    </div>`;
  }).join('');
}

async function saveProfile() {
  const m = $('msg-pf');
  const name = String(($('pf-name') || {}).value || '').trim();
  if (!name) { flash(m, false, '先给这份设定起个名字'); return; }
  const r = await (await fetch('/api/llm-profiles/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })).json();
  if (!r.ok) { flash(m, false, '存不下来：' + (r.error || '')); return; }
  PF_LIST = r.profiles || [];
  renderProfiles();
  if ($('pf-name')) $('pf-name').value = '';
  flash(m, true, `已存「${name}」✓`);
}

async function loadProfile(name) {
  const m = $('msg-pf');
  if (!confirm(`载入「${name}」？\n会覆盖当前的提供商列表和模型配置。`)) return;
  const r = await (await fetch('/api/llm-profiles/load', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })).json();
  if (!r.ok) { flash(m, false, '载入失败：' + (r.error || '')); return; }
  flash(m, true, `已载入「${name}」✓`);
  await loadProviders();
  // 把上面那张卡也刷一遍
  try {
    const j = await (await fetch('/api/llm-providers')).json();
    if (j.ok) {
      if ($('llm-baseURL')) $('llm-baseURL').value = j.current.baseURL || '';
      if ($('llm-model')) $('llm-model').innerHTML = `<option>${esc(j.current.model || '')}</option>`;
      if ($('llm-temperature')) $('llm-temperature').value = j.current.temperature ?? 1;
      if ($('llm-maxTokens')) $('llm-maxTokens').value = j.current.maxTokens ?? 8000;
      if ($('llm-timeout')) $('llm-timeout').value = j.current.timeout ?? 60000;
    }
  } catch { /* ignore */ }
}

async function delProfile(name) {
  const m = $('msg-pf');
  if (!confirm(`删掉设定「${name}」？`)) return;
  const r = await (await fetch('/api/llm-profiles/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })).json();
  if (!r.ok) { flash(m, false, '删不掉：' + (r.error || '')); return; }
  PF_LIST = r.profiles || [];
  renderProfiles();
  flash(m, true, '已删除');
}

async function saveModel() {
  const el = $('msg-llm2');
  const txt = (id) => {
    const e = $('llm-' + id);
    const v = e && e.value != null ? String(e.value).trim() : '';
    return v || undefined;
  };
  const num = (id) => {
    const v = txt(id);
    return v === undefined ? undefined : Number(v);
  };
  const bool = (id) => {
    const e = $('llm-' + id);
    return e ? !!e.checked : undefined;
  };
  const cnt = num('slowDropCount');
  const visionModel = $('vision-model');
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      llm: {
        slowQueueDrop: bool('slowDrop'),
        unfiltered: bool('unfiltered'),
        thinking: {
          peer: bool('thinkPeer'),
          questPeer: bool('thinkQuestPeer'),
          quest: bool('thinkQuest'),
        },
        backup: {
          for: {
            peer: bool('bkPeer'),
            questPeer: bool('bkQuestPeer'),
            quest: bool('bkQuest'),
          },
          baseURL: txt('bkBase'),
          model: txt('bkModel'),
          apiKey: txt('bkKey'),
          temperature: num('bkTemperature'),
        },
        slowQueueDropCount:
          cnt === undefined ? undefined : Math.max(1, Math.floor(cnt)) || 3,
      },
      vision: visionModel ? { model: visionModel.value.trim() } : undefined,
    }),
  });
  flash(el, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
  if (r.ok) reloadAll();
}

/**
 * 测试主模型连通性。
 * ⚠️ 2026-10-22：原来那张「大模型」卡删掉之后**没有调用点了**（每张提供商卡片
 *    现在用 `provTest(i)` 测自己那套）。这里保留但加防护 —— 免得哪天有人再调它，
 *    读已删的框直接抛 `Cannot read properties of null` ✗
 */
async function testLLM() {
  const el = $('msg-llm');
  const base = $('llm-baseURL');
  const mdl = $('llm-model');
  const key = $('llm-apiKey');
  if (!base || !mdl || !key) { flash(el, false, '主模型那套已经并到「模型提供商」卡片了，用那张卡上的「测试连通性」'); return; }
  flash(el, null, '测试中…');
  const r = await api('/api/test-llm', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ llm: {
      baseURL: base.value.trim(),
      model: mdl.value.trim(),
      apiKey: key.value.trim(),
    }})
  });
  flash(el, r.ok, r.ok ? `连通，${r.ms}ms，返回「${r.reply}」` : `失败：${r.error}`);
}
