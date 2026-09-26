'use strict';

// ---------------------------------------------------------------------------
// 字幕文本对齐核心库：SRT 解析、时码工具、相似度、DP 全局对齐、校订重算、SRT 生成
// ---------------------------------------------------------------------------

const MIN_CONFIDENCE = 0.45; // 低于该相似度视为「对齐不确定」
const INSERT_SLOT_MS = 1500; // 无锚点时新增行的默认时长

// 时码 ----------------------------------------------------------------------

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function msToSrt(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  ms = Math.round(ms);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(x, 3)}`;
}

const TIMECODE_RE =
  /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$/;

function tcToMs(h, m, s, x) {
  return (
    Number(h) * 3600000 +
    Number(m) * 60000 +
    Number(s) * 1000 +
    Number(String(x).padEnd(3, '0'))
  );
}

function parseTimecode(str) {
  const mt = TIMECODE_RE.exec(str || '');
  if (!mt) return null;
  return {
    start: tcToMs(mt[1], mt[2], mt[3], mt[4]),
    end: tcToMs(mt[5], mt[6], mt[7], mt[8]),
  };
}

// SRT 解析 ------------------------------------------------------------------

/**
 * 解析 SRT。容错策略：按空行切块，块内查找时码行；时码之前的数字行视为序号，
 * 其余文本行合并为台词。块内无空行也可以（连续行扫描兜底）。
 */
function parseSrt(text) {
  const norm = String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');
  const cues = [];
  const blocks = norm.split(/\n[ \t]*\n/);
  for (let rawBlock of blocks) {
    const lines = rawBlock.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let tcIndex = lines.findIndex((l) => TIMECODE_RE.test(l));
    if (tcIndex === -1) continue;
    const tc = parseTimecode(lines[tcIndex]);
    const textLines = lines
      .slice(tcIndex + 1)
      .map((l) => l.trim())
      .filter(Boolean);
    const content = textLines.join('\n');
    if (content === '' && tcIndex > 0 && /^\d+$/.test(lines[0].trim()) === false) {
      // 时码前的非数字文本也当作台词（部分非标准 SRT）
    }
    if (!content) continue;
    cues.push({ start: tc.start, end: tc.end, text: content });
  }
  return cues;
}

/**
 * 逐行修订台词：纯文本一行一条；若粘贴的是 SRT，则复用 SRT 解析结果。
 */
function parseLines(text) {
  const norm = String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');
  if (norm.includes('-->')) {
    const cues = parseSrt(norm);
    if (cues.length) return cues.map((c) => ({ text: c.text }));
  }
  return norm
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
}

// 相似度 --------------------------------------------------------------------

function normalize(text) {
  return String(text || '')
    .replace(/[ \t　]+/g, ' ')
    .replace(/[\s　]+/g, '') // 对齐时忽略所有空白（含换行）
    .toLowerCase()
    .replace(/[，。！？、；：「」『』“”‘’（）《》〈〉…—·,.!?;:"'()\[\]\-–_]/g, '');
}

/**
 * 评分器：一次对齐/校订共享一个局部词表，把每个字符串编码成
 *   chars : 单字 id 的有序多重集合（Int32Array）
 *   bgs   : bigram id 的有序多重集合（Int32Array）
 * 相似度只需排序数组的线性归并，不再产生 Map 分配。
 */
class Scorer {
  constructor() {
    this.vocab = new Map();
    this.nextId = 1;
  }

  intern(prefix, token) {
    const key = prefix + token;
    let id = this.vocab.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.vocab.set(key, id);
    }
    return id;
  }

  encode(text) {
    const s = normalize(text);
    const n = s.length;
    const chars = new Int32Array(n);
    const bgCount = n >= 2 ? n - 1 : n === 1 ? 1 : 0;
    const bgs = new Int32Array(bgCount);
    for (let i = 0; i < n; i++) {
      chars[i] = this.intern('c', s[i]);
    }
    if (n === 1) {
      bgs[0] = this.intern('b', s);
    } else {
      for (let i = 0; i < n - 1; i++) {
        bgs[i] = this.intern('b', s.slice(i, i + 2));
      }
    }
    chars.sort();
    bgs.sort();
    return { s, len: n, chars, bgs };
  }

  /** 相邻两个编码串拼接（归一化已去除空白，故与 encode(a+b) 等价） */
  concat(a, b) {
    const chars = new Int32Array(a.chars.length + b.chars.length);
    chars.set(a.chars, 0);
    chars.set(b.chars, a.chars.length);
    // 跨界 bigram
    const crossLen = a.len > 0 && b.len > 0 ? 1 : 0;
    const bgs = new Int32Array(a.bgs.length + b.bgs.length + crossLen);
    bgs.set(a.bgs, 0);
    bgs.set(b.bgs, a.bgs.length);
    if (crossLen) {
      bgs[a.bgs.length + b.bgs.length] = this.intern('b', a.s.slice(-1) + b.s.slice(0, 1));
    }
    chars.sort();
    bgs.sort();
    return {
      s: a.s + b.s,
      len: a.len + b.len,
      chars,
      bgs,
    };
  }

  /** 有序多重集合交集计数（重复出现取 min） */
  static interMin(a, b) {
    let i = 0;
    let j = 0;
    let n = 0;
    const la = a.length;
    const lb = b.length;
    while (i < la && j < lb) {
      const x = a[i];
      const y = b[j];
      if (x < y) i++;
      else if (y < x) j++;
      else {
        n++;
        i++;
        j++;
      }
    }
    return n;
  }

  static interUnion(a, b) {
    let i = 0;
    let j = 0;
    let shared = 0;
    let union = 0;
    const la = a.length;
    const lb = b.length;
    while (i < la || j < lb) {
      const x = i < la ? a[i] : Infinity;
      const y = j < lb ? b[j] : Infinity;
      if (x < y) {
        union++;
        i++;
      } else if (y < x) {
        union++;
        j++;
      } else {
        shared++;
        union++;
        i++;
        j++;
      }
    }
    return { shared, union };
  }

  /** bigram Sørensen–Dice 与单字多重集合 Jaccard 的平均 */
  score(a, b) {
    if (!a.len || !b.len) return 0;
    if (a.s === b.s) return 1;
    const lo = a.len < b.len ? a.len : b.len;
    const hi = a.len > b.len ? a.len : b.len;
    // 长度相差悬殊（>3 倍）直接给低分，纪录片台词修订不会有这种跨度
    if (hi > lo * 3 + 2) return 0;

    const inter = Scorer.interMin(a.bgs, b.bgs);
    const dice = a.len >= 2 && b.len >= 2
      ? (2 * inter) / (a.len - 1 + b.len - 1)
      : 0;

    const { shared, union } = Scorer.interUnion(a.chars, b.chars);
    const jaccard = union ? shared / union : 0;
    return (dice + jaccard) / 2;
  }
}

/** 少量调用（API 外部入口、refine 评分）时的便捷封装 */
function similarity(a, b) {
  const sc = new Scorer();
  return sc.score(sc.encode(a), sc.encode(b));
}

// 时长分配工具 --------------------------------------------------------------

function lengthOf(text) {
  return Math.max(1, normalize(text).length || 1);
}

/**
 * 在 [start, end] 内按文字长度比例切分 dur 段，保证单调、非负、整数毫秒。
 */
function splitSpan(start, end, texts) {
  const n = texts.length;
  if (n === 1) return [[start, end]];
  const span = Math.max(0, end - start);
  const weights = texts.map(lengthOf);
  const total = weights.reduce((a, b) => a + b, 0);
  const bounds = [start];
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    acc += weights[i];
    let b = start + Math.round((span * acc) / total);
    const prev = bounds[bounds.length - 1];
    if (b < prev) b = prev;
    if (b > end) b = end;
    bounds.push(b);
  }
  bounds.push(end);
  const out = [];
  for (let i = 0; i < n; i++) out.push([bounds[i], bounds[i + 1]]);
  return out;
}

// DP 全局对齐 ---------------------------------------------------------------
//
// 状态 dp[i][j]：旧 cue 用掉前 i 条、修订行用掉前 j 行时的最大累计得分。
// 允许的步长：
//   match : (1,1)  一条对一条
//   split : (1,2)  一条旧 cue 拆成两条修订行
//   merge : (2,1)  两条旧 cue 并成一条修订行
//   skipOld: (1,0) 旧有新无（删除/未修订）
//   skipNew: (0,1) 新有旧无（新增台词）

const MATCH_BONUS = 0.02; // 平局时略微优先一对一

function alignCues(oldCues, newLines, scorer) {
  const sc = scorer || new Scorer();
  const I = oldCues.length;
  const J = newLines.length;

  // 预计算编码
  const oldSt = oldCues.map((c) => sc.encode(c.text));
  const newSt = newLines.map((c) => sc.encode(c.text));

  // 相似度矩阵：
  //   m11[i][j]     旧i ↔ 新j
  //   oldCat[i][j]  旧i ↔ (新j + 新j+1)
  //   newCat[i][j]  (旧i + 旧i+1) ↔ 新j
  // 相邻拼接编码（预计算一次，避免矩阵热循环里重复排序）
  const newPair = new Array(Math.max(0, J - 1));
  for (let j = 0; j < J - 1; j++) newPair[j] = sc.concat(newSt[j], newSt[j + 1]);
  const oldPair = new Array(Math.max(0, I - 1));
  for (let i = 0; i < I - 1; i++) oldPair[i] = sc.concat(oldSt[i], oldSt[i + 1]);

  const m11 = new Array(I);
  for (let i = 0; i < I; i++) {
    const row = new Float64Array(J);
    for (let j = 0; j < J; j++) row[j] = sc.score(oldSt[i], newSt[j]);
    m11[i] = row;
  }
  const oldCat = new Array(I);
  for (let i = 0; i < I; i++) {
    const row = new Float64Array(Math.max(0, J - 1));
    for (let j = 0; j < J - 1; j++) {
      row[j] = sc.score(oldSt[i], newPair[j]);
    }
    oldCat[i] = row;
  }
  const newCat = new Array(Math.max(0, I - 1));
  for (let i = 0; i < I - 1; i++) {
    const row = new Float64Array(J);
    const cat = oldPair[i];
    for (let j = 0; j < J; j++) row[j] = sc.score(cat, newSt[j]);
    newCat[i] = row;
  }

  const score11 = (i, j) => m11[i][j] + MATCH_BONUS;
  const score12 = (i, j) => (oldCat[i][j] + m11[i][j] + m11[i][j + 1]) / 3;
  const score21 = (i, j) => (newCat[i][j] + m11[i][j] + m11[i + 1][j]) / 3;

  const NEG = -1e9;
  const dp = Array.from({ length: I + 1 }, () => new Float64Array(J + 1).fill(NEG));
  // op: 1=match 2=split 3=merge 4=skipOld 5=skipNew
  const op = new Uint8Array((I + 1) * (J + 1));
  dp[0][0] = 0;

  const at = (v) => (v <= NEG / 2 ? NEG : v);

  for (let i = 0; i <= I; i++) {
    for (let j = 0; j <= J; j++) {
      if (i === 0 && j === 0) continue;
      let best = NEG;
      let bestOp = 0;
      const consider = (v, o) => {
        if (v > best) {
          best = v;
          bestOp = o;
        }
      };
      if (i >= 1 && j >= 1) consider(at(dp[i - 1][j - 1]) + score11(i - 1, j - 1), 1);
      if (i >= 1 && j >= 2) consider(at(dp[i - 1][j - 2]) + score12(i - 1, j - 2), 2);
      if (i >= 2 && j >= 1) consider(at(dp[i - 2][j - 1]) + score21(i - 2, j - 1), 3);
      if (i >= 1) consider(at(dp[i - 1][j]), 4);
      if (j >= 1) consider(at(dp[i][j - 1]), 5);
      dp[i][j] = best;
      op[i * (J + 1) + j] = bestOp;
    }
  }

  // 回溯（逆序）
  const steps = [];
  let i = I;
  let j = J;
  while (i > 0 || j > 0) {
    const o = op[i * (J + 1) + j];
    if (o === 1) {
      steps.push({ type: 'match', old: [i - 1], neu: [j - 1], score: score11(i - 1, j - 1) });
      i -= 1;
      j -= 1;
    } else if (o === 2) {
      steps.push({ type: 'split', old: [i - 1], neu: [j - 2, j - 1], score: score12(i - 1, j - 2) });
      i -= 1;
      j -= 2;
    } else if (o === 3) {
      steps.push({ type: 'merge', old: [i - 2, i - 1], neu: [j - 1], score: score21(i - 2, j - 1) });
      i -= 2;
      j -= 1;
    } else if (o === 4) {
      steps.push({ type: 'skipOld', old: [i - 1], neu: [], score: 0 });
      i -= 1;
    } else if (o === 5) {
      steps.push({ type: 'skipNew', old: [], neu: [j - 1], score: 0 });
      j -= 1;
    } else {
      // 理论不可达，兜底：丢弃剩余修订行
      steps.push({ type: 'skipNew', old: [], neu: [j - 1], score: 0 });
      j -= 1;
    }
  }
  steps.reverse();
  return steps;
}

// 分组与时间分配 ------------------------------------------------------------

/**
 * 把对齐步序列整理为「组」：
 *   match  → 一组单行
 *   split  → 一组多行（共享同一旧 cue 时段，按字数切分）
 *   merge  → 一组单行（沿用覆盖时段：第一条开始 ~ 最后一条结束）
 *   skipOld→ 每组一条，仅参考，不进最终 SRT
 *   skipNew→ 连续的新增行合并为一组，在前后锚点之间按时长比例插值
 */
function buildGroups(steps) {
  const groups = [];
  for (let k = 0; k < steps.length; k++) {
    const st = steps[k];
    if (st.type === 'skipNew') {
      const neu = [];
      while (k < steps.length && steps[k].type === 'skipNew') {
        neu.push(steps[k].neu[0]);
        k++;
      }
      k--;
      groups.push({ type: 'insert', old: [], neu, score: 0 });
      continue;
    }
    groups.push({
      type: st.type,
      old: st.old.slice(),
      neu: st.neu.slice(),
      score: st.score,
    });
  }
  return groups;
}

/** 为 insert 组在 prev/next 锚点之间分配时间 */
function assignInsertGroup(group, prevAnchor, nextAnchor) {
  const texts = group.neu;
  const n = texts.length;
  if (prevAnchor && nextAnchor) {
    const gapStart = prevAnchor.end;
    const gapEnd = nextAnchor.start;
    if (gapEnd > gapStart) {
      return splitSpan(gapStart, gapEnd, texts);
    }
    // 间隙不足：从 prevAnchor.end 起顺序排放，稍后重叠扫描会标红
    const out = [];
    let t = gapStart;
    for (let k = 0; k < n; k++) {
      out.push([t, t + INSERT_SLOT_MS]);
      t += INSERT_SLOT_MS;
    }
    return out;
  }
  if (prevAnchor && !nextAnchor) {
    const out = [];
    let t = prevAnchor.end;
    for (let k = 0; k < n; k++) {
      out.push([t, t + INSERT_SLOT_MS]);
      t += INSERT_SLOT_MS;
    }
    return out;
  }
  if (!prevAnchor && nextAnchor) {
    let t = Math.max(0, nextAnchor.start - n * INSERT_SLOT_MS);
    const out = [];
    for (let k = 0; k < n; k++) {
      out.push([t, t + INSERT_SLOT_MS]);
      t += INSERT_SLOT_MS;
    }
    return out;
  }
  const out = [];
  for (let k = 0; k < n; k++) out.push([k * INSERT_SLOT_MS, (k + 1) * INSERT_SLOT_MS]);
  return out;
}

/**
 * 根据组、旧 cue 与新行文本，计算每组内每行的 [start,end]。
 * manualTimes: Map(groupKey -> [[s,e],...])，存在则保留手动值。
 */
function assignGroupTimes(group, groups, idx, oldCues, newTexts, manualTimes) {
  const key = `${group.type}:${idx}`;
  if (manualTimes && manualTimes.has(key)) return manualTimes.get(key);

  if (group.type === 'match') {
    const c = oldCues[group.old[0]];
    return [[c.start, c.end]];
  }
  if (group.type === 'merge') {
    const first = oldCues[group.old[0]];
    const last = oldCues[group.old[group.old.length - 1]];
    return [[first.start, last.end]];
  }
  if (group.type === 'split') {
    const c = oldCues[group.old[0]];
    return splitSpan(c.start, c.end, group.neu.map((j) => newTexts[j]));
  }
  // insert：找前后非 insert/skipOld 且有自动时码的锚点
  let prevAnchor = null;
  let nextAnchor = null;
  for (let k = idx - 1; k >= 0; k--) {
    const g = groups[k];
    if (g.type === 'match' || g.type === 'split' || g.type === 'merge') {
      const tt = assignGroupTimes(g, groups, k, oldCues, newTexts, manualTimes);
      prevAnchor = { end: tt[tt.length - 1][1] };
      break;
    }
  }
  for (let k = idx + 1; k < groups.length; k++) {
    const g = groups[k];
    if (g.type === 'match' || g.type === 'split' || g.type === 'merge') {
      const tt = assignGroupTimes(g, groups, k, oldCues, newTexts, manualTimes);
      nextAnchor = { start: tt[0][0] };
      break;
    }
  }
  return assignInsertGroup(group, prevAnchor, nextAnchor);
}

// 行标注（待处理原因） ------------------------------------------------------

function annotateRows(groups, timesByGroup, oldCues, newTexts, options = {}) {
  const rows = [];
  const oldUsage = new Map(); // oldId -> [rowKey...]

  groups.forEach((g, gi) => {
    const times = timesByGroup[gi];
    g.neu.forEach((nj, ri) => {
      const key = `${gi}:${ri}`;
      rows.push({
        key,
        groupKey: `${g.type}:${gi}`,
        groupIndex: gi,
        type: g.type,
        newIndex: nj,
        oldIds: g.old.map((x) => x),
        text: newTexts[nj],
        start: times[ri][0],
        end: times[ri][1],
        score: g.type === 'insert' || g.type === 'skipOld' ? null : g.score,
        reasons: [],
        included: true,
      });
    });
    g.old.forEach((oi) => {
      if (!oldUsage.has(oi)) oldUsage.set(oi, []);
      oldUsage.get(oi).push(`${g.type}:${gi}`);
    });
  });

  // 未被任何 match/split/merge 组引用的旧 cue 作为参考行返回（included=false）。
  // 初次对齐时它们来自 skipOld；手动校订后则是未在配对中引用的旧序号。
  const referenced = new Set();
  for (const g of groups) {
    if (g.type === 'match' || g.type === 'split' || g.type === 'merge') {
      g.old.forEach((oi) => referenced.add(oi));
    }
  }
  const refRows = [];
  oldCues.forEach((c, oi) => {
    if (referenced.has(oi)) return;
    const gi = groups.findIndex(
      (g) => g.type === 'skipOld' && g.old[0] === oi
    );
    refRows.push({
      key: `ref:${gi >= 0 ? gi : oi}`,
      groupKey: gi >= 0 ? `skipOld:${gi}` : null,
      groupIndex: gi >= 0 ? gi : -1,
      type: 'skipOld',
      newIndex: null,
      oldIds: [oi],
      text: c.text,
      start: c.start,
      end: c.end,
      score: null,
      reasons: ['unmatched_old'],
      included: false,
    });
  });

  // 相似度不足
  for (const r of rows) {
    if ((r.type === 'match' || r.type === 'split' || r.type === 'merge') && r.score !== null) {
      if (r.score - MATCH_BONUS < MIN_CONFIDENCE) r.reasons.push('low_confidence');
    }
    if (r.type === 'insert') r.reasons.push('unmatched_new');
    if (r.end < r.start) r.reasons.push('invalid_time');
  }

  // 同一旧 cue 被多个组使用 → 配对异常
  for (const [, gkeys] of oldUsage) {
    const uniq = [...new Set(gkeys)];
    if (uniq.length > 1) {
      for (const r of rows) {
        if (uniq.includes(r.groupKey)) r.reasons.push('duplicate_old');
      }
    }
  }

  // 倒序 / 重叠（仅在成片行之间、按开始时间排序后扫描；记录到实际行上）
  const ordered = rows
    .filter((r) => r.included && r.end >= r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let k = 1; k < ordered.length; k++) {
    const a = ordered[k - 1];
    const b = ordered[k];
    if (b.start < a.start) b.reasons.push('out_of_order');
    if (b.start < a.end && b.end > a.start) {
      a.reasons.push('overlap');
      b.reasons.push('overlap');
    }
  }
  for (let k = 0; k < ordered.length; k++) {
    if (ordered[k].end < ordered[k].start) ordered[k].reasons.push('out_of_order');
  }

  return { rows, refRows };
}

// 顶层对齐入口 --------------------------------------------------------------

function align(oldCues, newCues) {
  const newTexts = newCues.map((c) => c.text);
  const scorer = new Scorer();
  const steps = alignCues(oldCues, newCues, scorer);
  const groups = buildGroups(steps);
  const manual = new Map();
  const timesByGroup = groups.map((g, idx) =>
    assignGroupTimes(g, groups, idx, oldCues, newTexts, manual)
  );
  const { rows, refRows } = annotateRows(groups, timesByGroup, oldCues, newTexts);
  return {
    groups,
    rows,
    refRows,
    oldCues,
    newTexts,
  };
}

// 校订：用户修改配对/文字/时码后重算 ----------------------------------------

/**
 * payload rows: [{ key, oldIds:[0基旧序号], text, start, end }]
 *   - oldIds 为空 → insert 组（连续相邻的空 oldIds 行自动并为一个插值组）
 *   - oldIds 长度 1 → match（独立）或 split（相邻行共享同一旧 id 的同一段集合）
 *   - oldIds 长度 >=2 → merge
 * 行顺序即修订台词顺序。
 * 选项：
 *   recomputeAll=true 时忽略所有手动时码，按规则重新分配全部时间。
 */
function refine(oldCues, payloadRows, options = {}) {
  const newTexts = payloadRows.map((r) => String(r.text || ''));
  const n = payloadRows.length;

  // ---- 1. 分组 -----------------------------------------------------------
  const groups = [];
  const rowGroupIndex = new Array(n);

  const sameArray = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  for (let i = 0; i < n; i++) {
    const r = payloadRows[i];
    let ids = (Array.isArray(r.oldIds) ? r.oldIds : [])
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x >= 0 && x < oldCues.length);

    if (ids.length === 0) {
      // insert：与前一 insert 组连续则并入
      const prev = payloadRows[i - 1];
      const prevIds = prev ? (Array.isArray(prev.oldIds) ? prev.oldIds : []) : null;
      if (prevIds && prevIds.length === 0 && groups.length) {
        const g = groups[groups.length - 1];
        if (g.type === 'insert') {
          g.neu.push(i);
          rowGroupIndex[i] = groups.length - 1;
          continue;
        }
      }
      rowGroupIndex[i] = groups.length;
      groups.push({ type: 'insert', old: [], neu: [i], score: 0 });
      continue;
    }

    if (ids.length >= 2) {
      rowGroupIndex[i] = groups.length;
      groups.push({ type: 'merge', old: ids, neu: [i], score: 0 });
      continue;
    }

    // 单 id：检查是否与相邻行构成 split（共享同一旧 id）
    const singleId = ids[0];
    let joined = false;
    const checkJoin = (otherIndex) => {
      if (otherIndex < 0 || otherIndex >= n) return false;
      const o = payloadRows[otherIndex];
      const oids = (Array.isArray(o.oldIds) ? o.oldIds : [])
        .map(Number)
        .filter((x) => Number.isInteger(x) && x >= 0 && x < oldCues.length);
      return oids.length === 1 && oids[0] === singleId;
    };
    if (checkJoin(i - 1)) {
      const gi = rowGroupIndex[i - 1];
      const g = groups[gi];
      if (g.type === 'split') {
        g.neu.push(i);
        rowGroupIndex[i] = gi;
        joined = true;
      }
    }
    if (!joined && checkJoin(i + 1)) {
      rowGroupIndex[i] = groups.length;
      groups.push({ type: 'split', old: [singleId], neu: [i], score: 0 });
      joined = true;
    }
    if (!joined) {
      rowGroupIndex[i] = groups.length;
      groups.push({ type: 'match', old: [singleId], neu: [i], score: 0 });
    }
  }

  // ---- 2. 组分数 ----------------------------------------------------------
  const scorer = new Scorer();
  const oldSt = oldCues.map((c) => scorer.encode(c.text));
  const newSt = newTexts.map((t) => scorer.encode(t));
  const joinEnc = (acc, st) => (acc ? scorer.concat(acc, st) : st);
  for (const g of groups) {
    if (g.type === 'match') {
      g.score = scorer.score(oldSt[g.old[0]], newSt[g.neu[0]]) + MATCH_BONUS;
    } else if (g.type === 'split') {
      const joined = g.neu.map((j) => newSt[j]).reduce(joinEnc, null);
      let part = 0;
      for (const j of g.neu) part += scorer.score(oldSt[g.old[0]], newSt[j]);
      g.score = (scorer.score(oldSt[g.old[0]], joined) + part / g.neu.length) / 2;
    } else if (g.type === 'merge') {
      const joined = g.old.map((oi) => oldSt[oi]).reduce(joinEnc, null);
      let part = 0;
      for (const oi of g.old) part += scorer.score(oldSt[oi], newSt[g.neu[0]]);
      g.score = (scorer.score(joined, newSt[g.neu[0]]) + part / g.old.length) / 2;
    }
  }

  // ---- 3. 时间 ------------------------------------------------------------
  // recomputeAll：全自动。否则仅当用户未给该组任何行提供有效时码时自动分配；
  // 组内只要存在一条带时码的行，整组沿用提交值（split 组内空隙由后端补算会更复杂，
  // 前端在编辑拆分行时会整组一起提交，故按组保留即可）。
  const manualTimes = new Map();
  if (!options.recomputeAll) {
    groups.forEach((g, gi) => {
      const vals = g.neu.map((j) => {
        const r = payloadRows[j];
        const s = toMs(r.start);
        const e = toMs(r.end);
        return s === null || e === null ? null : [s, e];
      });
      if (vals.every(Boolean)) manualTimes.set(`${g.type}:${gi}`, vals);
    });
  }

  const timesByGroup = groups.map((g, idx) =>
    assignGroupTimes(g, groups, idx, oldCues, newTexts, manualTimes)
  );

  // ---- 4. 标注 ------------------------------------------------------------
  const { rows, refRows } = annotateRows(groups, timesByGroup, oldCues, newTexts);
  // 保留前端 key
  rows.forEach((r) => {
    r.key = payloadRows[r.newIndex].key || r.key;
  });

  return { groups, rows, refRows, oldCues, newTexts };
}

function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const tc = parseTimecode(v.includes('-->') ? v : `00:00:00,000 --> ${v}`);
    return tc ? tc.end : null;
  }
  return null;
}

// SRT 生成 ------------------------------------------------------------------

function generateSrt(rows) {
  const out = [];
  let seq = 1;
  for (const r of rows) {
    if (r.included === false) continue;
    const text = String(r.text || '').trim();
    if (!text) continue;
    let start = Math.max(0, Math.round(r.start || 0));
    let end = Math.round(r.end || 0);
    if (end < start) {
      // 导出兜底：倒序行至少导出 1ms，避免生成非法时码
      end = start + 1;
    }
    out.push(`${seq}`);
    out.push(`${msToSrt(start)} --> ${msToSrt(end)}`);
    out.push(text);
    out.push('');
    seq++;
  }
  return out.join('\n');
}

module.exports = {
  MIN_CONFIDENCE,
  msToSrt,
  parseSrt,
  parseLines,
  parseTimecode,
  similarity,
  normalize,
  splitSpan,
  align,
  refine,
  generateSrt,
};
