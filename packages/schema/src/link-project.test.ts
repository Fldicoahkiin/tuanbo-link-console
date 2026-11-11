import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, latestSchemaVersion, linkActionSchema, linkProjectSchema, p1StartTriggerSchema, parseLinkProject, requiredSchemaVersion, serializeLinkProject } from './link-project';
import { createLightingDocument, lightingEventSchema, lightingMa2EventMappingSchema } from './lighting';

describe('link project schema', () => {
  it('执行器动作无需伪造 Cue 并可保存重开，指定 Cue 仍严格要求引用', () => {
    const action = { id: 'go', at: 0, kind: 'ma2' as const, action: 'go' as const, executor: '99.219', label: '下一步' };
    expect(lightingEventSchema.parse(action)).toEqual(action);
    expect(lightingEventSchema.safeParse({ ...action, action: 'goto' }).success).toBe(false);
    const lighting = createLightingDocument();
    lighting.tracks.push({ id: 'track', name: '灯光', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '片段', start: 0, duration: 2000, timeLock: 'time', muted: false, events: [action, { ...action, id: 'off', at: 1000, action: 'off' }] }] });
    const project = createEmptyLinkProject('动作工程'); project.schemaVersion = 2;
    project.rundown.push({ id: 'item', title: '节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting });
    expect(parseLinkProject(JSON.parse(serializeLinkProject(project))).rundown[0]?.lighting).toEqual(lighting);
    const mapping = { eventId: 'go', trackId: 'track', clipId: 'clip', path: 'Event:0', action: 'go', executor: '99.219', sequence: null, cueIndex: null };
    expect(lightingMa2EventMappingSchema.safeParse(mapping).success).toBe(true);
    expect(lightingMa2EventMappingSchema.safeParse({ ...mapping, cueIndex: 1 }).success).toBe(false);
    expect(lightingMa2EventMappingSchema.safeParse({ ...mapping, action: 'goto' }).success).toBe(false);
  });
  it('creates and round-trips a v1 project', () => {
    const project = createEmptyLinkProject('首场测试', new Date('2026-08-26T00:00:00.000Z'));
    expect(project.schemaVersion).toBe(1);
    expect(project.outputCanvas).toEqual({ width: 1080, height: 1920 });
    expect(parseLinkProject(JSON.parse(serializeLinkProject(project)))).toEqual(project);
  });

  it('认 1、2 两个版本；比这一版新的和低于内容需要的都拒绝', () => {
    const empty = createEmptyLinkProject('版本');
    const lit = { ...empty, rundown: [{ id: 'item', title: '节目', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() }] };
    expect(requiredSchemaVersion(empty)).toBe(1);
    expect(requiredSchemaVersion(lit)).toBe(2);
    // Unknown fields are stripped on parse: a v3 file opened before its fields exist here would lose them on the next save.
    expect(latestSchemaVersion).toBe(2);
    expect(() => parseLinkProject({ ...empty, schemaVersion: 3 })).toThrow('更新版本的联动台');
    expect(() => parseLinkProject({ ...lit, schemaVersion: 3 })).toThrow('更新版本的联动台');
    expect(linkProjectSchema.safeParse({ ...empty, schemaVersion: 4 }).success).toBe(false);
    expect(linkProjectSchema.safeParse({ ...lit, schemaVersion: 1 }).success).toBe(false);
    for (const schemaVersion of [1, 2] as const) {
      expect(parseLinkProject(JSON.parse(serializeLinkProject({ ...empty, schemaVersion }))).schemaVersion).toBe(schemaVersion);
    }
  });

  it('rejects duplicate ids across rundown, cues and actions', () => {
    const project = createEmptyLinkProject('重复 ID');
    const invalid = {
      ...project,
      rundown: [{
        id: 'duplicate',
        title: '节目',
        notes: '',
        cues: [{
          id: 'duplicate',
          name: 'Cue',
          timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
          enabled: true,
          notes: '',
          actions: []
        }]
      }]
    };
    expect(() => parseLinkProject(invalid)).toThrow(/ID 重复/);
  });

  it('拒绝素材片段和 Cue 引用不存在的视觉图层', () => {
    const project = createEmptyLinkProject('图层引用');
    expect(() => parseLinkProject({
      ...project,
      mediaAssets: [{ id: 'asset', name: '图片', kind: 'image', folderId: null, relativePath: 'assets/media/a.png', sha256: 'a'.repeat(64), byteLength: 1, width: 100, height: 100 }],
      rundown: [{
        id: 'item',
        title: '节目',
        enabled: true,
        notes: '',
        visualLayers: [{ id: 'layer', name: '图层 1', visible: true, locked: false }],
        referenceMediaClips: [{ id: 'clip', assetId: 'asset', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 1_000, label: '图片', layerId: 'missing' }],
        cues: []
      }]
    })).toThrow(/不存在的图层/);
  });

  it('rejects out-of-range frames and external asset paths', () => {
    const project = createEmptyLinkProject('非法字段');
    const invalid = {
      ...project,
      timebase: { frameRate: '24', mode: 'per-item-reset' },
      rundown: [{
        id: 'item',
        title: '节目',
        notes: '',
        referenceAudio: {
          assetId: 'audio',
          relativePath: 'C:\\music\\song.wav',
          sha256: 'a'.repeat(64),
          durationMs: 1000
        },
        cues: [{
          id: 'cue',
          name: 'Cue',
          timecode: { hours: 0, minutes: 0, seconds: 1, frames: 24 },
          enabled: true,
          notes: '',
          actions: []
        }]
      }]
    };
    expect(() => parseLinkProject(invalid)).toThrow();
  });

  it('拒绝 29.97 drop-frame 被跳过的 00 和 01 帧号', () => {
    const project = createEmptyLinkProject('Drop Frame');
    expect(() => parseLinkProject({
      ...project,
      timebase: { frameRate: '29.97df', mode: 'per-item-reset' },
      rundown: [{
        id: 'item',
        title: '节目',
        notes: '',
        cues: [{
          id: 'cue',
          name: '非法帧',
          timecode: { hours: 0, minutes: 1, seconds: 0, frames: 0 },
          enabled: true,
          notes: '',
          actions: []
        }]
      }]
    })).toThrow(/drop-frame/);
  });

  it('MSC 要求显式 Command Format 且拒绝缺少参数定义的命令', () => {
    const base = {
      id: 'msc',
      label: 'MSC',
      kind: 'midi.showControl',
      portProfileId: 'p1-output',
      deviceId: 0x7f,
      commandFormat: 0x7f
    };
    expect(linkActionSchema.parse({ ...base, command: 'go' })).toMatchObject({ commandFormat: 0x7f, command: 'go' });
    expect(() => linkActionSchema.parse({ ...base, commandFormat: undefined, command: 'go' })).toThrow();
    expect(() => linkActionSchema.parse({ ...base, command: 'timedGo' })).toThrow();
    expect(() => linkActionSchema.parse({ ...base, command: 'set' })).toThrow();
  });

  it('P1 一键播放使用显式 MIDI 触发且 Note 必须定义释放时长', () => {
    const trigger = {
      id: 'p1-start', label: 'P1 播放', kind: 'p1.midiNotePulse', portProfileId: 'p1-output',
      channel: 1, note: 60, velocity: 127, durationMs: 80
    };
    expect(p1StartTriggerSchema.parse(trigger)).toEqual(trigger);
    expect(() => p1StartTriggerSchema.parse({ ...trigger, durationMs: 0 })).toThrow();
    expect(() => p1StartTriggerSchema.parse({ ...trigger, kind: 'obs.setProgramScene' })).toThrow();
  });

  it('OBS 显示 Cue 必须有明确时长且只能管理一个显示来源', () => {
    const project = createEmptyLinkProject('OBS 时间片段');
    const cue = {
      id: 'obs', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      enabled: true, notes: '', layerId: 'layer', actions: [
        { id: 'show-a', label: '显示 A', kind: 'obs.setSceneItemEnabled' as const, sceneName: '输出', sourceName: 'A', enabled: true }
      ]
    };
    const item = { id: 'item', title: '节目', enabled: true, notes: '', visualLayers: [{ id: 'layer', name: '图层', visible: true, locked: false }], referenceMediaClips: [], cues: [cue] };
    expect(() => parseLinkProject({ ...project, rundown: [item] })).toThrow(/缺少 durationMs/);
    expect(() => parseLinkProject({
      ...project,
      rundown: [{ ...item, cues: [{ ...cue, durationMs: 1_000, actions: [...cue.actions, { ...cue.actions[0], id: 'show-b', sourceName: 'B' }] }] }]
    })).toThrow(/只能包含一个/);
    expect(() => parseLinkProject({
      ...project,
      rundown: [{ ...item, cues: [{ ...cue, layerId: undefined, durationMs: 1_000 }] }]
    })).toThrow(/还没分配视觉图层/);
    expect(() => parseLinkProject({
      ...project,
      rundown: [{
        ...item,
        visualLayers: [...item.visualLayers, { id: 'layer-2', name: '图层 2', visible: true, locked: false }],
        cues: [
          { ...cue, durationMs: 1_000 },
          { ...cue, id: 'obs-2', layerId: 'layer-2', durationMs: 1_000, actions: [{ ...cue.actions[0], id: 'show-c' }] }
        ]
      }]
    })).toThrow(/同一 OBS 来源不能.*同时显示/);
  });

  it('媒体素材和参考片段必须使用工程内资源并保持引用完整', () => {
    const project = createEmptyLinkProject('素材工程');
    const asset = {
      id: 'asset-video',
      name: '开场参考画面',
      kind: 'video' as const,
      relativePath: 'assets/reference-media/video.mp4',
      sha256: 'b'.repeat(64),
      byteLength: 1024,
      durationMs: 5_000,
      width: 1920,
      height: 1080
    };
    const valid = parseLinkProject({
      ...project,
      mediaAssets: [asset],
      rundown: [{
        id: 'item',
        title: '节目',
        notes: '',
        referenceMediaClips: [{
          id: 'clip',
          assetId: asset.id,
          label: asset.name,
          startTimecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 },
          durationMs: asset.durationMs
        }],
        cues: []
      }]
    });
    expect(valid.rundown[0]?.referenceMediaClips[0]?.assetId).toBe(asset.id);
    expect(valid.rundown[0]?.referenceMediaClips[0]?.sourceOffsetMs).toBeUndefined();
    expect(valid.rundown[0]?.referenceMediaClips[0]?.embeddedAudioEnabled).toBeUndefined();
    expect(valid.rundown[0]?.referenceMediaClips[0]?.canvasTransform).toEqual({ x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 });
    expect(() => parseLinkProject({
      ...valid,
      mediaAssets: []
    })).toThrow(/引用不存在的素材/);
    expect(() => parseLinkProject({
      ...valid,
      rundown: [{ ...valid.rundown[0], visualLayers: [{ id: 'layer', name: '画面', visible: true, locked: false }] }]
    })).toThrow(/还没分配视觉图层/);
  });

  it('资源文件夹必须保持父级、素材引用和无环层级完整', () => {
    const project = createEmptyLinkProject('资源文件夹');
    const asset = {
      id: 'asset-image',
      name: '测试图',
      kind: 'image' as const,
      folderId: 'child',
      relativePath: 'assets/reference-media/test.png',
      sha256: 'd'.repeat(64),
      byteLength: 1_024,
      width: 1920,
      height: 1080
    };
    const valid = parseLinkProject({
      ...project,
      mediaFolders: [
        { id: 'root', name: '演出', parentId: null },
        { id: 'child', name: '开场', parentId: 'root' }
      ],
      mediaAssets: [asset]
    });
    expect(valid.mediaAssets[0]?.folderId).toBe('child');
    expect(() => parseLinkProject({
      ...valid,
      mediaFolders: [
        { id: 'root', name: '演出', parentId: 'child' },
        { id: 'child', name: '开场', parentId: 'root' }
      ]
    })).toThrow(/循环/);
    expect(() => parseLinkProject({ ...valid, mediaFolders: [] })).toThrow(/不存在的文件夹/);
  });
});
