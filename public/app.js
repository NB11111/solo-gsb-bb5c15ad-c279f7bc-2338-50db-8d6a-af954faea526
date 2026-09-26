'use strict';

// 状态 ----------------------------------------------------------------------

const state = {
  oldCues: [], // [{index,start,end,text}]
  rows: [],    // [{key, oldIds:[0基], text, start, end, type, score, reasons}]
  refRows: [],
  keySeq: 0,
};

const $ = (id) => document.getElementById(id);
const oldTa = $('oldSrt');
const newTa = $('newText');

// 工具 ----------------------------------------------------------------------

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function msToTc(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(x, 3)}`;
}

function tcToMs(str) {
  const m = /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$/.exec(str || '');
  if (!m) return null;
  return (
    Number(m[1]) * 3600000 +
    Number(m[2]) * 60000 +
    Number(m[3]) * 1000 +
    Number(m[4].padEnd(3, '0'))
  );
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function readFileToTextarea(input, ta, meta) {
  const f = input.files && input.files[0];
  if (!f) return;
  const text = await f.text();
  ta.value = text;
  meta.textContent = `${f.name} · ${f.size} 字节`;
}

$('oldFile').addEventListener('change', (e) => readFileToTextarea(e.target, oldTa, $('oldMeta')));
$('newFile').addEventListener('change', (e) => readFileToTextarea(e.target, newTa, $('newMeta')));

function setStatus(msg, kind = '') {
  const el = $('statusMsg');
  el.textContent = msg || '';
  el.className = 'status-msg' + (kind ? ' ' + kind : '');
}

const REASON_LABELS = {
  low_confidence: { text: '相似度低，待确认', hard: false },
  unmatched_new: { text: '新增行（无旧配对）', hard: false },
  unmatched_old: { text: '旧行未被使用', hard: false },
  duplicate_old: { text: '旧序号被多组使用', hard: true },
  out_of_order: { text: '时码倒序', hard: true },
  overlap: { text: '时码重叠', hard: true },
  invalid_time: { text: '时码无效', hard: true },
};
const TIMING_REASONS = new Set(['out_of_order', 'overlap', 'invalid_time']);

const TYPE_LABELS = {
  match: ['一对一', 't-match'],
  split: ['一条拆两条', 't-split'],
  merge: ['两条并一条', 't-merge'],
  insert: ['新增台词', 't-insert'],
  skipOld: ['旧行未用', 't-insert'],
};

// 本地实时时码检查：服务端原因中的时序类由本地编辑结果取代 ----------------------

function liveTimingReasons() {
  const result = state.rows.map(() => new Set());
  state.rows.forEach((r, i) => {
    if (r.start === null || r.end === null || r.end < r.start) result[i].add('invalid_time');
  });
  const order = state.rows
    .map((r, i) => ({ i, start: r.start, end: r.end }))
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end >= x.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let k = 1; k < order.length; k++) {
    const a = order[k - 1];
    const b = order[k];
    if (b.start < a.start) result[b.i].add('out_of_order');
    if (b.start < a.end && b.end > a.start) {
      result[a.i].add('overlap');
      result[b.i].add('overlap');
    }
  }
  return result;
}

function effectiveReasons(row, i, timing) {
  const base = (row.reasons || []).filter((r) => !TIMING_REASONS.has(r));
  return [...new Set([...base, ...timing[i]])];
}

// 渲染 ----------------------------------------------------------------------

function sourceTextFor(ids) {
  return ids
    .map((id) => {
      const c = state.oldCues[id];
      return c ? `#${id + 1} ${c.text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function render() {
  const body = $('rowBody');
  const timing = liveTimingReasons();
  let pending = 0;

  const html = state.rows.map((r, i) => {
    const reasons = effectiveReasons(r, i, timing);
    if (reasons.length) pending++;
    const isPending = reasons.length > 0;
    const [typeLabel, typeCls] = TYPE_LABELS[r.type] || [r.type, 't-match'];
    const ids1based = r.oldIds.map((x) => x + 1).join(', ');
    const src = esc(sourceTextFor(r.oldIds));
    const startBad = timing[i].has('invalid_time') ? ' bad' : '';

    const reasonHtml = reasons
      .map((rs) => {
        const info = REASON_LABELS[rs] || { text: rs, hard: false };
        return `<span class="reason${info.hard ? ' hard' : ''}">${esc(info.text)}</span>`;
      })
      .join('');

    return `
    <tr class="${isPending ? 'row-pending' : ''}" data-index="${i}">
      <td class="c-status">
        <span class="tag ${isPending ? 'pending' : 'ok'}" title="${reasons.length ? esc(reasons.join('；')) : '对齐正常'}">
          ${isPending ? '!' : '✓'}
        </span>
      </td>
      <td><span class="cell-type ${typeCls}">${esc(typeLabel)}</span></td>
      <td>
        <input class="cell-input mono" data-field="oldIds" value="${esc(ids1based)}"
          title="填修订行对应的旧字幕序号（从 1 开始），多个序号=合并（如 12,13）；相邻两行填同一序号=拆分；留空=新增" />
      </td>
      <td class="cell-src">${src || '<span class="muted">—</span>'}</td>
      <td>
        <textarea class="cell-input cell-text" data-field="text" rows="${Math.max(1, String(r.text).split('\n').length)}">${esc(r.text)}</textarea>
      </td>
      <td>
        <input class="cell-input mono${startBad}" data-field="start" value="${esc(msToTc(r.start))}" />
      </td>
      <td>
        <input class="cell-input mono${startBad}" data-field="end" value="${esc(msToTc(r.end))}" />
      </td>
      <td><button class="danger-text" data-action="del" title="删除该行">×</button></td>
    </tr>
    <tr class="reason-row" data-reason-for="${i}"><td></td><td colspan="7"><div class="reasons">${reasonHtml}</div></td></tr>`;
  }).join('');

  body.innerHTML = html || '<tr><td colspan="8" class="muted" style="padding:16px">无数据</td></tr>';

  $('pendingCount').textContent =
    state.rows.length ? `共 ${state.rows.length} 行，${pending} 行待处理` : '';

  // 未匹配旧行
  const refBody = $('refBody');
  refBody.innerHTML = state.refRows
    .map(
      (r) => `
    <tr>
      <td>${r.oldIds[0] + 1}</td>
      <td class="mono" style="font-family:var(--mono);font-size:12px;white-space:nowrap">
        ${esc(msToTc(r.start))} → ${esc(msToTc(r.end))}
      </td>
      <td class="cell-src">${esc(r.text)}</td>
    </tr>`
    )
    .join('') || '<tr><td colspan="3" class="muted" style="padding:10px">没有未匹配的旧字幕</td></tr>';
}

