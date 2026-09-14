import { describe, expect, it } from 'vitest';
import type { IntegrationProfile, LinkProject } from '@tb/schema';
import { runLinkPreflight, type PreflightContext } from './link-preflight';

describe('团播联动台预检', () => {
  it('内部单曲播放不被另一首未完成节目的音频阻断，切到该节目仍阻断', () => {
    const value = context(); value.mtcRequirement = 'internal'; value.project.playbackSource = 'internal';
    const original = value.project.rundown[0]!;
    const unfinished = { ...original, id: 'unfinished', title: '节目 4', cues: [], referenceMediaClips: [] };
    delete unfinished.referenceAudio;
    value.project.rundown.push(unfinished);
    expect(runLinkPreflight(value).passed).toBe(true);
    expect(runLinkPreflight(value).checks.some((check) => check.id === 'asset.audio.unfinished')).toBe(false);
    value.currentItemId = unfinished.id;
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'asset.audio.unfinished')?.status).toBe('blocking');
  });
  it('内部主控无需 P1 进程、输入时间码或波形缓存，仍检查灯光输出', () => {
    const value = context(); value.mtcRequirement = 'internal'; value.project.playbackSource = 'internal';
    value.processes.p1 = { running: false, version: null }; value.midi.mtcUpdating = false;
    value.midi.mtcStable = false; value.midi.detectedFrameRate = null;
    value.midi.ports = value.midi.ports.filter((port) => port.direction === 'output');
    for (const asset of Object.values(value.referenceAssets)) asset.waveformAvailable = false;
    expect(runLinkPreflight(value).passed).toBe(true);
    value.profile.internalPlayer = { mtcOutputPortProfileId: 'lights', audioOutputDeviceId: 'default' };
    value.profile.midiPortProfiles.push({ id: 'lights', direction: 'output', portName: 'Missing MA2' });
    expect(runLinkPreflight(value).passed).toBe(false);
  });
  it('直播模式所有关键目标就绪时通过', () => {
    const report = runLinkPreflight(context());
    expect(report.passed).toBe(true);
    expect(report.checks.some((check) => check.status === 'blocking')).toBe(false);
  });

  it('OBS 目标、MTC 和 P1 缺失时均形成阻断项', () => {
    const value = context();
    value.obs.scenes = [];
    value.midi.mtcUpdating = false;
    value.midi.detectedFrameRate = '25';
    value.processes.p1.running = false;
    const report = runLinkPreflight(value);
    expect(report.passed).toBe(false);
    expect(report.checks.filter((check) => check.status === 'blocking').map((check) => check.id)).toEqual(expect.arrayContaining([
      'target.action-scene',
      'mtc.updating',
      'mtc.frameRate',
      'process.p1'
    ]));
    expect(report.checks.find((check) => check.id === 'mtc.stable')).toMatchObject({
      status: 'blocking',
      detail: '尚无持续时间码，无法判断稳定性'
    });
  });

  it('预检只依赖 OBS、P1 与 MTC，不包含直播伴侣检查', () => {
    const report = runLinkPreflight(context());
    expect(report.passed).toBe(true);
    expect(report.checks.some((check) => check.id.includes('liveCompanion'))).toBe(false);
  });

  it('停用节目不校验资源和动作目标且不能作为当前节目', () => {
    const value = context();
    const item = value.project.rundown[0];
    if (!item) throw new Error('测试节目不存在');
    item.enabled = false;
    value.referenceAssets = {};
    value.obs.scenes = [];
    const report = runLinkPreflight(value);
    expect(report.checks.find((check) => check.id === 'project.currentItem')?.status).toBe('blocking');
    expect(report.checks.some((check) => check.id.startsWith('asset.'))).toBe(false);
    expect(report.checks.some((check) => check.id.startsWith('target.'))).toBe(false);
  });

  it('启用节目缺少参考音频和波形时阻断预检', () => {
    const value = context();
    const item = value.project.rundown[0];
    if (!item) throw new Error('测试节目不存在');
    delete item.referenceAudio;
    value.referenceAssets = {};

    const report = runLinkPreflight(value);
    expect(report.checks.find((check) => check.id === 'asset.audio.item')).toMatchObject({ status: 'blocking' });
    expect(report.checks.find((check) => check.id === 'asset.waveform.item')).toMatchObject({ status: 'blocking' });
  });

  it('普通 P1 跟随不要求控制输出，兼容旧工程的 start-on-go 触发才检查输出端口', () => {
    const value = context();
    value.midi.ports = value.midi.ports.filter((port) => port.direction !== 'output');
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'midi.output.p1-output')).toBeUndefined();

    value.mtcRequirement = 'start-on-go';
    const item = value.project.rundown[0];
    if (!item) throw new Error('测试节目不存在');
    item.p1StartTrigger = {
      id: 'p1-start', label: 'P1 播放', kind: 'p1.midiNotePulse', portProfileId: 'p1-output',
      channel: 1, note: 60, velocity: 127, durationMs: 80
    };
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'midi.output.p1-output'))
      .toMatchObject({ status: 'blocking' });
  });

  it('P1 正式音乐必须配置为存在且未静音的 OBS 音频输入', () => {
    const value = context();
    value.obs.inputAudioStates['P1 Audio'] = { supported: true, muted: true, error: null };
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'obs.p1AudioInput'))
      .toMatchObject({ status: 'blocking', detail: 'P1 Audio 当前静音' });

    value.obs.inputAudioStates['P1 Audio'] = { supported: true, muted: false, error: null };
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'obs.p1AudioInput'))
      .toMatchObject({ status: 'passed' });

    delete value.profile.p1.obsAudioInputName;
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'obs.p1AudioInput'))
      .toMatchObject({ status: 'blocking', detail: '尚未选择承载 P1 正式音乐的 OBS 音频输入' });
  });

  it('OBS 二次缩小输出时明确提示画质损失', () => {
    const value = context();
    value.obs.videoSettings = { baseWidth: 1080, baseHeight: 1920, outputWidth: 720, outputHeight: 1280 };
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'quality.outputScale')).toMatchObject({ status: 'warning' });
    value.obs.videoSettings.outputWidth = 1080; value.obs.videoSettings.outputHeight = 1920;
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'quality.outputScale')).toMatchObject({ status: 'passed' });
  });

  it('OBS 输出画布必须与工程横竖屏和尺寸完全一致', () => {
    const value = context();
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'obs.outputCanvas'))
      .toMatchObject({ status: 'passed', detail: '1080×1920' });

    value.obs.videoSettings = { baseWidth: 1920, baseHeight: 1080 };
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'obs.outputCanvas'))
      .toMatchObject({ status: 'blocking', detail: '工程要求 1080×1920，OBS 当前为 1920×1080' });
  });

  it('P1 一键启动允许播放前没有 MTC，但必须配置当前节目的明确触发', () => {
    const value = context();
    value.mtcRequirement = 'start-on-go';
    value.midi.mtcUpdating = false;
    value.midi.detectedFrameRate = null;
    const item = value.project.rundown[0];
    if (!item) throw new Error('测试节目不存在');
    item.p1StartTrigger = {
      id: 'p1-start', label: 'P1 播放', kind: 'p1.midiNotePulse', portProfileId: 'p1-output',
      channel: 1, note: 60, velocity: 127, durationMs: 80
    };

    const ready = runLinkPreflight(value);
    expect(ready.passed).toBe(true);
    expect(ready.checks.find((check) => check.id === 'p1.startTrigger')).toMatchObject({ status: 'passed' });
    expect(ready.checks.find((check) => check.id === 'mtc.updating')).toMatchObject({ status: 'warning' });
    delete item.p1StartTrigger;
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'p1.startTrigger')).toMatchObject({ status: 'blocking' });
  });

  it('等待 P1 直接播放时允许没有起播触发，但仍要求播放后收到 MTC', () => {
    const value = context();
    value.mtcRequirement = 'awaiting-external-start';
    value.midi.mtcUpdating = false;
    value.midi.detectedFrameRate = null;
    const report = runLinkPreflight(value);
    expect(report.passed).toBe(true);
    expect(report.checks.find((check) => check.id === 'p1.startTrigger')).toBeUndefined();
    const mtcCheck = report.checks.find((check) => check.id === 'mtc.updating');
    expect(mtcCheck).toMatchObject({ status: 'warning' });
    expect(mtcCheck?.detail).toContain('尚未收到时间码');
    expect(mtcCheck?.detail).toContain('仅允许等待 P1');
  });

  it('灯光 Cue 使用独立 MIDI 端口档案并在端口缺失时阻断', () => {
    const value = context();
    const cue = value.project.rundown[0]?.cues[0];
    if (!cue) throw new Error('测试 Cue 不存在');
    cue.actions.push({
      id: 'lighting',
      label: '灯光 GO',
      kind: 'midi.showControl',
      portProfileId: 'lighting-output',
      deviceId: 0x7f,
      commandFormat: 0x01,
      command: 'go',
      cueNumber: '1'
    });

    expect(runLinkPreflight(value).checks.find((check) => check.id === 'midi.output.lighting-output'))
      .toMatchObject({ status: 'blocking', detail: '端口档案不存在' });
    value.profile.midiPortProfiles.push({ id: 'lighting-output', direction: 'output', portName: 'Lighting Console' });
    value.midi.ports.push({ name: 'Lighting Console', direction: 'output', connected: true });
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'midi.output.lighting-output'))
      .toMatchObject({ status: 'passed' });
  });

  it('时间线引用的本地媒体缺失时阻断预检', () => {
    const value = context();
    const item = value.project.rundown[0];
    if (!item) throw new Error('测试节目不存在');
    value.project.mediaAssets.push({
      id: 'media',
      name: '开场视频',
      kind: 'video',
      folderId: null,
      relativePath: 'assets/reference-media/media.mp4',
      sha256: 'b'.repeat(64),
      byteLength: 1_024,
      durationMs: 5_000,
      width: 1_920,
      height: 1_080
    });
    item.referenceMediaClips.push({
      id: 'clip',
      assetId: 'media',
      startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      durationMs: 5_000,
      label: '开场视频',
      canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }
    });

    expect(runLinkPreflight(value).checks.find((check) => check.id === 'asset.media.clip')).toMatchObject({
      status: 'blocking',
      detail: '素材文件缺失或不可读'
    });
    value.mediaAssets.media = { fileAvailable: true };
    expect(runLinkPreflight(value).checks.find((check) => check.id === 'asset.media.clip')).toMatchObject({ status: 'passed' });
  });

  it('工程帧率与 P1 档案不一致时阻断进入现场', () => {
    const value = context();
    value.project.timebase.frameRate = '25';

    const report = runLinkPreflight(value);
    expect(report.checks.find((check) => check.id === 'timebase.profileFrameRate')).toMatchObject({ status: 'blocking' });
  });

});

