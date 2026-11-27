// solve.js — a fast drop-in for makefun-diff 1.0.0.
//
// Written from the published rule alone (the competition's description and
// the header of the house baseline's index.js, which states it): a text is
// cut into lines after every "\n", the common prefix of lines is kept, then
// the common suffix of what is left, and between them Myers's greedy search
// runs from the first lines — on each diagonal the path reaching furthest
// into the old text, the deletion winning when a deletion and an insertion
// reach the same point, no move past either text's end, no edge diagonal
// pruned, every run of equal lines followed as far as it goes — and the
// first path to reach both ends is the script. The patch is then printed
// with 3 kept lines of context around each change run, runs at most 6 kept
// lines apart sharing a hunk, deletions before insertions in a run, and a
// "%" line after a line that ends its text with no newline.
//
// Nothing here is copied from the baseline or from any other diff
// implementation. The search below keeps, for each edit count, only the
// furthest point each diagonal reaches — all rows in one flat Int32Array
// that is reused across calls, so the timed runs pay no allocation — and
// rebuilds the script by walking those points backwards. That is the
// whole speed trick: no object is built per diagonal step, the previous
// step's insertion candidate is carried forward instead of loaded again,
// line equality is one integer comparison (lines are interned to ids
// first, keyed by the split parts themselves so no line string is ever
// built twice), and the patch is assembled from runs, not from per-line
// objects.

const KEEP = 0;
const DEL = 1;
const INS = 2;

// "No path here": stored in the V rows instead of -1, so the reachability
// checks below need only one comparison each — a real position is always
// below N (for a deletion) or below M + k + 1 (for an insertion), while the
// sentinel sits above both. The xDel/xIns values compared for the max keep
// using -1, below every real position.
const NONE = 0x40000000;

/** One run of the edit script: [kind, count]. Merges with the previous run when the kind matches. */
function pushRun(runs, kind, count) {
  const last = runs[runs.length - 1];
  if (last !== undefined && last[0] === kind) last[1] += count;
  else runs.push([kind, count]);
}

/**
 * A text's lines: the ids (one integer per distinct line, shared between
 * both texts so equal lines get equal ids) and the split parts themselves
 * (the line texts without their "\n"; only the last line can lack one).
 * A middle line's key is its part; a bare last line's key is its part plus
 * "\n" — no middle key ever holds a "\n" (parts are cut on it), so the two
 * can never collide, and equal lines (newline or its absence included) get
 * equal ids. The empty text has no lines.
 */
function tokenize(text, table) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const bare = parts[last] !== '';
  const count = last + (bare ? 1 : 0);
  const ids = new Int32Array(count);
  for (let i = 0; i < last; i++) {
    const p = parts[i];
    let id = table.get(p);
    if (id === undefined) {
      id = table.size;
      table.set(p, id);
    }
    ids[i] = id;
  }
  if (bare) {
    const key = parts[last] + '\n';
    let id = table.get(key);
    if (id === undefined) {
      id = table.size;
      table.set(key, id);
    }
    ids[last] = id;
  }
  return { ids, parts, count };
}

// The Myers V rows live in one flat scratch buffer, reused across calls:
// row d starts at offset d*d (it holds 2d+1 entries, so rows occupy
// [d*d, (d+1)*(d+1))). The buffer grows by doubling when a deeper search
// needs more room, and it is never shrunk, so after warmup the timed runs
// pay no allocation at all. Every entry of every row is written before it
// is read, so stale data from an earlier call is never seen.
let vsBuf = new Int32Array(0);
let vsCap = 0;

function vsGrow(need) {
  let cap = vsCap === 0 ? 1024 : vsCap;
  while (cap < need) cap *= 2;
  const next = new Int32Array(cap);
  if (vsCap > 0) next.set(vsBuf.subarray(0, vsCap));
  vsBuf = next;
  vsCap = cap;
}

/**
 * The edit script's runs for the middle slices A (N lines) into B (M lines),
 * in order. The forward search stores, for each edit count d, the furthest
 * old-text position reached on every diagonal; the script is then rebuilt
 * backwards from the end using those stored points and the same
 * deletion-wins tie-break the forward search used.
 */
