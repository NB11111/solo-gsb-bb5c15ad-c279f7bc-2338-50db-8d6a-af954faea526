'use strict';

/* 全局状态：rows 为当前校订结果，结构：
 * { id, text, start, end, sim, oldRefs:[{index,text}], baseFlags:[], ack }
 * baseFlags 来自服务端（uncertain / unmatched），ack 后清除；
 * reversed / overlap 每次渲染前实时重算。
 */
const state = {
  rows: [],
  droppedOld: [],
  nextId: 1,
  pendingOnly: false,
  lastSrt: '',
};

const $ = (sel) => document.querySelector(sel);

const FLAG_LABELS = {
  uncertain: '不确定',
  unmatched: '未匹配',
  reversed: '倒序',
  overlap: '重叠',
};

/* ---------- 时码工具 ---------- */

function pad(v, n) { return String(v).padStart(n, '0'); }

function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

function parseTimecode(str) {
  const m = String(str).trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4].padEnd(3, '0').slice(0, 3));
}

/* ---------- 行级计算（与服务端规则一致） ---------- */

function computeFlags(rows) {
  rows.forEach((r, k) => {
    const flags = new Set(r.baseFlags);
    if (r.start != null && r.end != null && r.end <= r.start) flags.add('reversed');
    if (k > 0 && r.start != null && rows[k - 1].end != null && r.start < rows[k - 1].end) flags.add('overlap');
    r.flags = [...flags];
  });
}

function splitRangeByLength(start, end, t1, t2) {
  const dur = end - start;
  const l1 = Math.max(1, t1.trim().length);
  const l2 = Math.max(1, t2.trim().length);
  let cut = dur <= 0 ? start : Math.round(start + (dur * l1) / (l1 + l2));
  if (dur >= 800) cut = Math.max(start + 400, Math.min(end - 400, cut));
  return [[start, cut], [cut, end]];
}

/* ---------- 上传与对齐 ---------- */

async function loadFileInto(file, target) {
  if (!file) return;
  $(target).value = await file.text();
}

$('#srtFile').addEventListener('change', (e) => loadFileInto(e.target.files[0], '#srtText'));
$('#revFile').addEventListener('change', (e) => loadFileInto(e.target.files[0], '#revText'));

$('#alignBtn').addEventListener('click', async () => {
  const msg = $('#alignMsg');
  msg.className = 'msg';
  msg.textContent = '对齐中…';
  try {
    const res = await fetch('/api/align', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srt: $('#srtText').value, revised: $('#revText').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '对齐失败');
    state.rows = data.rows.map((r) => ({
      id: state.nextId++,
      text: r.text,
      start: r.start,
      end: r.end,
      sim: r.sim,
      oldRefs: r.oldRefs || [],
      baseFlags: (r.flags || []).filter((f) => f === 'uncertain' || f === 'unmatched'),
      ack: false,
    }));
    state.droppedOld = data.droppedOld || [];
    renderStats(data.stats);
    renderDropped();
    renderRows();
    $('#step-review').classList.remove('hidden');
    $('#step-preview').classList.add('hidden');
    msg.className = 'msg ok';
    msg.textContent = `对齐完成：${data.stats.rowCount} 行输出，${data.stats.pending} 行待处理`;
    $('#step-review').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    msg.textContent = err.message;
  }
});

/* ---------- 渲染 ---------- */

function renderStats(s) {
  $('#statsBar').innerHTML = [
    `<span class="stat"><b>${s.oldCount}</b>旧条目</span>`,
    `<span class="stat"><b>${s.revisedCount}</b>修订行</span>`,
    `<span class="stat"><b>${s.rowCount}</b>输出行</span>`,
    `<span class="stat"><b>${s.splits}</b>拆分</span>`,
    `<span class="stat"><b>${s.merges}</b>合并</span>`,
    `<span class="stat ok"><b>${s.ok}</b>正常</span>`,
    `<span class="stat warn"><b>${s.pending}</b>待处理</span>`,
    `<span class="stat"><b>${s.dropped}</b>旧条目被丢弃</span>`,
  ].join('');
}

function refreshStatsPending() {
  computeFlags(state.rows);
  const pending = state.rows.filter((r) => r.flags.length > 0).length;
  const ok = state.rows.length - pending;
  const stats = $('#statsBar').children;
  if (stats.length >= 7) {
    stats[5].querySelector('b').textContent = ok;
    stats[6].querySelector('b').textContent = pending;
  }
}

function renderDropped() {
  const box = $('#droppedBox');
  const list = $('#droppedList');
  list.innerHTML = '';
  if (!state.droppedOld.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  for (const d of state.droppedOld) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nums">#${d.index} [${formatMs(d.start)} → ${formatMs(d.end)}]</span> <span class="t"></span>`;
    li.querySelector('.t').textContent = d.text;
    list.appendChild(li);
  }
}