function context(): PreflightContext {
  return {
    mode: 'live',
    mtcRequirement: 'running',
    project: project(),
    profile: profile(),
    currentItemId: 'item',
    referenceAssets: {
      item: { audioAvailable: true, waveformAvailable: true }
    },
    mediaAssets: {},
    obs: {
      authenticated: true,
      version: '32.2.2',
      scenes: ['Program'],
      inputs: ['P1 Audio'],
      inputAudioStates: { 'P1 Audio': { supported: true, muted: false, error: null } },
      sceneItems: { Program: [] },
      filters: {},
      transitions: ['Cut'],
      videoSettings: { baseWidth: 1080, baseHeight: 1920 }
    },
    midi: {
      ports: [
        { name: 'P1 MTC', direction: 'input', connected: true },
        { name: 'P1 Control', direction: 'output', connected: true }
      ],
      mtcUpdating: true,
      mtcStable: true,
      detectedFrameRate: '30'
    },
    processes: {
      p1: { running: true, version: '1.0.0' }
    },
    availableDiskBytes: 10_000,
    minimumDiskBytes: 1_000,
    credentialsDecryptable: true,
    logRedactionReady: true,
    now: () => '2026-08-26T00:00:00.000Z'
  };
}

function project(): LinkProject {
  return {
    schemaVersion: 1,
    projectId: 'project',
    name: '工程',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    timebase: { frameRate: '30', mode: 'per-item-reset' },
    outputCanvas: { width: 1080, height: 1920 },
    mediaFolders: [],
    mediaAssets: [],
    rundown: [{
      id: 'item',
      title: '节目',
      enabled: true,
      notes: '',
      visualLayers: [],
      referenceAudio: {
        assetId: 'audio',
        relativePath: 'assets/reference-audio/audio.wav',
        sha256: 'a'.repeat(64),
        durationMs: 1_000
      },
      referenceMediaClips: [],
      cues: [{
        id: 'cue',
        name: '切场景',
        timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
        enabled: true,
        notes: '',
        actions: [{ id: 'action-scene', label: '切 Program', kind: 'obs.setProgramScene', sceneName: 'Program' }]
      }]
    }]
  };
}

function profile(): IntegrationProfile {
  const executable = (path: string) => ({
    executablePath: path,
    arguments: [],
    workingDirectory: 'C:\\Apps',
    startupTimeoutMs: 10_000,
    shutdownTimeoutMs: 10_000
  });
  return {
    schemaVersion: 1,
    profileId: 'profile',
    name: '现场',
    updatedAt: '2026-08-26T00:00:00.000Z',
    obs: { ...executable('C:\\Apps\\OBS.exe'), webSocketUrl: 'ws://127.0.0.1:4455', credentialId: 'obs-main' },
    p1: {
      ...executable('C:\\Apps\\P1.exe'),
      mtcInputPortProfileId: 'p1-input',
      controlOutputPortProfileId: 'p1-output',
      expectedFrameRate: '30',
      obsAudioInputName: 'P1 Audio'
    },
    midiPortProfiles: [
      { id: 'p1-input', direction: 'input', portName: 'P1 MTC' },
      { id: 'p1-output', direction: 'output', portName: 'P1 Control' }
    ],
    acceptedVersions: { obs: '32.2.2', p1: '1.0.0' }
  };
}
