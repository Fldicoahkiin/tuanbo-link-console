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

/** Inserting or removing a point renumbers every later Event on its native subtrack.
 * A second copy dictionary represents those new indices. Both dictionaries are used
 * only as sources of byte ranges; the decoder still reconstructs the exact desired XML. */
export function encodeMa2ReindexedDelta(base: Buffer, desired: Buffer, ordinary: Buffer): { shift: number; data: Buffer } | null {
  if (ordinary.length <= 256 || base.length > 131072 || desired.length > 131072) return null;
  const native = base.toString('latin1').match(/<Timecode\s[\s\S]*?<\/Timecode>/)?.[0];
  if (!native) return null;
  const shift = (desired.toString('latin1').match(/<Event index="/g)?.length ?? 0) - (native.match(/<Event index="/g)?.length ?? 0);
  if (!shift || Math.abs(shift) > 256) return null;
  const shifted = native.replace(/<Event index="(\d{1,7})"/g, (original: string, index: string) => {
    const n = Number(index) + shift;
    return n >= 0 ? `<Event index="${n}"` : original;
  });
  const data = encodeMa2SnapshotDelta(Buffer.concat([base, Buffer.from(shifted, 'latin1')]), desired);
  return data && Math.ceil(data.length / 256) < Math.ceil(ordinary.length / 256) ? { shift, data } : null;
}