function rowMatchesFilter(row) {
  if (!state.pendingOnly) return true;
  return row.flags.length > 0;
}

function renderRows() {
  computeFlags(state.rows);
  const tbody = $('#rowsBody');
  tbody.innerHTML = '';
  state.rows.forEach((row, idx) => {
    if (!rowMatchesFilter(row)) return;
    tbody.appendChild(buildRow(row, idx));
  });
  refreshStatsPending();
}

function buildRow(row, idx) {
  const tr = document.createElement('tr');
  tr.dataset.id = row.id;
  if (row.flags.length) tr.classList.add('pending');
  if (row.ack) tr.classList.add('acked');

  // #
  const tdNo = document.createElement('td');
  tdNo.textContent = idx + 1;
  tr.appendChild(tdNo);

  // 修订台词（可编辑）
  const tdText = document.createElement('td');
  const ta = document.createElement('textarea');
  ta.className = 'line-text';
  ta.rows = Math.min(3, Math.max(1, row.text.split('\n').length));
  ta.value = row.text;
  ta.spellcheck = false;
  ta.addEventListener('input', () => { row.text = ta.value; });
  tdText.appendChild(ta);
  tr.appendChild(tdText);

  // 对应旧字幕
  const tdOld = document.createElement('td');
  const oldDiv = document.createElement('div');
  oldDiv.className = 'oldref';
  if (row.oldRefs.length) {
    const nums = row.oldRefs.map((o) => `#${o.index}`).join(' + ');
    const preview = row.oldRefs.map((o) => o.text.replace(/\n/g, ' / ')).join(' ⏎ ');
    oldDiv.innerHTML = `<span class="nums"></span><br><span class="txt"></span>`;
    oldDiv.querySelector('.nums').textContent = nums;
    oldDiv.querySelector('.txt').textContent = preview.length > 60 ? preview.slice(0, 60) + '…' : preview;
  } else {
    oldDiv.classList.add('none');
    oldDiv.textContent = '无对应旧字幕';
  }
  tdOld.appendChild(oldDiv);
  tr.appendChild(tdOld);

  // 相似度
  const tdSim = document.createElement('td');
  const simSpan = document.createElement('span');
  simSpan.className = 'sim' + (row.sim != null && row.sim < 0.45 ? ' low' : '');
  simSpan.textContent = row.sim == null ? '—' : row.sim.toFixed(2);
  tdSim.appendChild(simSpan);
  tr.appendChild(tdSim);

  // 时码
  for (const field of ['start', 'end']) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.className = 'time-input';
    input.value = formatMs(row[field]);
    input.dataset.field = field;
    input.addEventListener('change', () => {
      const v = parseTimecode(input.value);
      if (v == null) {
        input.classList.add('invalid');
        return;
      }
      input.classList.remove('invalid');
      row[field] = v;
      input.value = formatMs(v);
      renderRows();
    });
    td.appendChild(input);
    tr.appendChild(td);
  }

  // 标记
  const tdFlags = document.createElement('td');
  for (const f of row.flags) {
    const b = document.createElement('span');
    b.className = `badge ${f}`;
    b.textContent = FLAG_LABELS[f] || f;
    tdFlags.appendChild(b);
  }
  tr.appendChild(tdFlags);

  // 操作
  const tdOps = document.createElement('td');
  const mkBtn = (label, title, fn, disabled) => {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = label;
    b.title = title;
    b.disabled = !!disabled;
    b.addEventListener('click', fn);
    tdOps.appendChild(b);
    return b;
  };
  mkBtn('拆分', '把本行拆成两条，按文字长度分配时段', () => openSplitEditor(tr, row));
  mkBtn('合并', '与下一行合并为一条，沿用覆盖时段', () => mergeWithNext(row), idx >= state.rows.length - 1);
  if (row.baseFlags.length) {
    mkBtn('确认', '确认本行配对无误，清除待处理标记', () => {
      row.baseFlags = [];
      row.ack = true;
      renderRows();
    });
  }
  mkBtn('删除', '从导出结果中移除本行', () => {
    state.rows = state.rows.filter((r) => r.id !== row.id);
    renderRows();
  });
  tr.appendChild(tdOps);

  return tr;
}

/* ---------- 配对修改：拆分 / 合并 ---------- */

let splitEditorTr = null;

function closeSplitEditor() {
  if (splitEditorTr) {
    splitEditorTr.remove();
    splitEditorTr = null;
  }
}

