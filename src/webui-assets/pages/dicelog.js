/**
 * 知识库 → 跑团记录（2026-10-23 加）。
 *
 * 展示三样：
 *   · 每个群拉了多少条原始条目、压了多少章、上次拉取时间
 *   · **她实际读到的那段**（promptBlock 的输出，就是进提示词的内容）
 *   · 最近 20 条原始条目（还没压成章节的流水账）
 *
 * ⚠️ 只读：拉取 / 压缩是后端的定时任务（每 5 / 10 分钟），这里不触发。
 */
/**
 * 跑团记录页内部视图切换：梗概（粗压）/ 她读到的 / 全部分章（细压）/ 原始条目。
 *
 * ⚠️ 2026-10-23 加（用户：「粗压—细压—梗概做成知识库那种下拉选择的格式」+
 *    「原始条目可以隐藏吧」）—— 用知识库同款的 `.subtabs` 下划线样式，
 *    但视图容器用 `.dl-subpage`（不能复用 `.subpage`，`showSubTab` 会把它们一起切掉）。
 */
function dlTab(name) {
  document.querySelectorAll('.dl-subtabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.dlsub === name);
  });
  document.querySelectorAll('.dl-subpage').forEach((p) => {
    p.classList.toggle('on', p.dataset.dlsub === name);
  });
}

/**
 * 拉某个群在海豹里的**局列表**（局名 / 条数 / 更新时间）。
 *
 * ⚠️ 2026-10-23 加（用户：「根据 log 名称来选 log」）。
 *    切换群时才会调它 —— 不切群就别反复打海豹。
 */
async function loadDiceGames(gid) {
  const logSel = $('dl-log');
  if (!logSel) return;
  try {
    const r = await api('/api/dice-log/games?group_id=' + encodeURIComponent(gid));
    const list = Array.isArray(r.list) ? r.list : [];
    logSel.innerHTML = list.length
      ? list
          .map((g) => {
            const t = g.updatedAt ? ` · ${new Date(g.updatedAt * 1000).toLocaleDateString()}` : '';
            return `<option value="${esc(g.name)}">${esc(g.name)}（${g.size} 条${t}）</option>`;
          })
          .join('')
      : '<option value="">（这个群海豹里没有局）</option>';
  } catch {
    logSel.innerHTML = '<option value="">（拉取局列表失败）</option>';
  }
}

async function loadDiceLog() {
  const sel = $('dl-group');
  const logSel = $('dl-log');
  const msg = $('dl-msg');
  const gid = sel?.value || '';

  // ⚠️ 2026-10-23：群变了就重新拉一次「这个群有哪些局」
  if (sel && gid && sel.dataset.gid !== gid) {
    sel.dataset.gid = gid;
    await loadDiceGames(gid);
  }
  const logName = logSel?.value || '';

  const qs = new URLSearchParams();
  if (gid) qs.set('group_id', gid);
  if (logName) qs.set('log_name', logName);
  try {
    const r = await api('/api/dice-log' + (qs.toString() ? '?' + qs.toString() : ''));
    if (!r.ok) {
      flash(msg, false, r.error || '读取失败');
      return;
    }

    // 群下拉：只在**群列表变了**时重建（别每次刷新都把用户选中的冲掉）
    if (sel) {
      const want = (r.groups || []).join('|');
      if (sel.dataset.sig !== want) {
        sel.dataset.sig = want;
        sel.innerHTML = want
          ? r.groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')
          : '<option value="">（config.yml 里没配 diceLog.groups）</option>';
        // ⚠️ 首次加载：跟着后端挑的「有数据的那个群」走，别停在一个空群上
        if (!sel.value && r.current) sel.value = r.current;
      }
    }

    const st = r.stats || {};
    const el = $('dl-stats');
    if (el) {
      if (!r.enabled) {
        el.textContent = '跑团记录没启用（config.yml 的 diceLog.enable）';
      } else if (r.live) {
        // ⚠️ 2026-10-23：选了某个局 = **实时预览**（不落盘，不动当前在压的那一局）
        el.textContent = [
          `实时预览「${r.logName}」`,
          `共 ${st.items ?? 0} 条`,
          `${st.chars ?? 0} 字`,
          `骰子 ${st.dice ?? 0} 条`,
          `场外 ${st.ooc ?? 0} 条（压缩时会剔掉）`,
        ].join(' · ');
      } else {
        el.textContent = [
          `原文 ${st.items ?? 0} 条`,
          `已压 ${st.chapters ?? 0} 章`,
          st.lastNoteAt
            ? `上次拉取 ${new Date(Number(st.lastNoteAt)).toLocaleString()}`
            : '还没拉过',
        ].join(' · ');
      }
    }

    const sm = $('dl-summary');
    if (sm) sm.textContent = r.summary || '（还没压出梗概）';

    const content = r.block || '';
    const ta = $('dl-content');
    if (ta) ta.value = content;
    const blk = $('dl-block');
    if (blk) blk.innerHTML = content ? kMarkdown(content) : '（还没压缩出章节）';
    // 保存按钮：没章节就没得存
    const sv = $('dl-save');
    if (sv) sv.disabled = !content;

    const rc = $('dl-recent');
    if (rc) {
      const rows = Array.isArray(r.recent) ? r.recent : [];
      rc.innerHTML = rows.length
        ? rows
            .map(
              (x) =>
                `<div class="lrow"><span class="pill">${x.dice ? '骰' : '言'}</span> ` +
                `${esc(x.who || '?')}：${esc(x.text || '')}</div>`,
            )
            .join('')
        : '<span class="empty">还没有原始条目</span>';
    }

    // ⚠️ 2026-10-23：全部细压章节（提示词里只放最近两章，这里给全量）
    const ch = $('dl-chapters');
    if (ch) {
      const list = Array.isArray(r.chapters) ? r.chapters : [];
      ch.innerHTML = list.length
        ? list
            .map(
              (t, i) =>
                `<div class="lrow"><span class="pill">${i + 1}</span> ${esc(String(t ?? ''))}</div>`,
            )
            .join('')
        : '<span class="empty">还没有章节（等压缩跑完）</span>';
    }
    flash(msg, true, '已刷新');
  } catch (e) {
    flash(msg, false, '出错：' + e.message);
  }
}

