export type SequenceOp =
  | { op: "equal"; a: number; b: number }
  | { op: "delete"; a: number }
  | { op: "insert"; b: number };

/** Past this many cells the LCS table costs too much; the middle becomes a plain replace. */
const MAX_CELLS = 2_000_000;

/**
 * Edit script turning `a` into `b`: an LCS with the shared prefix and suffix
 * trimmed first. Deletes come before inserts inside each changed run, so
 * callers can pair them up as edits.
 */
export function diffSequence<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean = Object.is): SequenceOp[] {
  let start = 0;
  while (start < a.length && start < b.length && same(a[start], b[start])) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1], b[endB - 1])) {
    endA -= 1;
    endB -= 1;
  }

  const ops: SequenceOp[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ op: "equal", a: i, b: i });
  ops.push(...middle(a, b, start, endA, endB, same));
  for (let i = 0; endA + i < a.length; i += 1) ops.push({ op: "equal", a: endA + i, b: endB + i });
  return ops;
}

function middle<T>(a: readonly T[], b: readonly T[], start: number, endA: number, endB: number, same: (x: T, y: T) => boolean): SequenceOp[] {
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    const ops: SequenceOp[] = [];
    for (let i = start; i < endA; i += 1) ops.push({ op: "delete", a: i });
    for (let j = start; j < endB; j += 1) ops.push({ op: "insert", b: j });
    return ops;
  }
  // lcs[i][j]: LCS length of a[start+i..endA) and b[start+j..endB).
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = same(a[start + i], b[start + j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: SequenceOp[] = [];
  let deletes: SequenceOp[] = [];
  let inserts: SequenceOp[] = [];
  const flush = () => {
    ops.push(...deletes, ...inserts);
    deletes = [];
    inserts = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same(a[start + i], b[start + j])) {
      flush();
      ops.push({ op: "equal", a: start + i, b: start + j });
      i += 1;
      j += 1;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      inserts.push({ op: "insert", b: start + j });
      j += 1;
    } else {
      deletes.push({ op: "delete", a: start + i });
      i += 1;
    }
  }
  flush();
  return ops;
}
