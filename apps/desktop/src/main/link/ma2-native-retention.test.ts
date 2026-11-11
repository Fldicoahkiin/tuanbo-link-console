import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type Ma2Catalog } from '@tb/schema';
import { importMa2TimecodeCommand, compileLightingPackets, matchMa2Programs, saveMa2ReadStateCommand } from '@tb/core/link';
import { convertMa2Snapshot, convertMa2TimecodeReferences } from './ma2-timecode-conversion';
import { Ma2ApplyService } from './ma2-apply-service';
import { prepareMa2MergedEvents } from './ma2-event-write';
import { readMa2Catalog } from './ma2-catalog';
import { meiNanXml, meiNanSequences, meiNanCues } from './fixtures/ma2-mei-nan-reconstruction';
import { showStopped } from './fixtures/show-gates';

function songProject() {
  const project = createEmptyLinkProject('截图重建回归，非现场验收');
  project.rundown = [{ id: 'song', title: '不同的中文歌名', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: 'audio', relativePath: 'assets/test.wav', sha256: 'a'.repeat(64), durationMs: 40000 }, playback: { volume: 100, endAction: 'stop', startMs: 1500, endMs: 39000, mtcOffsetMs: 480000, shortcut: '' } }];
  return project;
}
const sequenceXml = `<?xml version="1.0" encoding="utf-8"?><MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0"><Sequ index="35" name="Screenshot reconstruction">${meiNanCues.map((number, index) => `<Cue index="${index + 1}"><Number number="${Number(number.split('.')[0])}" sub_number="${Number(number.split('.')[1])}" /><CuePart index="0" /></Cue>`).join('')}</Sequ></MA>`;
const withSequence = (xml: string): string => xml.replace('</MA>', `${sequenceXml.match(/<Sequ[\s\S]*<\/Sequ>/)![0]}</MA>`);
it('截图重建的24个混合事件保留全部原文，11个已知Cue进入歌曲时间线与素材库；改 Cue 时间写回同一条时间线，控台专有动作原样保留（2026-10-26）', async () => {
  const preview = convertMa2TimecodeReferences(meiNanXml, meiNanSequences, 2);
  expect(preview.timing?.absoluteEventTimesMs).toHaveLength(24);
  expect(preview.unconverted).toHaveLength(13);
  const imported = importMa2TimecodeCommand('song', preview).execute(songProject());
  const lighting = imported.rundown[0]!.lighting!;
  expect(lighting.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).map(event => event.kind === 'ma2' ? event.cue : '')).toEqual(meiNanCues);
  expect(lighting.tracks[1]!.clips[0]!.events[0]!.at).toBe(100);
  expect(lighting.templates).toHaveLength(11);
  expect(lighting.ma2Bindings![0]!.sourceXml).toBe(meiNanXml);
  expect(lighting.ma2Bindings![0]!.nativeEvents).toHaveLength(13);
  expect(() => compileLightingPackets(lighting)).toThrow('控台原样');
  lighting.tracks[1]!.clips[0]!.events[0]!.at = 200;
  let console = withSequence(meiNanXml);
  const bridge = { request: vi.fn(() => Promise.resolve(console)), exchange: vi.fn((_operation: string, _target: number, _expected: string, desired: string) => { console = withSequence(desired); return Promise.resolve({ response: desired, requestId: 'b'.repeat(32) }); }) };
  const readback = convertMa2Snapshot(withSequence(meiNanXml), 2, [], 480000);
  const result = await new Ma2ApplyService(bridge, showStopped).apply({ dataDirectory: '', document: lighting, bindingId: lighting.ma2Bindings![0]!.id, readback, conflicts: [] });
  expect(result).toMatchObject({ status: 'verified' });
  expect(bridge.exchange).toHaveBeenCalledOnce();
  // Only the moved Cue changed: 3 → 6 frames (100 ms → 200 ms after the song start). Master faders, XFade and Learn stay as they were.
  const events = (xml: string) => [...xml.matchAll(/<Event\s([^>]*)>/g)].map(match => match[1]!.replace(/\s*index="\d+"/, '').replace(/\s*\/$/, '').trim());
  const before = events(meiNanXml), after = events(console);
  expect(after).toHaveLength(24);
  expect(after.filter(value => !before.includes(value))).toEqual(['time="6" command="Goto" pressed="true"']);
  expect(before.filter(value => !after.includes(value))).toEqual(['time="3" command="Goto" pressed="true"']);
  expect(parseLinkProject(JSON.parse(JSON.stringify(imported))).rundown[0]!.lighting!.ma2Bindings![0]!.sourceXml).toBe(meiNanXml);
});
it('额外参数的Goto只投影已知Cue；释放事件保留而不伪造为一次Goto', () => {
  const xml = meiNanXml.replace('command="Goto"', 'unknown="keep-exactly" command="Goto"').replace('time="52" command="Goto" pressed="true"', 'time="52" command="Goto" pressed="false"');
  const preview = convertMa2TimecodeReferences(xml, meiNanSequences, 2);
  expect(preview.unconverted).toHaveLength(15);
  expect(preview.document.tracks[1]!.clips[0]!.events).toHaveLength(10);
  expect(preview.sourceXml).toBe(xml);
});
it('带控台专有参数的 Cue 在软件里可改时间（参数原样保留），换 Cue 被拒绝；整条删掉含专有动作的轨道被拒绝（2026-10-26）', () => {
  const xml = meiNanXml.replace('<Event index="0" time="3" command="Goto"', '<Event index="0" time="3" unknown="keep-exactly" command="Goto"');
  const preview = convertMa2TimecodeReferences(xml, meiNanSequences, 2);
  const lighting = importMa2TimecodeCommand('song', preview).execute(songProject()).rundown[0]!.lighting!;
  const bindingId = lighting.ma2Bindings![0]!.id;
  const readback = convertMa2Snapshot(withSequence(xml), 2, [], 480000);
  const moved = structuredClone(lighting); moved.tracks[1]!.clips[0]!.events[0]!.at = 200;
  const write = prepareMa2MergedEvents(moved, bindingId, readback, new Map(), [withSequence(xml)]);
  expect(write.desiredXml).toMatch(/<Event index="0" time="6" unknown="keep-exactly" command="Goto" pressed="true">/);
  const recued = structuredClone(lighting); const event = recued.tracks[1]!.clips[0]!.events[0]!;
  if (event.kind !== 'ma2') throw new Error('测试数据应为 Cue');
  event.cue = '2.000';
  expect(() => prepareMa2MergedEvents(recued, bindingId, readback, new Map(), [withSequence(xml)])).toThrow('不转换的控台参数');
  const removed = structuredClone(lighting); removed.tracks.splice(2, 1);
  expect(() => prepareMa2MergedEvents(removed, bindingId, readback, new Map(), [withSequence(xml)])).toThrow('要删掉整条轨道，请在控台上删');
});
it('不推断未验证帧率，原始目录与XML仍保留', async () => {
  const xml = meiNanXml.replace('30 FPS', '25 FPS');
  const directory = { show: 'reconstruction', version: '3.7.0.5', generation: '1', entries: [{ target: 2, name: 'mei-nan' }] };
  const catalog = await readMa2Catalog({ request: vi.fn().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(xml).mockResolvedValueOnce(xml).mockResolvedValueOnce(JSON.stringify(directory)) }, showStopped, meiNanSequences[0]);
  expect(catalog.entries[0]?.error).toBeNull();
  expect(catalog.entries[0]?.conversionError).toContain('30 FPS');
  expect(catalog.entries[0]?.sourceXml).toBe(xml);
});
it('取消保留已完成对象，按目标补读只请求失败项，复核使用目录而非全Show', async () => {
  const directory = { show: 'cancel', version: '3.7.0.5', generation: '1', entries: [{ target: 2, name: 'mei-nan' }, { target: 3, name: '待读取' }] };
  const signal = new AbortController();
  const request = vi.fn((operation: string) => Promise.resolve(operation === 'LIST' ? JSON.stringify(directory) : meiNanXml));
  const partial = await readMa2Catalog({ request }, showStopped, meiNanSequences[0], progress => { if (progress.completed === 1) signal.abort(); }, signal.signal);
  expect(partial.entries).toHaveLength(1); expect(partial.entries[0]?.preview?.unconverted).toHaveLength(13); expect(partial.incomplete).toBeTruthy();
  const retry = vi.fn((operation: string) => Promise.resolve(operation === 'LIST' ? JSON.stringify(directory) : meiNanXml.replace('Timecode index="1"', 'Timecode index="2"')));
  const rest = await readMa2Catalog({ request: retry }, showStopped, meiNanSequences[0], undefined, undefined, { targets: [3] });
  expect(rest.entries.map(entry => entry.target)).toEqual([3]);
  expect(retry.mock.calls.map(call => call[0])).toEqual(['LIST', 'READ', 'READ', 'LIST']);
});
it('100条混合时间线一次读取，缓存后配对与重新打开工程无需网络；异常对象保留独立错误', async () => {
  const directory = { show: '100条规模重建', version: '3.7.0.5', generation: '1', entries: Array.from({ length: 100 }, (_, index) => ({ target: index + 1, name: `TC${index + 1}` })) };
  const request = vi.fn((operation: string, target: number) => {
    if (operation === 'LIST') return Promise.resolve(JSON.stringify(directory));
    if (target === 99) return Promise.reject(new Error('读取超时样例'));
    return Promise.resolve(meiNanXml.replace('Timecode index="1"', `Timecode index="${target - 1}"`).replace('offset="14400"', `offset="${14400 + (target - 1) * 1200}"`));
  });
  const catalog = await readMa2Catalog({ request }, showStopped, meiNanSequences[0]);
  expect(catalog.entries).toHaveLength(100); expect(catalog.entries[98]?.error).toBe('读取超时样例');
  expect(catalog.metrics?.requests).toBe(201); // 2 LIST + 99*2 READ + 1 failed READ.
  const project = songProject();
  const matched = matchMa2Programs(project, catalog);
  expect(matched.pairs).toEqual({ 1: 'song' });
  const cached = saveMa2ReadStateCommand({ source: '2.0.0.98:30000', catalog, pairs: matched.pairs, failures: [{ target: 99, message: '读取超时样例' }], selectedTarget: 2, query: 'mei', filter: 'native', message: '缓存' }).execute(project);
  const reopened = parseLinkProject(JSON.parse(JSON.stringify(cached)));
  expect(reopened.ma2ReadState).toEqual(cached.ma2ReadState);
  expect(reopened.ma2ReadState?.catalog.entries.filter(entry => entry.preview).length).toBe(99);
  const calls = request.mock.calls.length;
  const value: Ma2Catalog = reopened.ma2ReadState!.catalog;
  expect(matchMa2Programs(reopened, value).pairs).toEqual({ 1: 'song' });
  expect(request).toHaveBeenCalledTimes(calls);
});
