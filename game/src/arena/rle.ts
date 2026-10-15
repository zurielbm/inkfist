// Run-length encoded per-frame input bits: [bits, count, bits, count, ...]. A whole match is a few KB.

export function rleEncode(bits: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i++) rlePush(out, bits[i]);
  return out;
}

export function rlePush(runs: number[], bits: number): void {
  const n = runs.length;
  if (n && runs[n - 2] === bits) runs[n - 1]++;
  else runs.push(bits, 1);
}

export function rleDecode(runs: ArrayLike<number>, limit = 1 << 20): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const b = runs[i] | 0;
    const c = runs[i + 1] | 0;
    if (c < 0 || out.length + c > limit) throw new Error('bad input log');
    for (let k = 0; k < c; k++) out.push(b);
  }
  return out;
}

export function rleLength(runs: ArrayLike<number>): number {
  let n = 0;
  for (let i = 1; i < runs.length; i += 2) n += runs[i];
  return n;
}