// 行内编辑 ------------------------------------------------------------------

$('rowBody').addEventListener('input', (e) => {
  const input = e.target.closest('[data-field]');
  if (!input) return;
  const tr = input.closest('tr[data-index]');
  if (!tr) return;
  const i = Number(tr.dataset.index);
  const row = state.rows[i];
  const field = input.dataset.field;

  if (field === 'text') {
    row.text = input.value;
    return; // 文字修改不触发实时重算
  }
  if (field === 'start' || field === 'end') {
    const ms = tcToMs(input.value);
    if (ms === null) {
      input.classList.add('bad');
    } else {
      input.classList.remove('bad');
      row[field] = ms;
    }
    render();
    refocus(i, field);
    return;
  }
  if (field === 'oldIds') {
    // 仅暂存解析结果，分组/时间重算在「应用配对修改」时统一请求后端
    const tokens = input.value.split(/[,，\s]+/).filter(Boolean);
    const ids = [];
    let bad = false;
    for (const t of tokens) {
      const n = Number(t);
      if (Number.isInteger(n) && n >= 1 && n <= state.oldCues.length) ids.push(n - 1);
      else bad = true;
    }
    input.classList.toggle('bad', bad);
    row.oldIds = [...new Set(ids)].sort((a, b) => a - b);
  }
});