function openSplitEditor(anchorTr, row) {
  closeSplitEditor();
  const text = row.text.replace(/\n/g, '');
  if (text.length < 2) return;
  const tr = document.createElement('tr');
  tr.className = 'split-editor';
  const td = document.createElement('td');
  td.colSpan = 8;

  const label = document.createElement('div');
  label.innerHTML = '在第 <input type="number"> 个字符后拆分（共 ' + text.length + ' 字）';
  const numInput = label.querySelector('input');
  numInput.type = 'number';
  numInput.min = 1;
  numInput.max = text.length - 1;
  numInput.value = Math.max(1, Math.round(text.length / 2));

  const preview = document.createElement('div');
  preview.className = 'split-preview';
  const updatePreview = () => {
    const p = Math.min(text.length - 1, Math.max(1, Number(numInput.value) || 1));
    preview.innerHTML = '';
    const a = document.createElement('span');
    a.textContent = text.slice(0, p);
    const cut = document.createElement('span');
    cut.className = 'cut';
    cut.textContent = ' ✂ ';
    const b = document.createElement('span');
    b.textContent = text.slice(p);
    preview.append(a, cut, b);
  };
  numInput.addEventListener('input', updatePreview);
  updatePreview();

  const okBtn = document.createElement('button');
  okBtn.className = 'small primary';
  okBtn.textContent = '确定拆分';
  okBtn.addEventListener('click', () => {
    const p = Math.min(text.length - 1, Math.max(1, Number(numInput.value) || 1));
    doSplit(row, p);
    closeSplitEditor();
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'small';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeSplitEditor);

  td.append(label, preview, okBtn, cancelBtn);
  tr.appendChild(td);
  anchorTr.after(tr);
  splitEditorTr = tr;
}

function doSplit(row, pos) {
  const text = row.text.replace(/\n/g, '');
  const t1 = text.slice(0, pos);
  const t2 = text.slice(pos);
  const [[s1, e1], [s2, e2]] = splitRangeByLength(row.start, row.end, t1, t2);
  const idx = state.rows.findIndex((r) => r.id === row.id);
  const mk = (t, s, e) => ({
    id: state.nextId++,
    text: t,
    start: s,
    end: e,
    sim: row.sim,
    oldRefs: row.oldRefs,
    baseFlags: [...row.baseFlags],
    ack: row.ack,
  });
  state.rows.splice(idx, 1, mk(t1, s1, e1), mk(t2, s2, e2));
  renderRows();
}

function mergeWithNext(row) {
  const idx = state.rows.findIndex((r) => r.id === row.id);
  if (idx < 0 || idx >= state.rows.length - 1) return;
  const next = state.rows[idx + 1];
  const seen = new Set();
  const oldRefs = [...row.oldRefs, ...next.oldRefs].filter((o) => {
    if (seen.has(o.index)) return false;
    seen.add(o.index);
    return true;
  });
  const merged = {
    id: state.nextId++,
    text: row.text + '\n' + next.text,
    start: Math.min(row.start, next.start),
    end: Math.max(row.end, next.end),
    sim: Math.min(row.sim ?? 1, next.sim ?? 1),
    oldRefs,
    baseFlags: [...new Set([...row.baseFlags, ...next.baseFlags])],
    ack: row.ack && next.ack,
  };
  state.rows.splice(idx, 2, merged);
  renderRows();
}

/* ---------- 导出 / 预览 / 下载 ---------- */

$('#pendingOnly').addEventListener('change', (e) => {
  state.pendingOnly = e.target.checked;
  renderRows();
});

$('#exportBtn').addEventListener('click', async () => {
  const msg = $('#exportMsg');
  msg.className = 'msg';
  computeFlags(state.rows);
  const pendingRows = state.rows
    .map((r, i) => ({ r, i: i + 1 }))
    .filter(({ r }) => r.flags.length > 0);
  if (pendingRows.length) {
    const list = pendingRows.slice(0, 8).map(({ i }) => `#${i}`).join('、');
    if (!window.confirm(`仍有 ${pendingRows.length} 行待处理（${list}${pendingRows.length > 8 ? '…' : ''}），确定继续导出？`)) {
      return;
    }
  }
  msg.textContent = '生成中…';
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: state.rows.map((r) => ({ start: r.start, end: r.end, text: r.text })),
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '导出失败');
    }
    state.lastSrt = await res.text();
    $('#previewBox').textContent = state.lastSrt;
    const warnBox = $('#previewWarn');
    if (pendingRows.length) {
      warnBox.classList.remove('hidden');
      warnBox.textContent = `注意：导出内容包含 ${pendingRows.length} 行曾标记为待处理的字幕，请确认已人工复核。`;
    } else {
      warnBox.classList.add('hidden');
    }
    $('#step-preview').classList.remove('hidden');
    msg.className = 'msg ok';
    msg.textContent = '预览已生成';
    $('#step-preview').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#downloadBtn').addEventListener('click', () => {
  if (!state.lastSrt) return;
  const blob = new Blob([state.lastSrt], { type: 'application/x-subrip;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'revised.srt';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#backBtn').addEventListener('click', () => {
  $('#step-preview').classList.add('hidden');
  $('#step-review').scrollIntoView({ behavior: 'smooth' });
});