// ════════════════════════════════════════════════════════════
// 跑团记录 → 章节：预览 / 编辑 / 保存（和知识文件页同一套手感）
// ════════════════════════════════════════════════════════════
function dlMode(m) {
  const isEdit = m === 'edit';
  $('dl-mode-prev')?.classList.toggle('on', !isEdit);
  $('dl-mode-edit')?.classList.toggle('on', isEdit);
  $('dl-editwrap')?.classList.toggle('hidden', !isEdit);
  $('dl-block')?.classList.toggle('hidden', isEdit);
  if (!isEdit && $('dl-block')) {
    $('dl-block').innerHTML =
      kMarkdown($('dl-content')?.value || '') || '（还没压缩出章节）';
  }
}

async function dlSave() {
  const gid = $('dl-group')?.value || '';
  const msg = $('dl-msg2');
  if (!gid) {
    flash(msg, false, '没选群');
    return;
  }
  const r = await api('/api/dice-log/chapters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id: gid, content: $('dl-content')?.value || '' }),
  });
  flash(msg, r.ok, r.ok ? `已保存（${r.chapters} 章）` : '保存失败：' + (r.error || ''));
  if (r.ok) {
    dlMode('prev');
    loadDiceLog();
  }
}
//
// ⚠️ 格式和「知识文件」页**完全对齐**：通栏大卡片下拉 + 预览。
//    用独立前缀 `o-`（`o-lib-*` / `o-file-*`），和 `k-` 那套互不干扰。
// ════════════════════════════════════════════════════════════
let OLIB_CUR = '';
let OFILE_CUR = '';

/** 进页面时调：确保文件列表已加载，然后渲染两个大卡片下拉 */
async function oInit() {
  if (!$('o-lib-menu')) return;
  if (!KFILES.length) {
    try {
      await loadKnowledgeList();
    } catch {
      /* 拉不到就按空处理，下面会提示"还没有这一类文件" */
    }
  }
  oListFilter();
}

