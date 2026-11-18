/** Copy unchanged byte ranges from the exact snapshot the console still owns.
 * Limit the index and the number of fragments so an unrelated or very large
 * document stays on the ordinary upload path. Offsets are bytes, including UTF-8. */
export function encodeMa2SnapshotDelta(base: Buffer, desired: Buffer): Buffer | null {
  const block = 32;
  if (desired.length <= 256 || desired.length > 512 * 1024 || base.length > 1024 * 1024) return null;
  const offsets = new Map<string, number>();
  for (let i = 0; i + block <= base.length; i += block) offsets.set(base.toString('latin1', i, i + block), i);
  const parts: Buffer[] = [];
  let literal = 0;
  function appendLiteral(end: number): void {
    if (end > literal) parts.push(Buffer.from(`L${end - literal}\n`), desired.subarray(literal, end));
  }
  for (let i = 0; i + block <= desired.length;) {
    const offset = offsets.get(desired.toString('latin1', i, i + block));
    if (offset === undefined) { i++; continue; }
    let start = i, from = offset;
    while (start > literal && from > 0 && desired[start - 1] === base[from - 1]) { start--; from--; }
    let end = i + block;
    while (end < desired.length && desired[end] === base[from + end - start]) end++;
    appendLiteral(start);
    parts.push(Buffer.from(`C${from},${end - start}\n`));
    if (parts.length > 2048) return null;
    literal = end; i = end;
  }
  appendLiteral(desired.length);
  const delta = Buffer.concat(parts);
  return Math.ceil(delta.length / 256) < Math.ceil(desired.length / 256) ? delta : null;
}
