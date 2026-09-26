'use strict';

const path = require('path');
const express = require('express');
const {
  parseSrt,
  parseLines,
  align,
  refine,
  generateSrt,
  parseTimecode,
} = require('./lib/subtitle');

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function error(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

// 解析旧 SRT（multipart 不引入依赖，前端以文本提交）
function readOld(body) {
  if (!body || typeof body.oldSrt !== 'string' || !body.oldSrt.trim()) {
    throw error('缺少旧版 SRT 内容（oldSrt）');
  }
  const cues = parseSrt(body.oldSrt);
  if (!cues.length) throw error('旧版 SRT 未能解析出任何有效字幕行');
  return cues;
}

function readNew(body) {
  if (!body || typeof body.newText !== 'string' || !body.newText.trim()) {
    throw error('缺少逐行修订台词（newText）');
  }
  const lines = parseLines(body.newText);
  if (!lines.length) throw error('修订台词未能解析出任何有效行');
  return lines;
}

// POST /api/align { oldSrt, newText }
app.post('/api/align', (req, res, next) => {
  try {
    const oldCues = readOld(req.body);
    const newCues = readNew(req.body);
    const result = align(oldCues, newCues);
    res.json({
      oldCues: result.oldCues.map((c, i) => ({ index: i, ...c })),
      rows: result.rows,
      refRows: result.refRows,
    });
  } catch (e) {
    next(e);
  }
});

function normalizePayloadRows(rawRows, oldCues) {
  if (!Array.isArray(rawRows)) throw error('rows 必须是数组');
  return rawRows.map((r, i) => {
    if (!r || typeof r !== 'object') throw error(`第 ${i + 1} 行格式无效`);
    const ids = Array.isArray(r.oldIds)
      ? r.oldIds
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x >= 0 && x < oldCues.length)
      : [];
    const start = toNumberOrNull(r.start);
    const end = toNumberOrNull(r.end);
    return {
      key: r.key != null ? String(r.key) : `r${i}`,
      oldIds: [...new Set(ids)],
      text: String(r.text == null ? '' : r.text),
      start,
      end,
    };
  });
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const t = parseTimecode(v.includes('-->') ? v : `00:00:00,000 --> ${v.trim()}`);
    return t ? t.end : null;
  }
  return null;
}

// POST /api/refine { oldSrt, rows, recomputeAll }
app.post('/api/refine', (req, res, next) => {
  try {
    const oldCues = readOld(req.body);
    const rows = normalizePayloadRows(req.body.rows, oldCues);
    const result = refine(oldCues, rows, {
      recomputeAll: !!req.body.recomputeAll,
    });
    res.json({
      oldCues: result.oldCues.map((c, i) => ({ index: i, ...c })),
      rows: result.rows,
      refRows: result.refRows,
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/export { rows } -> SRT 文本
app.post('/api/export', (req, res, next) => {
  try {
    if (!req.body || !Array.isArray(req.body.rows)) throw error('缺少 rows');
    const rows = req.body.rows
      .filter((r) => r && r.included !== false && String(r.text || '').trim())
      .map((r, i) => ({
        key: r.key || `r${i}`,
        text: String(r.text),
        start: toNumberOrNull(r.start) || 0,
        end: toNumberOrNull(r.end) || 0,
        included: true,
      }));
    const srt = generateSrt(rows);
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.send(srt);
  } catch (e) {
    next(e);
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`字幕校订工具已启动: http://localhost:${PORT}`);
});