function oListFilter() {
  const libMenu = $('o-lib-menu');
  const fileMenu = $('o-file-menu');
  if (!libMenu || !fileMenu) return;

  const groups = KGROUPS_OBSERVE.filter((g) => KFILES.some((f) => kGroupOf(f) === g));
  if (!OLIB_CUR || !groups.includes(OLIB_CUR)) OLIB_CUR = groups[0] || '';

  libMenu.innerHTML =
    groups
      .map((g) => {
        const n = KFILES.filter((f) => kGroupOf(f) === g).length;
        const on = g === OLIB_CUR;
        return (
          `<button type="button" role="option" aria-selected="${on}" class="klib${on ? ' on' : ''}"`
          + ` onclick="oPickLib('${esc(g).replace(/'/g, '&#39;')}')">`
          + `<span class="klt">${esc(g)}<span class="tag">${n} 个</span></span>`
          + `<span class="kln">${esc(KLIB_DESC[g] || '')}</span></button>`
        );
      })
      .join('') || '<span class="empty">还没有这一类文件</span>';

  const items = KFILES.filter((f) => kGroupOf(f) === OLIB_CUR);
  fileMenu.innerHTML =
    items
      .map((f) => {
        const tag = kShortTag(f);
        const on = f.name === OFILE_CUR;
        return (
          `<button type="button" role="option" aria-selected="${on}" class="kfcard${on ? ' on' : ''}"`
          + ` onclick="oPickFile('${esc(f.name).replace(/'/g, '&#39;')}')">`
          + `<span class="fn2"><span class="fnl">${esc(kFileLabel(f))}</span>`
          + (tag ? `<span class="tag">${esc(tag)}</span>` : '')
          + `</span><span class="fsz">${kFmtSize(f.size)}</span></button>`
        );
      })
      .join('') || '<span class="empty">这个库里还没有文件</span>';

  // 大卡片上只写「当前选中项」
  const lv = $('o-lib-value');
  if (lv) {
    lv.textContent = OLIB_CUR || '（没有可用的知识库）';
    lv.classList.toggle('is-empty', !OLIB_CUR);
  }
  const sel = items.find((f) => f.name === OFILE_CUR);
  const fv = $('o-file-value');
  if (fv) {
    fv.textContent = sel ? kFileLabel(sel) : '（这个库里还没有文件）';
    fv.classList.toggle('is-empty', !sel);
  }
  const hint = $('o-libhint');
  if (hint) hint.textContent = OLIB_CUR ? `${OLIB_CUR}：${KLIB_DESC[OLIB_CUR] || ''}` : '';

  // 没有选中项就默认选第一个，然后加载预览
  if (!sel && items.length) {
    OFILE_CUR = items[0].name;
    oListFilter();
    return;
  }
  oPreview();
}

function oPickLib(group) {
  if (!KFILES.some((f) => kGroupOf(f) === group)) return;
  OLIB_CUR = group;
  const first = KFILES.find((f) => kGroupOf(f) === group);
  OFILE_CUR = first ? first.name : '';
  kDropCloseAll();
  oListFilter();
}

function oPickFile(name) {
  OFILE_CUR = name;
  kDropCloseAll();
  oListFilter();
}

async function oPreview() {
  await oLoad();
}

/** 读当前文件填进编辑器 / 预览（和知识文件页的 `loadKnowledge()` 同一套语义） */
async function oLoad() {
  const box = $('o-content');
  if (!box) return;
  if (!OFILE_CUR) {
    if ($('o-preview')) $('o-preview').textContent = '（这个库还没有文件）';
    return;
  }
  const r = await api('/api/knowledge?name=' + encodeURIComponent(OFILE_CUR));
  if (!r.ok) {
    box.value = '（读取失败：' + (r.error || '') + '）';
    if ($('o-preview')) $('o-preview').textContent = box.value;
    return;
  }
  box.value = r.content;
  // ⚠️ 只读与否由服务端说了算（和知识文件页一致）
  const list = await api('/api/knowledge/list');
  const meta = (list.files ?? []).find((f) => f.name === OFILE_CUR);
  const ro = meta?.readonly === true;
  box.readOnly = ro;
  const sv = $('o-save');
  if (sv) {
    sv.disabled = ro;
    sv.textContent = ro ? '只读' : '保存';
  }
  oDirty(false);
  const prev = $('o-mode-prev');
  if (prev && prev.classList.contains('on') && $('o-preview')) {
    $('o-preview').innerHTML = kMarkdown(r.content);
  }
}

function oMode(m) {
  const isEdit = m === 'edit';
  $('o-mode-prev')?.classList.toggle('on', !isEdit);
  $('o-mode-edit')?.classList.toggle('on', isEdit);
  $('o-editwrap')?.classList.toggle('hidden', !isEdit);
  $('o-preview')?.classList.toggle('hidden', isEdit);
  if (!isEdit && $('o-preview')) {
    $('o-preview').innerHTML = kMarkdown($('o-content')?.value || '');
  }
}

function oDirty(on) {
  const d = $('o-save');
  if (d && !d.disabled) d.textContent = on ? '保存 ●' : '保存';
}

function oReload() {
  oLoad();
  flash($('msg-o'), true, '已重新读取');
}

async function oSave() {
  if (!OFILE_CUR) return;
  const r = await api('/api/knowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: OFILE_CUR, content: $('o-content')?.value || '' }),
  });
  flash($('msg-o'), r.ok, r.ok ? '已保存并生效' : '保存失败：' + (r.error || ''));
  if (r.ok) {
    oDirty(false);
    oLoad();
  }
}
