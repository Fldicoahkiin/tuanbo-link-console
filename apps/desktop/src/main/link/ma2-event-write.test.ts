import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { convertMa2Timecode } from './ma2-timecode-conversion';
import { confirmMa2MergedEvents, prepareMa2MergedEvents } from './ma2-event-write';
import { inspectMa2TimecodeXml } from './ma2-timecode-xml';
import { applyMa2ReadbackCommand, bindMa2TrackCommand, sameMa2Content, snapshotMa2LightingBinding } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { removeMa2Tracks } from './ma2-track-write';

const xml = await readFile(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
const masterXml = await readFile(new URL('./fixtures/ma2-timecode-master-3.3.xml', import.meta.url), 'utf8');
function fixture(source = xml) {
  const preview = convertMa2Timecode(source, [sequence], 9902);
  const document = structuredClone(preview.document);
  document.ma2Bindings = [{ id: 'binding', timecode: 9902, name: preview.name, readAt: preview.readAt, sourceXml: source, baselineTracks: structuredClone(document.tracks), mappings: structuredClone(preview.mappings) }];
  return { document, preview };
}

describe('三方合并到 MA2 原生写入', () => {
  it('空 Timecode 绑定节目推杆轨道后可从零生成执行器和 Master 子轨道', () => {
    const empty = removeMa2Tracks(xml, 9902, ['Timecode:9901/Track:0']).xml;
    const { document, preview } = fixture(empty);
    const track = structuredClone(fixture().document.tracks[0]!);
    track.id = 'master-track';
    track.clips[0]!.id = 'master-clip';
    track.clips[0]!.events = [{ id: 'new-master', at: 500, kind: 'ma2-fader', level: 0.625, executor: '99.219', fader: 'Master', label: '主推杆' }];
    document.tracks.push(track);
    const project = createEmptyLinkProject('从零编排'); project.schemaVersion = 2;
    project.rundown.push({ id: 'item', title: '节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: document });
    const bound = bindMa2TrackCommand('item', 'binding', track.id, '99.219', track.name).execute(project);
    const prepared = prepareMa2MergedEvents(bound.rundown[0]!.lighting!, 'binding', preview, new Map(), new Map(), []);
    const confirmed = confirmMa2MergedEvents(prepared, prepared.desiredXml, []);
    expect(confirmed.document.tracks[0]).toMatchObject({ id: 'master-track', clips: [{ events: [{ id: 'new-master', kind: 'ma2-fader', level: 0.625 }] }] });
    expect(inspectMa2TimecodeXml(prepared.desiredXml).timecodes[0]!.tracks[0]!.subtracks).toHaveLength(2);
    expect(confirmed.unconverted).toEqual([]);
  });
  it('原有 Cue 轨道首次新增 Master 时创建子轨道，重读后不重复创建', () => {
    const { document, preview } = fixture();
    document.tracks[0]!.clips[0]!.events.push({ id: 'first-master', at: 500, kind: 'ma2-fader', level: 0.625, executor: '99.219', fader: 'Master', label: '主推杆' });
    const prepared = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    const native = inspectMa2TimecodeXml(prepared.desiredXml).timecodes[0]!.tracks[0]!;
    expect(native.subtracks).toHaveLength(2);
    expect(native.subtracks[0]).toEqual(inspectMa2TimecodeXml(xml).timecodes[0]!.tracks[0]!.subtracks[0]);
    const confirmed = confirmMa2MergedEvents(prepared, prepared.desiredXml, [sequence]);
    expect(confirmed.mappings.find((entry) => entry.eventId === 'first-master')).toMatchObject({ action: 'master', path: 'Timecode:9901/Track:0/SubTrack:1/Event:0' });
    const project = createEmptyLinkProject('首次推杆'); project.schemaVersion = 2;
    project.rundown.push({ id: 'item', title: '节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: document });
    const next = applyMa2ReadbackCommand('item', 'binding', document, confirmed).execute(project).rundown[0]!.lighting!;
    expect(prepareMa2MergedEvents(next, 'binding', confirmed, new Map(), new Map(), [sequence]).desiredXml).toBe(prepared.desiredXml);
  });
  it.skipIf(!process.env.MA2_ONPC_FADER_SYNC_ACCEPTANCE)('Master 三方合并写入本机 onPC 并确认后还原专用测试对象', async () => {
    const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
    const original = await bridge.request('READ', 9902);
    const before = inspectMa2TimecodeXml(original);
    expect(before.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    try {
      const seeded = await bridge.request('APPLY', 9902, original, masterXml);
      const { document } = fixture(seeded);
      const fader = document.tracks[0]!.clips[0]!.events.find((event) => event.kind === 'ma2-fader' && event.level === 0.755);
      if (fader?.kind !== 'ma2-fader') throw new Error('缺少推杆样例');
      fader.at = 1000;
      const remoteXml = await bridge.request('APPLY', 9902, seeded, seeded.replace('fader_level="0.755"', 'fader_level="0.625"'));
      const remote = convertMa2Timecode(remoteXml, [sequence], 9902);
      const prepared = prepareMa2MergedEvents(document, 'binding', remote, new Map(), new Map(), [sequence]);
      await bridge.request('APPLY', 9902, prepared.expectedXml, prepared.desiredXml);
      const confirmed = confirmMa2MergedEvents(prepared, await bridge.request('READ', 9902), [sequence]);
      expect(confirmed.document.tracks[0]!.clips[0]!.events.find((event) => event.id === fader.id)).toMatchObject({ kind: 'ma2-fader', at: 1000, level: 0.625 });
      expect(inspectMa2TimecodeXml(confirmed.sourceXml).timecodes[0]!.tracks[0]!.subtracks[0]).toEqual(inspectMa2TimecodeXml(seeded).timecodes[0]!.tracks[0]!.subtracks[0]);
    } finally {
      const current = await bridge.request('READ', 9902);
      expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
      expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(before.timecodes);
    }
  }, 60000);
  it('混合 Cue 与 Master 轨道可修改、增删推杆点并回读稳定身份', () => {
    const { document, preview } = fixture(masterXml);
    const clip = document.tracks[0]!.clips[0]!;
    const fader = clip.events.find((event) => event.kind === 'ma2-fader' && event.level === 0.755);
    if (fader?.kind !== 'ma2-fader') throw new Error('缺少推杆样例');
    fader.at = 1000; fader.level = 0.625;
    clip.events = clip.events.filter((event) => event.kind !== 'ma2-fader' || event.id === fader.id);
    clip.events.push({ ...fader, id: 'added-master', at: 500, level: 0.125 });
    const cue = clip.events.find((event) => event.kind === 'ma2');
    if (!cue) throw new Error('缺少 Cue 样例');
    clip.events.push({ ...cue, id: 'added-cue', at: 2000 });
    clip.duration = 2100;
    const write = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    const native = inspectMa2TimecodeXml(write.desiredXml).timecodes[0]!.tracks[0]!;
    expect(native.subtracks[0]!.events).toHaveLength(3);
    expect(native.subtracks[1]!.events.map((event) => event.attributes)).toEqual([
      { index: '0', time: '15', fader_level: '0.125' }, { index: '1', time: '30', fader_level: '0.625' }
    ]);
    const confirmed = confirmMa2MergedEvents(write, write.desiredXml, [sequence]);
    expect(confirmed.document.tracks[0]!.clips[0]!.events.filter((event) => event.kind === 'ma2-fader')).toEqual([
      { id: 'added-master', kind: 'ma2-fader', at: 500, executor: '99.219', fader: 'Master', level: 0.125, label: '主推杆' },
      { ...fader, label: '主推杆' }
    ]);
    expect(() => confirmMa2MergedEvents(write, write.desiredXml.replace('fader_level="0.625"', 'fader_level="0.6"'), [sequence])).toThrow('回读与本次写入不一致');
    const project = createEmptyLinkProject('Master 同步'); project.schemaVersion = 2;
    project.rundown.push({ id: 'item', title: '节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: document });
    const next = applyMa2ReadbackCommand('item', 'binding', document, confirmed).execute(project).rundown[0]!.lighting!;
    const snapshots = snapshotMa2LightingBinding(next, 'binding', { consoleVersion: '3.3.4', baselineRevision: '1', localRevision: '2' });
    expect(sameMa2Content(snapshots.local, snapshots.base)).toBe(true);
  });
  it('明确绑定的新轨道参与合并，回读保留本地身份并移入基线', () => {
    const { document, preview } = fixture();
    const local = structuredClone(document.tracks[0]!); local.id = 'new-track'; local.name = '副歌';
    local.clips[0]!.id = 'new-clip'; local.clips[0]!.events = local.clips[0]!.events.slice(0, 1).map((event) => ({ ...event, id: 'new-event', at: 500 }));
    document.tracks.push(local);
    const project = createEmptyLinkProject('新增轨道'); project.schemaVersion = 2;
    project.rundown.push({ id: 'item', title: '节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: document });
    const command = bindMa2TrackCommand('item', 'binding', local.id, '99.219', preview.document.tracks[0]!.name);
    const mismatched = structuredClone(project);
    const fixedTrack = mismatched.rundown[0]!.lighting!.tracks[1]!;
    fixedTrack.clips = [];
    fixedTrack.cueStamp = { mode: 'fixed', executor: '1.1', sequence: 9901, cue: '1.250' };
    expect(() => command.execute(mismatched)).toThrow('固定 Cue 的执行器');
    expect(mismatched.rundown[0]!.lighting!.ma2Bindings![0]!.pendingTracks).toBeUndefined();
    fixedTrack.cueStamp.executor = '99.219';
    expect(command.execute(mismatched).rundown[0]!.lighting!.ma2Bindings![0]!.pendingTracks).toHaveLength(1);
    const bound = command.execute(project); const source = bound.rundown[0]!.lighting!;
    expect(command.undo(project)).toEqual(project);
    expect(parseLinkProject(JSON.parse(JSON.stringify(bound)))).toEqual(bound);
    expect(() => command.execute(bound)).toThrow('已经关联');
    expect(() => bindMa2TrackCommand('item', 'binding', local.id, '1.1', '错误').execute(project)).toThrow('执行器');
    const prepared = prepareMa2MergedEvents(source, 'binding', preview, new Map(), new Map(), [sequence]);
    const confirmed = confirmMa2MergedEvents(prepared, prepared.desiredXml, [sequence]);
    expect(confirmed.document.tracks[1]).toMatchObject({ id: local.id, clips: [{ events: [{ id: 'new-event', at: 500 }] }] });
    const consoleAlreadyChanged = convertMa2Timecode(prepared.desiredXml, [sequence], 9902);
    expect(() => prepareMa2MergedEvents(source, 'binding', consoleAlreadyChanged, new Map(), new Map(), [sequence])).toThrow('多个控台轨道');
    const separate = structuredClone(source);
    separate.ma2Bindings![0]!.pendingTracks![0]!.executor = '99.218';
    for (const event of separate.tracks[1]!.clips[0]!.events) if (event.kind === 'ma2') event.executor = '99.218';
    const separateWrite = prepareMa2MergedEvents(separate, 'binding', preview, new Map(), new Map(), [sequence]);
    expect(() => prepareMa2MergedEvents(separate, 'binding', convertMa2Timecode(separateWrite.desiredXml, [sequence], 9902), new Map(), new Map(), [sequence])).toThrow('避免重复创建');
    const next = applyMa2ReadbackCommand('item', 'binding', source, confirmed).execute(bound).rundown[0]!.lighting!;
    expect(next.tracks[1]).toMatchObject({ id: 'new-track', name: '副歌', clips: [{ id: 'new-clip' }] });
    expect(next.ma2Bindings![0]!.pendingTracks).toBeUndefined();
    expect(next.ma2Bindings![0]!.baselineTracks.map((track) => track.id)).toEqual(next.tracks.map((track) => track.id));
    const snapshots = snapshotMa2LightingBinding(next, 'binding', { consoleVersion: '3.3.4', baselineRevision: '1', localRevision: '2' });
    expect(snapshots.local.objects).toEqual(snapshots.base.objects);
  });
  it('删除绑定轨道后回读不保留失效轨道与事件映射', () => {
    const { document, preview } = fixture();
    document.tracks = [];
    const prepared = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    expect(prepared.trackPaths.size).toBe(0);
    expect(prepared.eventPaths.size).toBe(0);
    const confirmed = confirmMa2MergedEvents(prepared, prepared.desiredXml, []);
    expect(confirmed.document.tracks).toEqual([]);
    expect(confirmed.mappings).toEqual([]);
    expect(confirmed.trackMappings).toEqual([]);
  });
  it('删除前一轨道后保留后一轨道事件身份，远端修改与删除仍冲突', () => {
    const original = xml.match(/<Track\s[\s\S]*?<\/Track>/)?.[0];
    if (!original) throw new Error('测试轨道缺失');
    const source = xml.replace('</Timecode>', `${original.replace('index="0"', 'index="1"').replace('<No>219</No>', '<No>218</No>')}</Timecode>`);
    const preview = convertMa2Timecode(source, [sequence], 9902);
    const document = structuredClone(preview.document);
    document.ma2Bindings = [{ id: 'binding', timecode: 9902, name: preview.name, readAt: preview.readAt, sourceXml: source, baselineTracks: structuredClone(document.tracks), mappings: preview.mappings, trackMappings: preview.trackMappings }];
    const survivor = document.tracks[1]!;
    document.tracks.reverse();
    const reordered = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    const reorderedReadback = confirmMa2MergedEvents(reordered, reordered.desiredXml, [sequence]);
    expect(reorderedReadback.document.tracks.map((track) => track.id)).toEqual(document.tracks.map((track) => track.id));
    expect(reorderedReadback.document.tracks[0]!.clips[0]!.events.map((event) => event.id)).toEqual(survivor.clips[0]!.events.map((event) => event.id));
    document.tracks = [survivor];
    const result = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    const confirmed = confirmMa2MergedEvents(result, result.desiredXml, [sequence]);
    expect(confirmed.document.tracks).toHaveLength(1);
    expect(confirmed.document.tracks[0]!.id).toBe(survivor.id);
    expect(confirmed.document.tracks[0]!.clips[0]!.events.map((event) => event.id)).toEqual(survivor.clips[0]!.events.map((event) => event.id));
    expect(confirmed.trackMappings![0]!.path).toBe('Timecode:9901/Track:0');
    const changed = convertMa2Timecode(source.replace('<Event index="0"', '<Event time="15" index="0"'), [sequence], 9902);
    expect(() => prepareMa2MergedEvents(document, 'binding', changed, new Map(), new Map(), [sequence])).toThrow('冲突');
  });
  it('节目标注不改控台名称，新点按真实 Cue 名称编译并确认', () => {
    const { document, preview } = fixture();
    document.tracks[0]!.name = '副歌灯光';
    const clip = document.tracks[0]!.clips[0]!;
    const event = clip.events[0]!;
    if (event.kind !== 'ma2') throw new Error('样例事件类型错误');
    event.label = '副歌第一拍';
    const renamed = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    expect(renamed.desiredXml).toBe(renamed.expectedXml);
    const confirmed = confirmMa2MergedEvents(renamed, renamed.desiredXml, [sequence]);
    expect(confirmed.document.tracks[0]!.name).toBe(preview.document.tracks[0]!.name);
    expect(confirmed.document.tracks[0]!.clips[0]!.events[0]).toMatchObject({ label: 'Cue 1.25' });
    clip.events.push({ ...event, id: 'local-annotation', at: 500, label: '灯光 3' });
    const added = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    expect(confirmMa2MergedEvents(added, added.desiredXml, [sequence]).document.tracks[0]!.clips[0]!.events.find((entry) => entry.id === 'local-annotation')).toMatchObject({ label: 'Cue 1.25', at: 500 });
  });
  it('轨道静音和事件移动一起写回，保持引用与事件身份', () => {
    const { document, preview } = fixture();
    const track = document.tracks[0]!;
    track.muted = true; track.clips[0]!.events[0]!.at = 500;
    const result = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    const confirmed = confirmMa2MergedEvents(result, result.desiredXml, [sequence]);
    expect(confirmed.document.tracks[0]).toMatchObject({ id: track.id, muted: true });
    expect(confirmed.document.tracks[0]!.clips[0]!.events[0]).toMatchObject({ id: track.clips[0]!.events[0]!.id, at: 500 });
    expect(inspectMa2TimecodeXml(result.desiredXml).timecodes[0]!.tracks[0]!.executorAddress).toEqual(['30', '1', '99', '219']);
  });
  it('删除最后一个点仍保留轨道身份，空轨道可以继续添加 Cue', () => {
    const { document, preview } = fixture();
    document.tracks[0]!.clips[0]!.events = [];
    const cleared = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    const confirmed = confirmMa2MergedEvents(cleared, cleared.desiredXml, []);
    expect(confirmed.document.tracks[0]?.id).toBe(document.tracks[0]?.id);
    expect(confirmed.document.tracks[0]?.clips[0]?.events).toEqual([]);
    expect(confirmed.trackMappings?.[0]).toMatchObject({ trackId: document.tracks[0]!.id, executor: '99.219', subtracks: ['Timecode:9901/Track:0/SubTrack:0'] });
    const next = structuredClone(confirmed.document);
    next.ma2Bindings = [{ id: 'binding', timecode: 9902, name: confirmed.name, readAt: confirmed.readAt, sourceXml: confirmed.sourceXml, baselineTracks: structuredClone(next.tracks), mappings: confirmed.mappings, trackMappings: confirmed.trackMappings }];
    const legacy = structuredClone(next); delete legacy.ma2Bindings![0]!.trackMappings;
    const legacyReadback = structuredClone(confirmed); delete legacyReadback.trackMappings;
    const recovered = prepareMa2MergedEvents(legacy, 'binding', legacyReadback, new Map(), new Map(), []);
    expect(confirmMa2MergedEvents(recovered, recovered.desiredXml, []).document.tracks[0]?.id).toBe(next.tracks[0]!.id);
    const clip = next.tracks[0]!.clips[0]!; clip.duration = 2000;
    clip.events.push({ id: 'added-after-clear', kind: 'ma2', at: 500, action: 'goto', cue: '1.250', sequence: 9901, executor: '99.219', label: 'Cue 1.25' });
    const added = prepareMa2MergedEvents(next, 'binding', confirmed, new Map(), new Map(), [sequence]);
    expect(confirmMa2MergedEvents(added, added.desiredXml, [sequence]).document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ id: 'added-after-clear', action: 'goto', at: 500 });
  });
  it('Goto 改为执行器动作后可回读，纯动作轨道不需要伪造序列', () => {
    const { document, preview } = fixture();
    const events = document.tracks[0]!.clips[0]!.events;
    for (const [index, event] of events.entries()) {
      if (event.kind !== 'ma2') throw new Error('样例事件类型错误');
      event.action = index === 0 ? 'go' : 'off'; event.label = '本地标注';
      delete event.cue; delete event.sequence;
    }
    const result = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    const confirmed = confirmMa2MergedEvents(result, result.desiredXml, []);
    expect(confirmed.mappings.map((mapping) => [mapping.action, mapping.sequence, mapping.cueIndex])).toEqual([['go', null, null], ['off', null, null]]);
    expect(confirmed.document.tracks[0]?.clips[0]?.events.map((event) => event.id)).toEqual(events.map((event) => event.id));
    const next = structuredClone(confirmed.document);
    next.ma2Bindings = [{ id: 'binding', timecode: 9902, name: confirmed.name, readAt: confirmed.readAt, sourceXml: confirmed.sourceXml, baselineTracks: structuredClone(next.tracks), mappings: confirmed.mappings }];
    next.tracks[0]!.clips[0]!.events[0]!.at = 500;
    const moved = prepareMa2MergedEvents(next, 'binding', confirmed, new Map(), new Map(), [confirmed.sourceXml]);
    expect(confirmMa2MergedEvents(moved, moved.desiredXml, []).document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ action: 'go', at: 500 });
  });
  it('双方独立时间修改合并为 XML，回读路径关联稳定事件 ID', () => {
    const { document } = fixture();
    const first = document.tracks[0]!.clips[0]!.events[0]!;
    first.at = 500;
    const remote = convertMa2Timecode(xml.replace('time="45"', 'time="60"'), [sequence], 9902);
    const result = prepareMa2MergedEvents(document, 'binding', remote, new Map(), new Map(), [sequence]);
    const converted = convertMa2Timecode(result.desiredXml, [sequence], 9902);
    expect(converted.document.tracks[0]?.clips[0]?.events.map((event) => event.at)).toEqual([500, 2000]);
    expect(result.eventPaths.get(first.id)).toBe('Timecode:9901/Track:0/SubTrack:0/Event:0');
  });
  it('删除和重复新增同 Cue 后仍能准确更新每个点的映射', () => {
    const { document, preview } = fixture();
    const clip = document.tracks[0]!.clips[0]!;
    const first = clip.events[0]!; const deleted = clip.events[1]!.id;
    clip.events = [{ ...first, at: 3000 }, { ...first, id: 'added', at: 500 }, { ...first, id: 'duplicate', at: 500 }];
    clip.duration = 4000;
    const result = prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence]);
    const prefix = 'Timecode:9901/Track:0/SubTrack:0/Event:';
    expect(result.eventPaths.get(first.id)).toBe(`${prefix}2`);
    expect(result.eventPaths.get('added')).toBe(`${prefix}0`);
    expect(result.eventPaths.get('duplicate')).toBe(`${prefix}1`);
    expect(result.eventPaths.has(deleted)).toBe(false);
    expect(inspectMa2TimecodeXml(result.desiredXml).timecodes[0]?.tracks[0]?.subtracks[0]?.events).toHaveLength(3);
    const confirmed = confirmMa2MergedEvents(result, result.desiredXml, [sequence]);
    expect(confirmed.document.tracks[0]?.id).toBe(document.tracks[0]?.id);
    expect(confirmed.document.tracks[0]?.clips[0]?.events.map((event) => event.id)).toEqual(['added', 'duplicate', first.id]);
    expect(confirmed.mappings.map((mapping) => mapping.eventId)).toEqual(['added', 'duplicate', first.id]);
    expect(() => confirmMa2MergedEvents(result, xml, [sequence])).toThrow('回读');
    const invalid = { ...result, eventPaths: new Map(result.eventPaths) }; invalid.eventPaths.delete(first.id);
    expect(() => confirmMa2MergedEvents(invalid, result.desiredXml, [sequence])).toThrow('映射');
  });
  it('未处理冲突不能编译，保留本地或控台生成对应时间', () => {
    const { document } = fixture();
    const event = document.tracks[0]!.clips[0]!.events[1]!;
    event.at = 3000;
    document.tracks[0]!.clips[0]!.duration = 4000;
    const remote = convertMa2Timecode(xml.replace('time="45"', 'time="60"'), [sequence], 9902);
    expect(() => prepareMa2MergedEvents(document, 'binding', remote, new Map(), new Map(), [sequence])).toThrow('冲突');
    for (const [choice, ticks] of [['local', '90'], ['remote', '60']] as const) {
      const result = prepareMa2MergedEvents(document, 'binding', remote, new Map(), new Map([[event.id, choice]]), [sequence]);
      expect(inspectMa2TimecodeXml(result.desiredXml).timecodes[0]?.tracks[0]?.subtracks[0]?.events[1]?.attributes.time).toBe(ticks);
    }
  });
  it('静音片段、子帧时间和不存在的 Cue 不得部分生成', () => {
    for (const change of ['action', 'time', 'cue'] as const) {
      const { document, preview } = fixture();
      const event = document.tracks[0]!.clips[0]!.events[0]!;
      if (event.kind !== 'ma2') throw new Error('样例事件类型错误');
      if (change === 'action') document.tracks[0]!.clips[0]!.muted = true;
      if (change === 'time') event.at = 1;
      if (change === 'cue') event.cue = '2';
      expect(() => prepareMa2MergedEvents(document, 'binding', preview, new Map(), new Map(), [sequence])).toThrow();
    }
  });
});
