import { randomBytes } from 'node:crypto';
import { ma2EffectLibrarySchema, ma2ObjectDirectorySchema, type Ma2CatalogRequest, type Ma2EffectLibrary, type Ma2ObjectDirectory, type Ma2ReadProgressUpdate } from '@tb/schema';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';

/** Read object metadata only. Never export fixture values merely to display a Cue list. */
export async function readMa2NativeLibrary(connection: Pick<Ma2Telnet, 'command'>, bridge: Pick<Ma2OnpcBridge, 'request'>, isPlaying: () => boolean, onProgress?: (progress: Ma2ReadProgressUpdate) => void | Promise<void>, phase: 'library' | 'verification' = 'library', signal?: AbortSignal, targets?: readonly number[], measure?: (bytes: number) => void, sessionDirectory?: Ma2ObjectDirectory, expectedSource?: Ma2CatalogRequest['expectedSource']): Promise<Ma2EffectLibrary> {
  if (signal?.aborted) throw new Error('素材读取已取消');
  // A catalog session owns the final directory verification when reusing this snapshot.
  const directory = sessionDirectory ?? ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
  if (signal?.aborted) throw new Error('素材读取已取消');
  if (expectedSource && Object.entries(expectedSource).some(([key, value]) => Reflect.get(directory, key) !== value)) throw new Error('Show 或控台会话已改变，保留缓存，请重新读取目录');
  const readAt = new Date().toISOString();
  await onProgress?.({ phase, completed: 0, total: directory.entries.length + 1, detail: '读取序列与 Cue', show: directory.show, checkpoint: { directory, readAt } });
  const sequences: Ma2EffectLibrary['sequences'] = [];
  const errors: Ma2EffectLibrary['errors'] = [];
  const read = async (target: number, offset: number): Promise<string> => {
    if (isPlaying()) throw new Error('播放已开始，素材读取已停止');
    const prefix = `TBLINK_CUES_${randomBytes(16).toString('hex')}:`;
    const script = `local o=gma.show.getobj;local h=o.handle('Sequence ${target}');local r='missing';if h then local n=o.amount(h);local t={tostring(n)};for i=${offset},math.min(n-1,${offset + 31}) do local c=o.child(h,i);if c then local v=tostring(o.number(c));local s=tostring(o.name(c) or '');local x=s:gsub('.',function(b)return string.format('%02x',string.byte(b))end);t[#t+1]=i..','..v..','..x end end;r=table.concat(t,';') end;gma.echo('${prefix}'..r)`;
    const response = await connection.command(`Lua "${script}"`, text => ma2ResponseLine(text, prefix));
    measure?.(Buffer.byteLength(response, 'utf8'));
    return response;
  };
  if (targets?.some(target => !directory.entries.some(entry => entry.target === target))) throw new Error('时间线引用的序列已不存在');
  for (const entry of directory.entries.filter(entry => !targets || targets.includes(entry.target))) {
    if (signal?.aborted) throw new Error('素材读取已取消');
    try {
      const cues: Ma2EffectLibrary['sequences'][number]['cues'] = [];
      let count = 1;
      for (let offset = 0; offset < count; offset += 32) {
        if (signal?.aborted) throw new Error('素材读取已取消');
        const response = await read(entry.target, offset);
        if (signal?.aborted) throw new Error('素材读取已取消');
        if (response !== await read(entry.target, offset)) throw new Error(`序列 ${entry.target} 在读取期间发生变化，请重新读取`);
        if (signal?.aborted) throw new Error('素材读取已取消');
        const [total, ...rows] = response.split(';');
        if (!/^\d+$/.test(total ?? '') || Number(total) > 100000) throw new Error(`序列 ${entry.target} 的素材目录无效`);
        if (offset && count !== Number(total)) throw new Error('控台 Cue 数量发生变化，请重新读取');
        count = Number(total);
        for (const row of rows) {
          const match = /^(\d+),(\d+(?:\.\d{1,3})?),((?:[a-f0-9]{2})*)$/.exec(row);
          if (!match) throw new Error(`序列 ${entry.target} 返回了不支持的 Cue 编号`);
          if (Number(match[2]) === 0) continue;
          const [whole, fraction = ''] = match[2]!.split('.');
          cues.push({ index: Number(match[1]), number: `${Number(whole)}.${fraction.padEnd(3, '0')}`, name: Buffer.from(match[3]!, 'hex').toString('utf8') || null });
        }
      }
      sequences.push(ma2EffectLibrarySchema.shape.sequences.parse([{ sequence: entry.target, name: entry.name, cues }])[0]!);
    } catch (cause) {
      if (signal?.aborted || isPlaying()) throw cause;
      errors.push({ sequence: entry.target, message: cause instanceof Error ? cause.message : String(cause) });
    }
    await onProgress?.({ phase, completed: sequences.length + errors.length, total: directory.entries.length + 1, detail: `已核对序列 ${entry.target}`, sequences: sequences.at(-1)?.sequence === entry.target ? [sequences.at(-1)!] : [], ...(errors.at(-1)?.sequence === entry.target ? { libraryError: errors.at(-1)! } : {}) });
  }
  if (signal?.aborted) throw new Error('素材读取已取消');
  await onProgress?.({ phase, completed: sequences.length + errors.length, total: directory.entries.length + 1, detail: '核对控台序列目录' });
  const verified = sessionDirectory ?? ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
  if (signal?.aborted) throw new Error('素材读取已取消');
  if (isPlaying() || JSON.stringify(directory) !== JSON.stringify(verified)) throw new Error('控台工程或序列目录发生变化，请重新读取');
  const result = ma2EffectLibrarySchema.parse({ directory, sequences, fixtureUsage: [], fixtureDetails: 'unavailable', errors, readAt });
  await onProgress?.({ phase, completed: directory.entries.length + 1, total: directory.entries.length + 1, detail: '序列目录已核对' });
  return result;
}
