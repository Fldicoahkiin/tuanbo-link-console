import { ma2EffectLibrarySchema, ma2ObjectDirectorySchema, type Ma2CatalogRequest, type Ma2EffectLibrary, type Ma2ReadProgressUpdate } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { readMa2AttributeCatalog } from './ma2-attribute-catalog';
import type { Ma2Telnet } from './ma2-telnet';
import { holdForShow, isShowWait, type ShowGateReader } from '@tb/core/link';
import { inspectMa2CueFixtures, inspectMa2SequenceXml, inspectMa2CueAttributes } from './ma2-timecode-xml';

/** `show` is asked before each step: paused it reads (第 3 题); a program that starts moving stops it before the next step. */
export async function readMa2EffectLibrary(bridge: Pick<Ma2OnpcBridge, 'request'>, show: ShowGateReader, onProgress?: (progress: Ma2ReadProgressUpdate) => void | Promise<void>, signal?: AbortSignal, targets?: readonly number[], expectedSource?: Ma2CatalogRequest['expectedSource'], details?: Ma2CatalogRequest['details'], connection?: Pick<Ma2Telnet, 'command'>): Promise<Ma2EffectLibrary> {
  if (signal?.aborted) throw new Error('素材读取已取消');
  holdForShow(show, 'ma2.sync.read');
  await onProgress?.({ phase: 'connecting', completed: 0, total: 0, detail: '正在获取控台序列目录' });
  const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
  if (signal?.aborted) throw new Error('素材读取已取消');
  if (expectedSource && Object.entries(expectedSource).some(([key, value]) => Reflect.get(directory, key) !== value)) throw new Error('控台的 Show 或连接变了，缓存已保留，请重新读取');
  if(targets?.some(target=>!directory.entries.some(entry=>entry.target===target)))throw new Error('所选序列已不存在，请重新读取目录');
  const selected=directory.entries.filter(entry=>!targets||targets.includes(entry.target));
  await onProgress?.({ phase: 'library', completed: 0, total: selected.length + 2, detail: '正在读取控台属性分类目录' });
  const guard = (): void => { if (signal?.aborted) throw new Error('属性读取已中止'); holdForShow(show, 'ma2.sync.read'); };
  if (details === 'attributes' && !connection) throw new Error('需要先连接 MA2 网络，才能读取控台的属性分组');
  const groups = details === 'attributes' ? await readMa2AttributeCatalog(connection!, guard) : undefined;
  const readAt = new Date().toISOString();
  await onProgress?.({ phase: 'library', completed: 1, total: selected.length + 2, detail: '属性目录已读取，开始读取序列与 Cue', show: directory.show, checkpoint: { directory, readAt } });
  const sequences: Ma2EffectLibrary['sequences'] = [];
  const errors: Ma2EffectLibrary['errors'] = [];
  const fixtureUsage: Ma2EffectLibrary['fixtureUsage'] = [];
  const cueAttributes: NonNullable<Ma2EffectLibrary['cueAttributes']> = [];
  let count = 0;
  for (const entry of selected) {
    if (signal?.aborted) throw new Error('素材读取已取消');
    holdForShow(show, 'ma2.sync.read', `已读完 ${sequences.length + errors.length}/${selected.length} 个序列，接着读会从没读的开始。`);
    await onProgress?.({ phase: 'library', completed: sequences.length + errors.length + 1, total: selected.length + 2, detail: `正在读取序列 ${entry.target}；已完成 ${sequences.length + errors.length}/${selected.length}` });
    try {
      const xml = await bridge.request('SEQUENCE', entry.target);
      const report = inspectMa2SequenceXml(xml);
      const sequence = report.sequences[0];
      if (!sequence || report.sequences.length !== 1 || sequence.number !== entry.target) throw new Error('Sequence 与扫描目录不一致');
      // SEQUENCE returns two verified full native exports, unlike metadata-only directory reads.
      const attributes = inspectMa2CueAttributes(xml, readAt, true);
      // The bridge compares two complete native exports before returning XML.
      // A second SEQUENCE request only repeats exports and transfers the same
      // large payload; classification-tree and Show guards still run below.
      if (signal?.aborted) throw new Error('属性读取已中止');
      holdForShow(show, 'ma2.sync.read', `已读完 ${sequences.length + errors.length}/${selected.length} 个序列，接着读会从没读的开始。`);
      count += sequence.cues.length;
      sequences.push({ sequence: sequence.number, name: sequence.name, cues: sequence.cues });
      fixtureUsage.push(...inspectMa2CueFixtures(xml));
      cueAttributes.push(...attributes);
    } catch (error) {
      if (isShowWait(error)) throw error;
      errors.push({ sequence: entry.target, message: error instanceof Error ? error.message : String(error) });
    }
    if (signal?.aborted) throw new Error('素材读取已取消');
    await onProgress?.({ phase: 'library', completed: sequences.length + errors.length + 1, total: selected.length + 2, detail: `已处理 ${sequences.length + errors.length}/${selected.length} 个序列 · ${errors.length} 项失败`, sequences: sequences.at(-1)?.sequence === entry.target ? [sequences.at(-1)!] : [], ...(errors.at(-1)?.sequence === entry.target ? { libraryError: errors.at(-1)! } : {}) });
    if (count > 100000) throw new Error('Cue 超过十万个，扫描已停止');
  }
  await onProgress?.({ phase: 'library', completed: selected.length + 1, total: selected.length + 2, detail: '检查控台序列目录' });
  if (groups && JSON.stringify(groups) !== JSON.stringify(await readMa2AttributeCatalog(connection!, guard))) throw new Error('读取过程中控台的属性分组变了，请重新读取');
  const verified = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
  if (signal?.aborted) throw new Error('素材读取已取消');
  holdForShow(show, 'ma2.sync.read', '序列都读完了，还没核对控台序列目录，停下后重新读取确认。');
  if (JSON.stringify(directory) !== JSON.stringify(verified)) throw new Error('Show 或序列有变化，请重新读取');
  const groupIndex = new Map(groups?.map(group => [group.attribute, group]));
  const classified = cueAttributes.map(cue => ({ ...cue, ...(groups ? { groups: cue.attributes.flatMap(attribute => groupIndex.get(attribute) ?? []) } : {}) }));
  const result = ma2EffectLibrarySchema.parse({ directory, sequences, fixtureUsage, cueAttributes: classified, fixtureDetails: 'included', errors, readAt });
  await onProgress?.({ phase: 'library', completed: selected.length + 2, total: selected.length + 2, detail: '序列目录检查完毕，正在保存结果' });
  return result;
}
