/** Fixed-width LZW codes, big endian. At most 65,536 dictionary entries on either end. */
export function packMa2Bytes(source: Buffer, minimumSize: number): Buffer {
  if (source.length < minimumSize) return source;
  const pairs = new Map<number, number>();
  const packed = Buffer.alloc(source.length);
  let prefix = source[0]!, written = 0;
  for (const byte of source.subarray(1)) {
    const pair = prefix * 256 + byte;
    const code = pairs.get(pair);
    if (code !== undefined) { prefix = code; continue; }
    if (written + 4 >= source.length) return source;
    packed.writeUInt16BE(prefix, written); written += 2;
    if (pairs.size < 65536 - 256) pairs.set(pair, 256 + pairs.size);
    prefix = byte;
  }
  packed.writeUInt16BE(prefix, written);
  return packed.subarray(0, written + 2);
}

// Keep the decoder state across even-sized chunks. Each call returns the original
// bytes and the two running Adler-32 sums. MA's native Lua can use 32-bit integers.
export const ma2LzwDecoder = [
  "local dict={};for i=0,255 do dict[i]=string.char(i) end;",
  "local n,prev,a,z=256,nil,1,0;local function expand(data)local out={};for j=1,#data,2 do ",
  "local hi,lo=data:byte(j,j+1);local k=hi*256+lo;local s=dict[k];if not s and k==n and prev then s=prev..prev:sub(1,1) end;assert(s);",
  "if prev and n<65536 then dict[n]=prev..s:sub(1,1);n=n+1 end;for t=1,#s do a=(a+s:byte(t))%65521;z=(z+a)%65521 end;",
  "out[#out+1]=s;prev=s end;return table.concat(out),a,z end;"
].join('');

export function ma2AdlerSums(source: Buffer): [number, number] {
  let a = 1, b = 0;
  for (const byte of source) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return [a, b];
}