function refocus(i, field) {
  const tr = document.querySelector(`tr[data-index="${i}"]`);
  if (!tr) return;
  const input = tr.querySelector(`[data-field="${field}"]`);
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

$('rowBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="del"]');
  if (!btn) return;
  const tr = btn.closest('tr[data-index]');
  const i = Number(tr.dataset.index);
  state.rows.splice(i, 1);
  await callRefine(false, '已删除一行');
});

// API -----------------------------------------------------------------------

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function payloadRows() {
  return state.rows.map((r, i) => ({
    key: r.key || `auto-${state.keySeq++}`,
    oldIds: r.oldIds,
    text: r.text,
    start: r.start,
    end: r.end,
  }));
}

function ingestResult(data) {
  state.oldCues = data.oldCues || state.oldCues;
  state.rows = (data.rows || []).map((r) => ({
    key: r.key,
    oldIds: r.oldIds || [],
    text: r.text,
    start: r.start,
    end: r.end,
    type: r.type,
    score: r.score,
    reasons: r.reasons || [],
  }));
  state.refRows = data.refRows || [];
}

$('alignBtn').addEventListener('click', async () => {
  try {
    setStatus('正在对齐…');
    const data = await postJSON('/api/align', {
      oldSrt: oldTa.value,
      newText: newTa.value,
    });
    ingestResult(data);
    $('resultCard').classList.remove('hidden');
    render();
    setStatus(`对齐完成：旧 ${data.oldCues.length} 条 / 修订 ${data.rows.length} 行`, 'ok');
    $('resultCard').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

async function callRefine(recomputeAll, okMsg) {
  try {
    setStatus(recomputeAll ? '正在重排时码…' : '正在应用配对修改…');
    const data = await postJSON('/api/refine', {
      oldSrt: oldTa.value,
      rows: payloadRows(),
      recomputeAll: !!recomputeAll,
    });
    ingestResult(data);
    render();
    setStatus(okMsg || '已更新', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
    render();
  }
}

$('applyPairBtn').addEventListener('click', () => callRefine(false, '配对修改已应用（拆分/合并时间已按规则重新分配）'));
$('recomputeBtn').addEventListener('click', () => callRefine(true, '已按当前配对重排全部时码'));

$('addRowBtn').addEventListener('click', async () => {
  state.rows.push({
    key: `new-${Date.now()}-${state.keySeq++}`,
    oldIds: [],
    text: '',
    start: null,
    end: null,
    type: 'insert',
    score: null,
    reasons: ['unmatched_new'],
  });
  await callRefine(false, '已新增一行');
});

// 预览与下载 ---------------------------------------------------------------

$('previewBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: payloadRows() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '导出失败');
    }
    const srt = await res.text();
    $('previewText').textContent = srt;
    const cues = srt.trim() ? srt.trim().split(/\n\s*\n/).length : 0;
    const timing = liveTimingReasons();
    const pendingNow = state.rows.filter((r, i) => effectiveReasons(r, i, timing).length).length;
    $('previewHint').textContent =
      `共 ${cues} 条成片字幕${pendingNow ? `；仍有 ${pendingNow} 行标记待处理，导出内容以当前编辑为准` : '，无待处理行'}`;
    $('previewMask').classList.remove('hidden');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

$('closePreviewBtn').addEventListener('click', () => $('previewMask').classList.add('hidden'));
$('previewMask').addEventListener('click', (e) => {
  if (e.target === $('previewMask')) $('previewMask').classList.add('hidden');
});

$('downloadBtn').addEventListener('click', () => {
  const content = $('previewText').textContent;
  const blob = new Blob(['﻿' + content], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'revised.srt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