function myersRuns(A, B, N, M) {
  const total = N + M;
  let D = -1;

  for (let d = 0; d <= total; d++) {
    const off = d * d;
    const end = off + 2 * d + 1;
    if (end > vsCap) vsGrow(end);
    if (d === 0) {
      const xMax = N < M ? N : M;
      let x = 0;
      while (x < xMax && A[x] === B[x]) x++;
      vsBuf[0] = x;
      if (x === N && x === M) {
        D = 0;
        break;
      }
      continue;
    }
    const prevOff = (d - 1) * (d - 1);
    const prevLen = 2 * d - 1;
    let done = false;
    // One prev-row read per diagonal: the deletion candidate at index ki-2
    // is the insertion candidate the previous step already read, so it is
    // carried in pvPrev instead of loaded again.
    let pvPrev = NONE;
    let mk = M - d; // M + k, carried along the loop
    for (let ki = 0, k = -d; k <= d; ki += 2, k += 2, mk += 2) {
      const pvDel = pvPrev;
      const pvIns = ki < prevLen ? vsBuf[prevOff + ki] : NONE;
      pvPrev = pvIns;
      // Further into the old text wins; the deletion wins a tie. An
      // impossible candidate reads -1, below every real position, so the
      // plain comparison picks the possible one.
      const xDel = pvDel < N ? pvDel + 1 : -1;
      const xIns = pvIns - (k + 1) < M ? pvIns : -1;
      const xPre = xDel >= xIns ? xDel : xIns;
      if (xPre < 0) {
        vsBuf[off + ki] = NONE;
        continue;
      }
      const xMax = N < mk ? N : mk;
      let x = xPre;
      while (x < xMax && A[x] === B[x - k]) x++;
      vsBuf[off + ki] = x;
      if (x === N && x - k === M) {
        done = true;
        break;
      }
    }
    if (done) {
      D = d;
      break;
    }
  }
  if (D < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Walk the stored points backwards: at depth d the path sits on diagonal
  // k = x - y; the snake start is the pre-move point the forward search
  // chose (recovered with the same tie-break), so the kept run between the
  // snake's start and its end is exact — no blind walk back over lines.
  const rev = [];
  let x = N;
  let y = M;
  for (let d = D; d >= 1; d--) {
    const k = x - y;
    const prevOff = (d - 1) * (d - 1);
    const prevLen = 2 * d - 1;
    const iDel = k + d - 2;
    const iIns = k + d;
    const pvDel = iDel >= 0 ? vsBuf[prevOff + iDel] : NONE;
    const pvIns = iIns < prevLen ? vsBuf[prevOff + iIns] : NONE;
    const canDel = pvDel < N;
    const canIns = pvIns - (k + 1) < M;
    const xDel = canDel ? pvDel + 1 : -1;
    const xIns = canIns ? pvIns : -1;
    const isDel = xDel >= xIns;
    const xs = isDel ? xDel : xIns;
    if (x > xs) pushRun(rev, KEEP, x - xs);
    if (isDel) {
      pushRun(rev, DEL, 1);
      x = xs - 1;
      y = xs - k;
    } else {
      pushRun(rev, INS, 1);
      x = xs;
      y = xs - k - 1;
    }
  }
  if (x > 0) pushRun(rev, KEEP, x);
  rev.reverse();
  return rev;
}

/**
 * A line as the patch writes it: its op, the line, a newline, and "%" on a
 * line of its own when the line had none. `part` is the line without its
 * newline; `bare` says it had none.
 */
function written(op, part, bare) {
  return bare ? op + part + '\n%\n' : op + part + '\n';
}

/** make.fun's own patch of the two texts, printed from the edit script's runs. */
function buildPatch(aParts, bParts, runs, n, m, oldBare, newBare) {
  // The change runs: each a stretch of deletions and insertions between two kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    const kind = r[0];
    const count = r[1];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DEL) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 6 kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h === undefined ? undefined : h[h.length - 1];
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = first.o - 3 < 0 ? 0 : first.o - 3;
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(3, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', aParts[at], at === n - 1 && oldBare));
      for (let i = 0; i < c.dels; i++) out.push(written('-', aParts[c.o + i], c.o + i === n - 1 && oldBare));
      for (let i = 0; i < c.ins; i++) out.push(written('+', bParts[c.p + i], c.p + i === m - 1 && newBare));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', aParts[at], at === n - 1 && oldBare));
  }
  return out.join('');
}

/** makefun-diff 1.0.0's answer for one case's input: the patch of { old, new } as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const table = new Map();
  const a = tokenize(input.old, table);
  const b = tokenize(input.new, table);
  const A = a.ids;
  const B = b.ids;
  const n = A.length;
  const m = B.length;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && A[n - 1 - suffix] === B[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) pushRun(runs, KEEP, prefix);
  const mid = myersRuns(
    A.subarray(prefix, n - suffix),
    B.subarray(prefix, m - suffix),
    n - prefix - suffix,
    m - prefix - suffix,
  );
  for (const r of mid) pushRun(runs, r[0], r[1]);
  if (suffix > 0) pushRun(runs, KEEP, suffix);
  return buildPatch(a.parts, b.parts, runs, n, m, !input.old.endsWith('\n'), !input.new.endsWith('\n'));
}
