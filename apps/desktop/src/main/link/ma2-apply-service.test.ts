import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2ApplyRequest } from '@tb/schema';
import { bindMa2TrackCommand, LightingRecorder } from '@tb/core/link';
import { convertMa2Timecode } from './ma2-timecode-conversion';
import { Ma2ApplyService } from './ma2-apply-service';
import { Ma2BridgeFailure, Ma2OnpcBridge } from './ma2-onpc-bridge';
import { editMa2TimecodeEvents, inspectMa2TimecodeXml } from './ma2-timecode-xml';
import { removeMa2Tracks } from './ma2-track-write';
import { showMovingWhen, showStopped } from './fixtures/show-gates';

const xml = await readFile(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = await readFile(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
const master = await readFile(new URL('./fixtures/ma2-timecode-master-3.3.xml', import.meta.url), 'utf8');
function snapshot(timecode: string, source = sequence): string {
  const object = source.match(/<Sequ\s[\s\S]*<\/Sequ>/)?.[0];
  if (!object) throw new Error('测试序列缺失');
  return timecode.replace('</MA>', `${object}</MA>`);
}
function setup(source = xml) {
  const readback = convertMa2Timecode(source, [sequence], 9902);
  const document = structuredClone(readback.document);
  document.ma2Bindings = [{ id: 'binding', timecode: 9902, name: readback.name, readAt: readback.readAt, sourceXml: source, baselineTracks: structuredClone(document.tracks), mappings: structuredClone(readback.mappings) }];
  const request: Ma2ApplyRequest = { dataDirectory: 'C:/ma2', document, bindingId: 'binding', readback, conflicts: [] };
  let native = source;
  const bridge = {
    request: vi.fn((): Promise<string> => Promise.resolve(snapshot(native))),
    exchange: vi.fn((_operation: string, _target: number, _expected?: string, desired?: string): Promise<{ response: string; requestId: string }> => {
      native = desired ?? ''; return Promise.resolve({ response: native, requestId: 'a'.repeat(32) });
    })
  };
  return { request, bridge };
}

function setupEmpty() {
  const result = setup();
  const report = inspectMa2TimecodeXml(xml);
  const empty = editMa2TimecodeEvents(xml, report.sha256, 9902, report.timecodes[0]!.tracks[0]!.subtracks[0]!.events.map((event) => ({ kind: 'delete', path: event.path })));
  const preview = convertMa2Timecode(empty, [], 9902);
  const document = structuredClone(preview.document);
  document.ma2Bindings = [{ id: 'binding', timecode: 9902, name: preview.name, readAt: preview.readAt, sourceXml: empty, baselineTracks: structuredClone(document.tracks), mappings: preview.mappings, trackMappings: preview.trackMappings }];
  document.tracks[0]!.clips[0]!.duration = 2000;
  document.tracks[0]!.clips[0]!.events.push({ id: 'added', kind: 'ma2', action: 'goto', at: 500, sequence: 9901, cue: '1.250', executor: '99.219', label: 'Cue 1.25' });
  result.request.document = document; result.request.readback = preview;
  return { ...result, empty };
}
describe('本机 MA2 同步服务', () => {
  it('录制关闭执行器反馈后可同步回读，不伪造 Cue 引用', async () => {
    const { request, bridge } = setup();
    const recorder = new LightingRecorder(1, 10000, [{ executor: '99.219', sequence: 9901 }]);
    recorder.receive([0xf0, 0x7f, 0x7f, 2, 1, 0x0b, ...[...'0.000\0' + '219.99'].map((char) => char.charCodeAt(0)), 0xf7], 1000);
    const events = recorder.finish(1500);
    request.document.tracks[0]!.clips[0]!.events.push(...events);
    const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
    if (result.status !== 'verified') throw new Error(result.message);
    const recorded = result.confirmed.document.tracks[0]!.clips[0]!.events.find((event) => event.id === events[0]?.id);
    expect(recorded).toMatchObject({ kind: 'ma2', action: 'off', at: 1000, executor: '99.219' });
    expect(recorded).not.toHaveProperty('cue');
    expect(recorded).not.toHaveProperty('sequence');
    const nativeEvent = inspectMa2TimecodeXml(result.confirmed.sourceXml).timecodes[0]!.tracks[0]!.subtracks[0]!.events.find((event) => event.attributes.command === 'Off');
    expect(nativeEvent?.cueAddress).toEqual([]);
  });
  it.skipIf(!process.env.MA2_ONPC_LENGTH_ACCEPTANCE)('拖到原结尾之外的 Cue 延长原生播放长度并完整回读', async () => {
    const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', showStopped);
    const original = await bridge.request('READ', 9902);
    const before = inspectMa2TimecodeXml(original);
    expect(before.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    try {
      const { request } = setup(original);
      const clip = request.document.tracks[0]!.clips[0]!;
      const event = clip.events[clip.events.length - 1]!;
      const originalLength = Number(before.timecodes[0]?.attributes.lenght ?? 0);
      const targetTick = Math.max(originalLength + 30, 1800);
      event.at = targetTick * 1000 / 30; clip.duration = event.at + 1000;
      const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
      if (result.status !== 'verified') throw new Error(result.message);
      expect(inspectMa2TimecodeXml(result.confirmed.sourceXml).timecodes[0]?.attributes.lenght).toBe(String(targetTick + 1));
      expect(result.confirmed.document.tracks[0]!.clips[0]!.events.find((entry) => entry.id === event.id)?.at).toBe(event.at);
    } finally {
      const current = await bridge.request('READ', 9902);
      expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
      expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(before.timecodes);
    }
  }, 60000);
  it.skipIf(!process.env.MA2_ONPC_RECORDED_OFF_ACCEPTANCE)('录制 Off 数据写入 onPC 原生动作并回读，还原专用对象', async () => {
    const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', showStopped);
    const original = await bridge.request('READ', 9902);
    const before = inspectMa2TimecodeXml(original);
    expect(before.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    try {
      const { request } = setup(original);
      const recorder = new LightingRecorder(1, 10000, [{ executor: '99.219', sequence: 9901 }]);
      recorder.receive([0xf0, 0x7f, 0x7f, 2, 1, 0x0b, ...[...'0.000\0' + '219.99'].map((char) => char.charCodeAt(0)), 0xf7], 1000);
      const events = recorder.finish(1500);
      request.document.tracks[0]!.clips[0]!.events.push(...events);
      const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
      if (result.status !== 'verified') throw new Error(result.message);
      const event = result.confirmed.document.tracks[0]!.clips[0]!.events.find((entry) => entry.id === events[0]?.id);
      expect(event).toMatchObject({ kind: 'ma2', action: 'off', at: 1000, executor: '99.219' });
      expect(event).not.toHaveProperty('cue'); expect(event).not.toHaveProperty('sequence');
    } finally {
      const current = await bridge.request('READ', 9902);
      expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
      expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(before.timecodes);
    }
  }, 60000);
  it.skipIf(!process.env.MA2_ONPC_FADER_CREATE_ACCEPTANCE)('空 Timecode 从节目生成 Master 轨道并由本机 onPC 确认', async () => {
    const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', showStopped);
    const original = await bridge.request('READ', 9902);
    const before = inspectMa2TimecodeXml(original);
    expect(before.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    try {
      const empty = removeMa2Tracks(original, 9902, before.timecodes[0]!.tracks.map((track) => `Timecode:9901/Track:${track.index}`)).xml;
      const seeded = await bridge.request('APPLY', 9902, original, empty);
      const { request } = setup(seeded);
      const track = setup(original).request.document.tracks[0]!;
      track.clips[0]!.events = [{ id: 'first-master', at: 500, kind: 'ma2-fader', executor: '99.219', fader: 'Master', level: 0.625, label: '主推杆' }];
      track.clips[0]!.duration = 1000;
      request.document.tracks = [track];
      const project = createEmptyLinkProject('Master 从零编排'); project.schemaVersion = 2;
      project.rundown.push({ id: 'item', title: '节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: request.document });
      request.document = bindMa2TrackCommand('item', 'binding', track.id, '99.219', track.name).execute(project).rundown[0]!.lighting!;
      const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
      if (result.status !== 'verified') throw new Error(result.message);
      expect(result.confirmed.document.tracks[0]!.clips[0]!.events).toEqual([{ id: 'first-master', at: 500, kind: 'ma2-fader', executor: '99.219', fader: 'Master', level: 0.625, label: '主推杆' }]);
      expect(result.backupFile).toMatch(/^tblink_backup_[a-f0-9]{32}\.xml$/);
    } finally {
      const current = await bridge.request('READ', 9902);
      expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
      expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(before.timecodes);
    }
  }, 60000);
  it('Master 修改通过完整同步服务，回读数值不一致时不能确认成功', async () => {
    const { request, bridge } = setup(master);
    const fader = request.document.tracks[0]!.clips[0]!.events.find((event) => event.kind === 'ma2-fader' && event.level === 0.755);
    if (fader?.kind !== 'ma2-fader') throw new Error('缺少 Master 样例');
    fader.level = 0.625; fader.at = 1000;
    const service = new Ma2ApplyService(bridge, showStopped);
    const verified = await service.apply(request);
    if (verified.status !== 'verified') throw new Error(verified.message);
    expect(verified.confirmed.document.tracks[0]!.clips[0]!.events.find((event) => event.id === fader.id)).toMatchObject({ level: 0.625, at: 1000 });
    expect(bridge.exchange).toHaveBeenCalledWith('SYNC', 9902, snapshot(master), expect.stringContaining('fader_level="0.625"'));
    bridge.request.mockResolvedValueOnce(snapshot(master)).mockResolvedValueOnce(snapshot(master));
    expect(await service.apply(request)).toMatchObject({ status: 'incomplete', stage: 'verify', mayHaveWritten: true });
  });
  it.skipIf(!process.env.MA2_ONPC_FADER_SERVICE_ACCEPTANCE).each([0, 0.00001, 0.001, 0.33333, 0.333, 0.625, 1])('Master 数值 %s 在 onPC 精度核对、同步回读后还原测试对象', async (level) => {
    const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', showStopped);
    const original = await bridge.request('READ', 9902);
    const before = inspectMa2TimecodeXml(original);
    expect(before.timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
    try {
      const seeded = await bridge.request('APPLY', 9902, original, master);
      const { request } = setup(seeded);
      const fader = request.document.tracks[0]!.clips[0]!.events.find((event) => event.kind === 'ma2-fader' && event.level === 0.755);
      if (fader?.kind !== 'ma2-fader') throw new Error('缺少 Master 样例');
      fader.level = level; fader.at = 1000;
      const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
      if (level === 0.00001 || level === 0.33333) {
        expect(result).toMatchObject({ status: 'incomplete', stage: 'preflight', mayHaveWritten: false });
        if (result.status !== 'incomplete') throw new Error('高精度推杆未拦截');
        expect(result.message).toContain('0.1%');
        expect(inspectMa2TimecodeXml(await bridge.request('READ', 9902)).timecodes).toEqual(inspectMa2TimecodeXml(seeded).timecodes);
        return;
      }
      if (result.status !== 'verified') throw new Error(result.message);
      expect(result.backupFile).toMatch(/^tblink_backup_[a-f0-9]{32}\.xml$/);
      expect(result.confirmed.document.tracks[0]!.clips[0]!.events.find((event) => event.id === fader.id)).toMatchObject({ level, at: 1000 });
    } finally {
      const current = await bridge.request('READ', 9902);
      expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe('TBLINK_FRACTIONAL_TIMECODE');
      expect(inspectMa2TimecodeXml(await bridge.request('APPLY', 9902, current, original)).timecodes).toEqual(before.timecodes);
    }
  }, 60000);
  it.each([0.00001, 0.33333])('高于控台精度的推杆值 %s 在发送前明确拒绝，不改变节目数据', async (level) => {
    const { request, bridge } = setup(master);
    const fader = request.document.tracks[0]!.clips[0]!.events.find((event) => event.kind === 'ma2-fader');
    if (fader?.kind !== 'ma2-fader') throw new Error('缺少推杆样例');
    fader.level = level;
    const before = structuredClone(request.document);
    const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
    expect(result).toMatchObject({ status: 'incomplete', stage: 'preflight', mayHaveWritten: false });
    if (result.status !== 'incomplete') throw new Error('高精度推杆未拦截');
    expect(result.message).toContain('0.1%');
    expect(bridge.exchange).not.toHaveBeenCalled();
    expect(request.document).toEqual(before);
  });
  it('空轨道新增指定 Cue 自动补读所需序列，并把额外序列交给写前核对', async () => {
    const { request, bridge, empty } = setupEmpty();
    bridge.request.mockResolvedValueOnce(empty).mockResolvedValueOnce(snapshot(empty));
    const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
    if (result.status !== 'verified') throw new Error(result.message);
    expect(bridge.request).toHaveBeenNthCalledWith(2, 'SCOPE', 9902, '9901');
    expect(bridge.exchange).toHaveBeenCalledWith('SYNC', 9902, snapshot(empty), expect.stringContaining('Cue 1.25'));
    expect(result.confirmed.document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ id: 'added', cue: '1.250', sequence: 9901, at: 500 });
  });
  it('补读期间轨道变化、序列缺失或 Cue 被重新编号时不写入', async () => {
    for (const failure of ['timecode', 'missing', 'renumbered'] as const) {
      const { request, bridge, empty } = setupEmpty();
      const scoped = failure === 'timecode' ? snapshot(empty.replace('TBLINK_FRACTIONAL_TIMECODE', 'CHANGED')) : failure === 'missing' ? empty : snapshot(empty, sequence.replace('sub_number="250"', 'sub_number="251"'));
      bridge.request.mockResolvedValueOnce(empty).mockResolvedValueOnce(scoped);
      expect(await new Ma2ApplyService(bridge, showStopped).apply(request)).toMatchObject({ status: 'incomplete', mayHaveWritten: false });
      expect(bridge.exchange).not.toHaveBeenCalled();
      expect(bridge.request).toHaveBeenCalledTimes(2);
    }
  });
  it('完成新快照复核、写入、再次回读并返回稳定身份与备份名称', async () => {
    const { request, bridge } = setup(); request.document.tracks[0]!.clips[0]!.events[0]!.at = 500;
    const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') throw new Error(result.message);
    expect(result.backupFile).toBe(`tblink_backup_${'a'.repeat(32)}.xml`);
    expect(result.confirmed.document.tracks[0]?.clips[0]?.events[0]).toMatchObject({ id: request.document.tracks[0]!.clips[0]!.events[0]!.id, at: 500 });
    expect(bridge.request).toHaveBeenCalledTimes(2);
    expect(bridge.exchange).toHaveBeenCalledWith('SYNC', 9902, expect.stringContaining('<Sequ '), expect.stringContaining('time="15"'));
  });
  it('内容不变仅核对并返回基线，不写入控台', async () => {
    const { request, bridge } = setup();
    const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
    expect(result).toMatchObject({ status: 'verified', backupFile: null }); expect(bridge.exchange).not.toHaveBeenCalled();
  });
  it('显式最近帧模式将毫秒打点写成已预览的帧时间', async () => {
    const { request, bridge } = setup(); request.document.tracks[0]!.clips[0]!.events[0]!.at = 517;
    request.timeAlignment = 'nearest-frame';
    const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
    if (result.status !== 'verified') throw new Error(result.message);
    expect(result.confirmed.document.tracks[0]?.clips[0]?.events[0]?.at).toBe(16000 / 30);
  });
  it('Timecode 或序列 Cue 编号在预览后变化，写前拒绝', async () => {
    for (const current of [snapshot(xml.replace('time="45"', 'time="60"')), snapshot(xml, sequence.replace('sub_number="250"', 'sub_number="251"'))]) {
      const { request, bridge } = setup(); bridge.request.mockResolvedValue(current);
      const result = await new Ma2ApplyService(bridge, showStopped).apply(request);
      expect(result).toMatchObject({ status: 'incomplete', stage: 'read', mayHaveWritten: false });
      if (result.status !== 'incomplete') throw new Error('过期预览未拒绝');
      expect(result.message).toContain('控台同时在改：预览之后');
      expect(bridge.exchange).not.toHaveBeenCalled();
    }
  });
  it('读取期间开始播放，写前拒绝；同步并发不发送第二个请求', async () => {
    const { request, bridge } = setup(); request.document.tracks[0]!.clips[0]!.events[0]!.at = 500;
    let playing = false;
    bridge.request.mockImplementation(() => { playing = true; return Promise.resolve(snapshot(xml)); });
    expect(await new Ma2ApplyService(bridge, showMovingWhen(() => playing)).apply(request)).toMatchObject({ status: 'incomplete', stage: 'preflight', mayHaveWritten: false });
    expect(bridge.exchange).not.toHaveBeenCalled();
    let complete: ((xml: string) => void) | undefined;
    bridge.request.mockImplementation(() => new Promise<string>((resolve) => { complete = resolve; }));
    const service = new Ma2ApplyService(bridge, showStopped);
    request.document.tracks[0]!.clips[0]!.events[0]!.at = 0;
    const pending = service.apply(request);
    expect(await service.apply(request)).toMatchObject({ status: 'incomplete', message: '已有 MA2 同步正在进行' });
    if (!complete) throw new Error('读取未开始'); complete(snapshot(xml));
    expect((await pending).status).toBe('verified');
  });
  it('未发送和已发送失败明确区分，不重试', async () => {
    for (const sent of [false, true]) {
      const { request, bridge } = setup(); request.document.tracks[0]!.clips[0]!.events[0]!.at = 500;
      bridge.exchange.mockRejectedValue(new Ma2BridgeFailure('传输失败', 'a'.repeat(32), sent, {}));
      expect(await new Ma2ApplyService(bridge, showStopped).apply(request)).toMatchObject({ status: 'incomplete', stage: 'write', mayHaveWritten: sent });
      expect(bridge.exchange).toHaveBeenCalledTimes(1);
    }
  });
  it('写后回读不一致保留备份信息，不返回新基线', async () => {
    const { request, bridge } = setup(); request.document.tracks[0]!.clips[0]!.events[0]!.at = 500;
    bridge.request.mockResolvedValue(snapshot(xml));
    expect(await new Ma2ApplyService(bridge, showStopped).apply(request)).toMatchObject({ status: 'incomplete', stage: 'verify', mayHaveWritten: true, backupFile: `tblink_backup_${'a'.repeat(32)}.xml` });
  });
  it('桥接写入回读失败仍将已核对备份交给界面，不重试或返回成功', async () => {
    const { request, bridge } = setup(); request.document.tracks[0]!.clips[0]!.events[0]!.at = 500;
    const backupFile = `tblink_backup_${'b'.repeat(32)}.xml`;
    bridge.exchange.mockRejectedValue(new Ma2BridgeFailure('回读不一致', 'b'.repeat(32), true, {}, backupFile));
    expect(await new Ma2ApplyService(bridge, showStopped).apply(request)).toMatchObject({ status: 'incomplete', stage: 'write', mayHaveWritten: true, backupFile });
    expect(bridge.exchange).toHaveBeenCalledTimes(1);
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });
});
