import { expect, it } from 'vitest';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { editMa2TimecodeEvents, editMa2TrackStates, inspectMa2TimecodeXml, patchMa2EventTimes } from './ma2-timecode-xml';
import { convertMa2Snapshot, convertMa2Timecode } from './ma2-timecode-conversion';
import { confirmMa2MergedEvents, prepareMa2MergedEvents } from './ma2-event-write';
import { Ma2ApplyService } from './ma2-apply-service';
import { createEmptyLinkProject } from '@tb/schema';
import { applyMa2ReadbackCommand, bindMa2TrackCommand, nextLightingCue } from '@tb/core/link';
import { appendMa2Tracks, removeMa2Tracks } from './ma2-track-write';

it.skipIf(!process.env.MA2_ONPC_TRACK_ACCEPTANCE)('节目新增轨道经绑定、完整同步与基线回读后不重复创建', async () => {
  const directory = process.env.MA2_ONPC_DATA_DIRECTORY ?? '';
  const bridge = new Ma2OnpcBridge(directory, () => false);
  const original = await bridge.request('READ', 9902);
  const report = inspectMa2TimecodeXml(original);
  expect(report.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  const preview = convertMa2Snapshot(await bridge.request('SNAPSHOT', 9902), 9902);
  const document = structuredClone(preview.document);
  document.ma2Bindings = [{ id: 'new-track-binding', timecode: 9902, name: preview.name, readAt: preview.readAt, sourceXml: preview.sourceXml, baselineTracks: structuredClone(document.tracks), mappings: preview.mappings, trackMappings: preview.trackMappings, cueCatalog: preview.cueCatalog }];
  const local = { ...structuredClone(document.tracks[0]!), id: 'added-lane', name: '新增副歌轨道', clips: [] };
  document.tracks.push(local);
  const project = createEmptyLinkProject('新增轨道验收'); project.schemaVersion = 2;
  project.rundown.push({ id: 'item', title: '节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: document });
  const bound = bindMa2TrackCommand('item', 'new-track-binding', local.id, '99.219', preview.document.tracks[0]!.name).execute(project);
  const source = bound.rundown[0]!.lighting!;
  const track = source.tracks.find((entry) => entry.id === local.id)!;
  const cue = nextLightingCue(source, track, 500);
  expect(cue).toMatchObject({ sequence: 9901, executor: '99.219', cue: '1.250' });
  track.clips.push({ id: 'new-clip', name: '副歌', start: 0, duration: 2000, timeLock: 'time', muted: false, events: [{ id: 'added-cue', kind: 'ma2', action: 'goto', at: 500, ...cue }] });
  const service = new Ma2ApplyService(bridge, () => false);
  try {
    const result = await service.apply({ dataDirectory: directory, document: source, bindingId: 'new-track-binding', readback: preview, choices: [], conflicts: [] });
    if (result.status !== 'verified') throw new Error(JSON.stringify(result));
    expect(result.confirmed.document.tracks.at(-1)).toMatchObject({ id: local.id, clips: [{ events: [{ id: 'added-cue', at: 500, cue: '1.250' }] }] });
    const next = applyMa2ReadbackCommand('item', 'new-track-binding', source, result.confirmed).execute(bound).rundown[0]!.lighting!;
    expect(next.ma2Bindings![0]!.pendingTracks).toBeUndefined();
    expect(next.tracks.at(-1)?.name).toBe('新增副歌轨道');
    expect(await service.apply({ dataDirectory: directory, document: next, bindingId: 'new-track-binding', readback: result.confirmed, choices: [], conflicts: [] })).toMatchObject({ status: 'verified', backupFile: null });
  } finally {
    const current = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(report.timecodes);
  }
}, 60000);

it.skipIf(!process.env.MA2_ONPC_TRACK_ACCEPTANCE)('专用 Timecode 新增执行器轨道与 Cue，空对象重新创建后还原', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const original = await bridge.request('READ', 9902);
  const report = inspectMa2TimecodeXml(original);
  expect(report.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  const first = report.timecodes[0]!.tracks[0];
  if (!first?.executorName || first.executorAddress.join('.') !== '30.1.99.219') throw new Error('专用测试执行器不一致');
  const addition = { executor: '99.219', executorName: first.executorName, muted: false };
  try {
    const appended = appendMa2Tracks(original, 9902, [addition]);
    const subtrackPath = `${appended.paths[0]}/SubTrack:0`;
    const desired = editMa2TimecodeEvents(appended.xml, inspectMa2TimecodeXml(appended.xml).sha256, 9902, [
      { kind: 'add', subtrackPath, rawTime: '15', cue: { sequence: 9901, cueIndex: 1, name: 'Cue 1.25' } },
      { kind: 'add', subtrackPath, rawTime: '45', executorAction: 'off' },
      { kind: 'add', subtrackPath, rawTime: '90', executorAction: 'go' }
    ]);
    await bridge.request('APPLY', 9902, original, desired);
    const preview = convertMa2Snapshot(await bridge.request('SNAPSHOT', 9902), 9902);
    expect(preview.unconverted).toEqual([]);
    expect(preview.document.tracks).toHaveLength(report.timecodes[0]!.tracks.length + 1);
    expect(inspectMa2TimecodeXml(preview.sourceXml).timecodes[0]!.tracks[0]).toEqual(first);
    expect(preview.document.tracks.at(-1)).toMatchObject({ muted: false, clips: [{ events: [
      { at: 500, action: 'goto', sequence: 9901, cue: '1.250', executor: '99.219' },
      { at: 1500, action: 'off', executor: '99.219' },
      { at: 3000, action: 'go', executor: '99.219' }
    ] }] });
    const current = await bridge.request('READ', 9902);
    const empty = removeMa2Tracks(current, 9902, inspectMa2TimecodeXml(current).timecodes[0]!.tracks.map((track) => `Timecode:9901/Track:${track.index}`)).xml;
    await bridge.request('APPLY', 9902, current, empty);
    const emptyReadback = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(emptyReadback).timecodes[0]!.tracks).toHaveLength(0);
    const recreated = appendMa2Tracks(emptyReadback, 9902, [{ ...addition, muted: true }]);
    const checked = await bridge.request('APPLY', 9902, emptyReadback, recreated.xml);
    expect(inspectMa2TimecodeXml(checked).timecodes[0]!.tracks).toMatchObject([{ index: 0, executorAddress: ['30', '1', '99', '219'], subtracks: [{ events: [] }] }]);
    const mutedPreview = convertMa2Timecode(checked, [], 9902);
    expect(mutedPreview.document.tracks[0]?.muted).toBe(true);
  } finally {
    const current = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(report.timecodes);
  }
}, 60000);

it.skipIf(!process.env.MA2_ONPC_TRACK_ACCEPTANCE)('专用多轨 Timecode 排序、删除后保留轨道身份并还原', async () => {
  const directory = process.env.MA2_ONPC_DATA_DIRECTORY ?? '';
  const bridge = new Ma2OnpcBridge(directory, () => false);
  const original = await bridge.request('READ', 9902);
  const report = inspectMa2TimecodeXml(original);
  expect(report.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  expect(report.timecodes[0]!.tracks).toHaveLength(1);
  const trackXml = original.match(/<Track\s[\s\S]*?<\/Track>/)?.[0];
  if (!trackXml) throw new Error('专用测试轨道缺失');
  const expanded = original.replace('</Timecode>', `${trackXml.replace('index="0"', 'index="1"').replace('time="45"', 'time="90"').replace('<Event index="0"', '<Event time="30" index="0"')}</Timecode>`);
  try {
    await bridge.request('APPLY', 9902, original, expanded);
    let preview = convertMa2Snapshot(await bridge.request('SNAPSHOT', 9902), 9902);
    expect(preview.document.tracks).toHaveLength(2);
    let document = structuredClone(preview.document);
    document.ma2Bindings = [{ id: 'multi-delete', timecode: 9902, name: preview.name, readAt: preview.readAt, sourceXml: preview.sourceXml, baselineTracks: structuredClone(document.tracks), mappings: preview.mappings, trackMappings: preview.trackMappings }];
    document.tracks.reverse();
    const beforeMute = await bridge.request('READ', 9902);
    const remoteMuted = editMa2TrackStates(beforeMute, 9902, [{ path: 'Timecode:9901/Track:0', muted: true }]);
    await bridge.request('APPLY', 9902, beforeMute, remoteMuted);
    preview = convertMa2Snapshot(await bridge.request('SNAPSHOT', 9902), 9902);
    const service = new Ma2ApplyService(bridge, () => false);
    const sorted = await service.apply({ dataDirectory: directory, document, bindingId: 'multi-delete', readback: preview, choices: [], conflicts: [] });
    if (sorted.status !== 'verified') throw new Error(JSON.stringify(sorted));
    expect(sorted.confirmed.document.tracks.map((track) => track.id)).toEqual(document.tracks.map((track) => track.id));
    expect(sorted.confirmed.document.tracks.map((track) => track.muted)).toEqual([false, true]);
    const project = createEmptyLinkProject('轨道排序验收'); project.schemaVersion = 2;
    project.rundown.push({ id: 'item', title: '验收', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: document });
    document = applyMa2ReadbackCommand('item', 'multi-delete', document, sorted.confirmed).execute(project).rundown[0]!.lighting!;
    preview = sorted.confirmed;
    expect(await service.apply({ dataDirectory: directory, document, bindingId: 'multi-delete', readback: preview, choices: [], conflicts: [] })).toMatchObject({ status: 'verified', backupFile: null });
    const survivor = document.tracks[1]!;
    document.tracks = [survivor];
    const result = await new Ma2ApplyService(bridge, () => false).apply({ dataDirectory: directory, document, bindingId: 'multi-delete', readback: preview, choices: [], conflicts: [] });
    if (result.status !== 'verified') throw new Error(JSON.stringify(result));
    expect(result.confirmed.document.tracks).toHaveLength(1);
    expect(result.confirmed.document.tracks[0]!.id).toBe(survivor.id);
    expect(result.confirmed.document.tracks[0]!.clips[0]!.events).toEqual(survivor.clips[0]!.events);
    expect(result.confirmed.trackMappings![0]!.path).toBe('Timecode:9901/Track:0');
  } finally {
    const current = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(report.timecodes);
  }
}, 60000);

it.skipIf(!process.env.MA2_ONPC_TRACK_ACCEPTANCE)('专用 Timecode 删除全部轨道后回读并还原', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const original = await bridge.request('READ', 9902);
  const report = inspectMa2TimecodeXml(original);
  expect(report.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  const desired = removeMa2Tracks(original, 9902, report.timecodes[0]!.tracks.map((track) => `Timecode:9901/Track:${track.index}`));
  const preview = convertMa2Snapshot(await bridge.request('SNAPSHOT', 9902), 9902);
  const document = structuredClone(preview.document);
  document.ma2Bindings = [{ id: 'delete-track', timecode: 9902, name: preview.name, readAt: preview.readAt, sourceXml: original, baselineTracks: structuredClone(document.tracks), mappings: preview.mappings, trackMappings: preview.trackMappings }];
  document.tracks = [];
  const service = new Ma2ApplyService(bridge, () => false);
  try {
    const request = { dataDirectory: process.env.MA2_ONPC_DATA_DIRECTORY ?? '', document, bindingId: 'delete-track', readback: preview, choices: [], conflicts: [] };
    const result = await service.apply(request);
    if (result.status !== 'verified') throw new Error(JSON.stringify(result));
    expect(inspectMa2TimecodeXml(result.confirmed.sourceXml).timecodes).toEqual(inspectMa2TimecodeXml(desired.xml).timecodes);
    const project = createEmptyLinkProject('轨道删除验收'); project.schemaVersion = 2;
    project.rundown.push({ id: 'item', title: '验收', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: document });
    const next = applyMa2ReadbackCommand('item', 'delete-track', document, result.confirmed).execute(project).rundown[0]!.lighting!;
    expect(next.tracks).toEqual([]);
    expect(next.ma2Bindings![0]!.baselineTracks).toEqual([]);
    expect(await service.apply({ ...request, document: next, readback: result.confirmed })).toMatchObject({ status: 'verified', backupFile: null });
  } finally {
    const current = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(report.timecodes);
  }
}, 60000);

it.skipIf(!process.env.MA2_ONPC_EMPTY_ACCEPTANCE)('空灯光轨道完成清空、节目基线更新、重新打点与还原', async () => {
  const directory = process.env.MA2_ONPC_DATA_DIRECTORY ?? '';
  const bridge = new Ma2OnpcBridge(directory, () => false);
  const original = await bridge.request('READ', 9902);
  const report = inspectMa2TimecodeXml(original);
  expect(report.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  const preview = convertMa2Snapshot(await bridge.request('SNAPSHOT', 9902), 9902);
  const document = structuredClone(preview.document);
  document.ma2Bindings = [{ id: 'empty-binding', timecode: 9902, name: preview.name, readAt: preview.readAt, sourceXml: preview.sourceXml, baselineTracks: structuredClone(document.tracks), mappings: preview.mappings, trackMappings: preview.trackMappings, cueCatalog: preview.cueCatalog }];
  document.tracks[0]!.clips[0]!.events = [];
  document.tracks[0]!.name = '副歌灯光轨道';
  const service = new Ma2ApplyService(bridge, () => false);
  const request = { dataDirectory: directory, document, bindingId: 'empty-binding', readback: preview, choices: [], conflicts: [] };
  const project = createEmptyLinkProject('空轨道验收'); project.schemaVersion = 2;
  project.rundown.push({ id: 'item', title: '验收', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: document });
  try {
    const cleared = await service.apply(request);
    if (cleared.status !== 'verified') throw new Error(JSON.stringify(cleared));
    expect(cleared.confirmed.document.tracks[0]?.clips[0]?.events).toEqual([]);
    expect(cleared.confirmed.document.tracks[0]?.id).toBe(document.tracks[0]!.id);
    const updated = applyMa2ReadbackCommand('item', 'empty-binding', document, cleared.confirmed).execute(project);
    const next = updated.rundown[0]!.lighting!;
    expect(next.tracks[0]!.name).toBe('副歌灯光轨道');
    expect(next.ma2Bindings![0]!.baselineTracks[0]!.name).toBe(preview.document.tracks[0]!.name);
    expect(next.ma2Bindings?.[0]?.trackMappings?.[0]).toMatchObject({ trackId: document.tracks[0]!.id, executor: '99.219', subtracks: ['Timecode:9901/Track:0/SubTrack:0'] });
    expect(await service.apply({ ...request, document: next, readback: cleared.confirmed })).toMatchObject({ status: 'verified', backupFile: null });
    const emptyXml = await bridge.request('READ', 9902);
    const scoped = await bridge.request('SCOPE', 9902, '9901');
    const changedSequence = scoped.replace('sub_number="250"', 'sub_number="251"');
    expect(changedSequence).not.toBe(scoped);
    const expectedWrite = editMa2TimecodeEvents(emptyXml, inspectMa2TimecodeXml(emptyXml).sha256, 9902, [{ kind: 'add', subtrackPath: 'Timecode:9901/Track:0/SubTrack:0', rawTime: '15', cue: { sequence: 9901, cueIndex: 1, name: 'Cue 1.25' } }]);
    await expect(bridge.request('SYNC', 9902, changedSequence, expectedWrite)).rejects.toThrow('Sequence changed');
    expect(inspectMa2TimecodeXml(await bridge.request('READ', 9902)).timecodes).toEqual(inspectMa2TimecodeXml(emptyXml).timecodes);
    expect(nextLightingCue(next, next.tracks[0]!, 500)).toMatchObject({ cue: '1.250', sequence: 9901 });
    next.tracks[0]!.clips[0]!.events.push({ id: 'after-empty', kind: 'ma2', at: 500, action: 'goto', ...nextLightingCue(next, next.tracks[0]!, 500), label: '副歌第一拍' });
    const added = await service.apply({ ...request, document: next, readback: cleared.confirmed });
    if (added.status !== 'verified') throw new Error(JSON.stringify(added));
    expect(added.confirmed.document.tracks[0]?.clips[0]?.events).toMatchObject([{ id: 'after-empty', at: 500, action: 'goto', cue: '1.250', sequence: 9901 }]);
    expect(added.confirmed.document.tracks[0]?.id).toBe(document.tracks[0]!.id);
    const annotated = applyMa2ReadbackCommand('item', 'empty-binding', next, added.confirmed).execute(updated);
    const annotatedDocument = annotated.rundown[0]!.lighting!;
    expect(annotatedDocument.tracks[0]!.clips[0]!.events[0]).toMatchObject({ label: '副歌第一拍' });
    expect(nextLightingCue(annotatedDocument, annotatedDocument.tracks[0]!, 1000)).toMatchObject({ cue: '7.500', sequence: 9901 });
    expect(await service.apply({ ...request, document: annotatedDocument, readback: added.confirmed })).toMatchObject({ status: 'verified', backupFile: null });
  } finally {
    const current = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(report.timecodes);
  }
}, 60000);

it('拒绝相对目录与播放期间写入', async () => {
  expect(() => new Ma2OnpcBridge('relative', () => false)).toThrow('绝对路径');
  const bridge = new Ma2OnpcBridge(process.cwd(), () => true);
  await expect(bridge.request('APPLY', 1)).rejects.toThrow('播放期间');
  await expect(bridge.request('SYNC', 1)).rejects.toThrow('播放期间');
  await expect(bridge.request('READ', -1)).rejects.toThrow('编号');
  for (const scope of ['', '0', '-1', '1,1', '100000', '1,,2', '1;2']) await expect(bridge.request('SCOPE', 1, scope)).rejects.toThrow('范围');
});

it.skipIf(!process.env.MA2_ONPC_DATA_DIRECTORY)('本机 onPC 自动插件版本与 Timecode 回读', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  expect(await bridge.request('PING', 9901)).toMatch(/^3\./);
  const xml = await bridge.request('READ', 9901);
  expect(inspectMa2TimecodeXml(xml).timecodes[0]?.index).toBe(9900);
  const snapshot = await bridge.request('SNAPSHOT', 9901);
  expect(inspectMa2TimecodeXml(snapshot).timecodes[0]?.index).toBe(9900);
}, 35000);

it.skipIf(!process.env.MA2_ONPC_DATA_DIRECTORY)('本机插件连续交接请求不会因读取共享文件阻止下一个请求', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  for (let index = 0; index < 40; index += 1) expect(await bridge.request('PING', 9902)).toMatch(/^3\./);
}, 20000);

it.skipIf(!process.env.MA2_ONPC_WRITE_ACCEPTANCE)('专属测试 Timecode 自动备份、修改、回读和还原', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const original = await bridge.request('READ', 9901);
  const report = inspectMa2TimecodeXml(original);
  expect(report.timecodes[0]?.attributes.name).toBe('TBLINK_ONPC_ACCEPTANCE');
  const event = report.timecodes[0]?.tracks[0]?.subtracks[0]?.events[1];
  if (!event) throw new Error('测试事件不存在');
  const rawTime = String(Number(event.attributes.time ?? 0) + 1);
  const desired = patchMa2EventTimes(original, report.sha256, [{ path: event.path, rawTime }]);
  try {
    const readback = await bridge.request('APPLY', 9901, original, desired);
    const next = inspectMa2TimecodeXml(readback);
    expect(next.timecodes[0]?.tracks[0]?.subtracks[0]?.events[1]?.attributes.time).toBe(rawTime);
  } finally {
    const current = await bridge.request('READ', 9901);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_ONPC_ACCEPTANCE');
    const restored = await bridge.request('APPLY', 9901, current, original);
    const result = inspectMa2TimecodeXml(restored);
    expect(result.timecodes).toEqual(report.timecodes);
  }
}, 60000);

it.skipIf(!process.env.MA2_ONPC_WRITE_ACCEPTANCE)('本机同步服务完成写入核对、节目更新与基线再比较', async () => {
  const directory = process.env.MA2_ONPC_DATA_DIRECTORY ?? '';
  const bridge = new Ma2OnpcBridge(directory, () => false);
  const original = await bridge.request('READ', 9902);
  const before = inspectMa2TimecodeXml(original);
  expect(before.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  const readback = convertMa2Timecode(original, [await bridge.request('SNAPSHOT', 9902)], 9902);
  const document = structuredClone(readback.document);
  document.ma2Bindings = [{ id: 'service-binding', timecode: 9902, name: readback.name, readAt: readback.readAt, sourceXml: original, baselineTracks: structuredClone(document.tracks), mappings: structuredClone(readback.mappings) }];
  document.tracks[0]!.clips[0]!.events[0]!.at = 517;
  document.tracks[0]!.muted = true;
  const service = new Ma2ApplyService(bridge, () => false);
  try {
    const result = await service.apply({ dataDirectory: directory, document, bindingId: 'service-binding', readback, choices: [], conflicts: [], timeAlignment: 'nearest-frame' });
    if (result.status !== 'verified') throw new Error(JSON.stringify(result));
    expect(result.backupFile).toMatch(/^tblink_backup_[a-f0-9]{32}\.xml$/);
    const project = createEmptyLinkProject('同步服务验收'); project.schemaVersion = 2;
    project.rundown.push({ id: 'test-item', title: '验收', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: document });
    const updated = applyMa2ReadbackCommand('test-item', 'service-binding', document, result.confirmed).execute(project);
    const next = updated.rundown[0]!.lighting!;
    expect(next.tracks[0]!.clips[0]!.events[0]!.at).toBe(16000 / 30);
    expect(next.ma2Bindings![0]!.baselineTracks[0]!.clips[0]!.events[0]!.at).toBe(16000 / 30);
    const unchanged = await service.apply({ dataDirectory: directory, document: next, bindingId: 'service-binding', readback: result.confirmed, choices: [], conflicts: [] });
    expect(unchanged).toMatchObject({ status: 'verified', backupFile: null });
    expect(next.tracks[0]!.muted).toBe(true);
    expect(inspectMa2TimecodeXml(await bridge.request('READ', 9902)).timecodes[0]!.tracks[0]!.attributes.active).toBeUndefined();
    next.tracks[0]!.muted = false;
    const unmuted = await service.apply({ dataDirectory: directory, document: next, bindingId: 'service-binding', readback: result.confirmed, choices: [], conflicts: [] });
    if (unmuted.status !== 'verified') throw new Error(JSON.stringify(unmuted));
    expect(unmuted.confirmed.document.tracks[0]!.muted).toBe(false);
    expect(inspectMa2TimecodeXml(await bridge.request('READ', 9902)).timecodes[0]!.tracks[0]!.attributes.active).toBe('true');

  } finally {
    const current = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(before.timecodes);
  }
}, 60000);

it.skipIf(!process.env.MA2_ONPC_REFERENCE_ACCEPTANCE)('本机小数 Cue 实际引用转换与执行器、时间一致', async () => {
  const directory = process.env.MA2_ONPC_DATA_DIRECTORY ?? '';
  const bridge = new Ma2OnpcBridge(directory, () => false);
  const xml = await bridge.request('READ', 9902);
  expect(inspectMa2TimecodeXml(xml).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  const snapshot = await bridge.request('SNAPSHOT', 9902);
  const result = convertMa2Timecode(snapshot, [snapshot], 9902);
  expect(result.unconverted).toEqual([]);
  expect(result.document.tracks[0]?.clips[0]?.events).toMatchObject([
    { at: 0, sequence: 9901, executor: '99.219', cue: '1.250' },
    { at: 1500, sequence: 9901, executor: '99.219', cue: '7.500' }
  ]);
}, 20000);

it.skipIf(!process.env.MA2_ONPC_ACTION_ACCEPTANCE)('执行器动作完成服务同步、节目保存、再次同步和控台移动回读', async () => {
  const directory = process.env.MA2_ONPC_DATA_DIRECTORY ?? '';
  const bridge = new Ma2OnpcBridge(directory, () => false);
  const original = await bridge.request('READ', 9902);
  const before = inspectMa2TimecodeXml(original);
  expect(before.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  const readback = convertMa2Snapshot(await bridge.request('SNAPSHOT', 9902), 9902);
  const document = structuredClone(readback.document);
  document.ma2Bindings = [{ id: 'action-binding', timecode: 9902, name: readback.name, readAt: readback.readAt, sourceXml: readback.sourceXml, baselineTracks: structuredClone(document.tracks), mappings: structuredClone(readback.mappings) }];
  for (const [index, event] of document.tracks[0]!.clips[0]!.events.entries()) {
    if (event.kind !== 'ma2') throw new Error('测试事件类型不正确');
    event.action = index === 0 ? 'go' : 'off'; event.label = `自定义动作 ${index}`;
    delete event.cue; delete event.sequence;
  }
  const service = new Ma2ApplyService(bridge, () => false);
  try {
    const request = { dataDirectory: directory, document, bindingId: 'action-binding', readback, choices: [], conflicts: [] };
    const result = await service.apply(request);
    if (result.status !== 'verified') throw new Error(JSON.stringify(result));
    expect(result.confirmed.mappings.map((mapping) => [mapping.action, mapping.sequence, mapping.cueIndex])).toEqual([['go', null, null], ['off', null, null]]);
    const project = createEmptyLinkProject('执行器同步验收'); project.schemaVersion = 2;
    project.rundown.push({ id: 'item', title: '验收', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: document });
    const command = applyMa2ReadbackCommand('item', 'action-binding', document, result.confirmed);
    const updated = command.execute(project);
    const next = updated.rundown[0]!.lighting!;
    expect(next.tracks[0]!.clips[0]!.events).toMatchObject([{ action: 'go', label: '自定义动作 0' }, { action: 'off', label: '自定义动作 1' }]);
    expect(command.undo(project)).toEqual(project);
    expect(await service.apply({ ...request, document: next, readback: result.confirmed })).toMatchObject({ status: 'verified', backupFile: null });
    const current = await bridge.request('READ', 9902);
    const path = inspectMa2TimecodeXml(current).timecodes[0]!.tracks[0]!.subtracks[0]!.events[1]!.path;
    const changed = editMa2TimecodeEvents(current, inspectMa2TimecodeXml(current).sha256, 9902, [{ kind: 'update', path, rawTime: '60' }]);
    await bridge.request('APPLY', 9902, current, changed);
    const remote = convertMa2Snapshot(await bridge.request('SNAPSHOT', 9902), 9902);
    const pulled = await service.apply({ ...request, document: next, readback: remote });
    if (pulled.status !== 'verified') throw new Error(JSON.stringify(pulled));
    expect(pulled.backupFile).toBeNull();
    const merged = applyMa2ReadbackCommand('item', 'action-binding', next, pulled.confirmed).execute(updated);
    expect(merged.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events[1]).toMatchObject({ action: 'off', at: 2000, label: '自定义动作 1' });
  } finally {
    const current = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(before.timecodes);
  }
}, 60000);

it.skipIf(!process.env.MA2_ONPC_PRECISION_ACCEPTANCE)('本机 Timecode 子帧精度探针并还原', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const original = await bridge.request('READ', 9902);
  const before = inspectMa2TimecodeXml(original);
  expect(before.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  const results: Array<{ requested: string; actual: string; exact: boolean }> = [];
  try {
    for (const requested of ['45.03', '45.5', '45.9999', '0.03', '0.001']) {
      const current = await bridge.request('READ', 9902);
      const report = inspectMa2TimecodeXml(current);
      const path = report.timecodes[0]?.tracks[0]?.subtracks[0]?.events[1]?.path;
      if (!path) throw new Error('测试事件缺失');
      const desired = patchMa2EventTimes(current, report.sha256, [{ path, rawTime: requested }]);
      let exact = true;
      try { await bridge.request('APPLY', 9902, current, desired); }
      catch (error) { if (!(error instanceof Error) || !error.message.includes('读回的内容和预期不一致')) throw error; exact = false; }
      const result = inspectMa2TimecodeXml(await bridge.request('READ', 9902));
      const actual = result.timecodes[0]?.tracks[0]?.subtracks[0]?.events[1]?.attributes.time ?? '0';
      results.push({ requested, actual, exact });
    }
    console.info('MA2 time precision:', JSON.stringify(results));
    expect(results).toEqual([
      { requested: '45.03', actual: '45', exact: false }, { requested: '45.5', actual: '45', exact: false },
      { requested: '45.9999', actual: '45', exact: false }, { requested: '0.03', actual: '0', exact: false },
      { requested: '0.001', actual: '0', exact: false }
    ]);
  } finally {
    const current = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(before.timecodes);
  }
}, 60000);

it.skipIf(!process.env.MA2_ONPC_ACTION_ACCEPTANCE)('本机执行器动作 XML 探针并还原', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const original = await bridge.request('READ', 9902);
  const before = inspectMa2TimecodeXml(original);
  expect(before.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  try {
    for (const [command, step] of [['Go', '1'], ['Go', '2'], ['Go', '9'], ['Off', '1'], ['Off', '9']]) {
      const current = await bridge.request('READ', 9902);
      const desired = original.replace('time="45" command="Goto" pressed="true" step="2"', `time="45" command="${command}" pressed="true" step="${step}"`);
      expect(desired).not.toBe(original);
      try { await bridge.request('APPLY', 9902, current, desired); }
      catch (error) { if (!(error instanceof Error) || !error.message.includes('读回的内容和预期不一致')) throw error; }
      const readback = await bridge.request('READ', 9902);
      expect(inspectMa2TimecodeXml(readback).timecodes[0]?.tracks[0]?.subtracks[0]?.events[1]).toMatchObject({ attributes: { command, step: command === 'Go' ? '2' : '1' }, cueName: null, cueAddress: [] });
    }
    for (const { commands, steps } of [{ commands: ['Go', 'Go', 'Go'], steps: ['1', '2', '1'] }, { commands: ['Off', 'Go', 'Go'], steps: ['4294967295', '1', '2'] }, { commands: ['Go', 'Off', 'Go'], steps: ['1', '1', '1'] }]) {
      const current = await bridge.request('READ', 9902);
      const body = commands.map((command, index) => `<Event index="${index}"${index ? ` time="${index * 45}"` : ''} command="${command}" pressed="true" step="9"/>`).join('');
      const desired = original.replace(/<SubTrack index="0">[\s\S]*?<\/SubTrack>/, `<SubTrack index="0">${body}</SubTrack>`);
      expect(desired).not.toBe(original);
      try { await bridge.request('APPLY', 9902, current, desired); }
      catch (error) { if (!(error instanceof Error) || !error.message.includes('读回的内容和预期不一致')) throw error; }
      const report = inspectMa2TimecodeXml(await bridge.request('READ', 9902));
      expect(report.timecodes[0]?.tracks[0]?.subtracks[0]?.events.map((event) => [event.attributes.command, event.attributes.step, event.cueAddress])).toEqual(commands.map((command, index) => [command, steps[index], []]));
    }
    const path = before.timecodes[0]?.tracks[0]?.subtracks[0]?.events[0]?.path;
    if (!path) throw new Error('测试事件缺失');
    const desired = editMa2TimecodeEvents(original, before.sha256, 9902, [
      { kind: 'update', path, executorAction: 'go' },
      { kind: 'update', path: path.replace('/Event:0', '/Event:1'), executorAction: 'off' },
      { kind: 'add', subtrackPath: path.slice(0, path.lastIndexOf('/')), rawTime: '90', executorAction: 'go' }
    ]);
    const current = await bridge.request('READ', 9902);
    const written = await bridge.request('APPLY', 9902, current, desired);
    expect(inspectMa2TimecodeXml(written).timecodes[0]?.tracks[0]?.subtracks[0]?.events.map((event) => [event.attributes.command, event.cueAddress])).toEqual([['Go', []], ['Off', []], ['Go', []]]);
    const changed = editMa2TimecodeEvents(written, inspectMa2TimecodeXml(written).sha256, 9902, [
      { kind: 'update', path, rawTime: '60' },
      { kind: 'delete', path: path.replace('/Event:0', '/Event:1') }
    ]);
    const reordered = await bridge.request('APPLY', 9902, written, changed);
    expect(inspectMa2TimecodeXml(reordered).timecodes[0]?.tracks[0]?.subtracks[0]?.events.map((event) => [event.attributes.time, event.attributes.command, event.attributes.step])).toEqual([['60', 'Go', '1'], ['90', 'Go', '2']]);
  } finally {
    const current = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(before.timecodes);
  }
}, 60000);

it.skipIf(!process.env.MA2_ONPC_WRITE_ACCEPTANCE)('专属小数 Cue 测试对象新增、删除、修改和回读后还原', async () => {
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const original = await bridge.request('READ', 9902);
  const report = inspectMa2TimecodeXml(original);
  expect(report.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
  const events = report.timecodes[0]?.tracks[0]?.subtracks[0]?.events;
  if (!events?.[0] || !events[1]) throw new Error('测试事件不存在');
  const path = events[0].path.slice(0, events[0].path.lastIndexOf('/'));
  const desired = editMa2TimecodeEvents(original, report.sha256, 9902, [
    { kind: 'delete', path: events[0].path },
    { kind: 'update', path: events[1].path, rawTime: '90', cue: { sequence: 9901, cueIndex: 1, name: 'Cue 1.25' } },
    { kind: 'add', subtrackPath: path, rawTime: '0', cue: { sequence: 9901, cueIndex: 2, name: 'Cue 7.5' } },
    { kind: 'add', subtrackPath: path, rawTime: '45', cue: { sequence: 9901, cueIndex: 1, name: 'Cue 1.25' } }
  ]);
  const preview = convertMa2Timecode(original, [await bridge.request('SNAPSHOT', 9902)], 9902);
  const document = structuredClone(preview.document);
  document.ma2Bindings = [{ id: 'native-binding', timecode: 9902, name: preview.name, readAt: preview.readAt, sourceXml: original, baselineTracks: structuredClone(document.tracks), mappings: structuredClone(preview.mappings) }];
  const clip = document.tracks[0]?.clips[0];
  const first = clip?.events[0]; const second = clip?.events[1];
  if (!clip || !first || !second) throw new Error('测试片段或 Cue 缺失');
  clip.events = [{ ...first, id: second.id, at: 3000 }, { ...second, id: 'new-first', at: 0 }, { ...first, id: 'new-second', at: 1500 }];
  clip.duration = 4000;
  const expectedSnapshot = await bridge.request('SNAPSHOT', 9902);
  const prepared = prepareMa2MergedEvents(document, 'native-binding', preview, new Map(), new Map(), [expectedSnapshot]);
  const expectedTimecodes = inspectMa2TimecodeXml(desired).timecodes;
  if (!expectedTimecodes[0]) throw new Error('预期 Timecode 缺失');
  // 最后一个点移到第 90 帧时，编排末尾必须覆盖该帧（MA2 属性拼写为 lenght）。
  expectedTimecodes[0].attributes.lenght = '91';
  expect(inspectMa2TimecodeXml(prepared.desiredXml).timecodes).toEqual(expectedTimecodes);
  try {
    const outdatedSequence = expectedSnapshot.replace('sub_number="250"', 'sub_number="251"');
    expect(outdatedSequence).not.toBe(expectedSnapshot);
    await expect(bridge.request('SYNC', 9902, outdatedSequence, prepared.desiredXml)).rejects.toThrow('Sequence changed');
    expect(inspectMa2TimecodeXml(await bridge.request('READ', 9902)).timecodes).toEqual(report.timecodes);
    const readback = await bridge.request('SYNC', 9902, expectedSnapshot, prepared.desiredXml);
    const snapshot = await bridge.request('SNAPSHOT', 9902);
    const confirmed = confirmMa2MergedEvents(prepared, readback, [snapshot]);
    expect(confirmed.document.tracks[0]?.clips[0]?.events.map((event) => event.id)).toEqual(['new-first', 'new-second', second.id]);
    const converted = convertMa2Timecode(snapshot, [snapshot], 9902);
    expect(converted.unconverted).toEqual([]);
    expect(converted.document.tracks[0]?.clips[0]?.events).toMatchObject([
      { at: 0, cue: '7.500', executor: '99.219' },
      { at: 1500, cue: '1.250', executor: '99.219' },
      { at: 3000, cue: '1.250', executor: '99.219' }
    ]);
    const readPaths = new Set(converted.mappings.map((mapping) => mapping.path));
    expect([...prepared.eventPaths.values()].every((path) => readPaths.has(path))).toBe(true);
  } finally {
    const current = await bridge.request('READ', 9902);
    expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    const restored = await bridge.request('APPLY', 9902, current, original);
    expect(inspectMa2TimecodeXml(restored).timecodes).toEqual(report.timecodes);
  }
}, 60000);
