import type { OBSWebSocket } from 'obs-websocket-js';
import { describe, expect, it, vi } from 'vitest';
import { materialSceneNames, type ManagedMediaEvent } from '@tb/core/link';
import type { LinkMediaAsset } from '@tb/schema';
import { ObsMediaScenes } from './obs-media-scenes';

const asset: LinkMediaAsset = { id: 'clip', name: '舞蹈.mp4', kind: 'video', folderId: null, relativePath: 'assets/dance.mp4', sha256: 'a'.repeat(64), byteLength: 10 };
const names = materialSceneNames('project', asset);
const event: ManagedMediaEvent = { ...names, id: 'start', phase: 'start', frameNumber: 194, itemId: 'song', clipId: 'clip', layerId: 'layer', layerIndex: 0, layerCount: 1, assetId: asset.id, assetName: asset.name, assetKind: 'video', relativePath: asset.relativePath, sourceOffsetMs: 2300, embeddedAudioEnabled: false, transform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } };

function fixture(resetOnSceneSwitch = false, startsNearOrigin = false) {
  const calls: Array<{ requestType: string; requestData?: unknown }> = [];
  const responses = new Map<string, unknown>([
    ['GetSceneList', { scenes: [] }], ['CreateInput', { sceneItemId: 1 }],
    ['GetVideoSettings', { baseWidth: 1080, baseHeight: 1920 }],
    ['GetSceneItemTransform', { sceneItemTransform: { sourceWidth: 1080, sourceHeight: 1920 } }],
    ['GetSourceScreenshot', { imageData: 'data:image/png;base64,test' }],

  ]);
  let mediaState = 'OBS_MEDIA_STATE_STOPPED';
  let sceneSwitches = 0;
  let mediaCursor = startsNearOrigin ? 33 : 2300;
  let pendingCursor: number | undefined;
  let deferSeek = false;
  let deferPause = false;
  const setMediaState = (state: string, cursor: number): void => { mediaState = state; mediaCursor = cursor; };
  const apply = (data: unknown): void => {
    if (typeof data !== 'object' || data === null) return;
    if ('mediaCursor' in data && typeof data.mediaCursor === 'number') {
      if (!deferSeek) mediaCursor = data.mediaCursor;
      else pendingCursor = data.mediaCursor;
    }
    if (!('mediaAction' in data)) return;
    if (deferPause && data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE') return;
    if (data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART') mediaCursor = 0;
    mediaState = data.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' ? 'OBS_MEDIA_STATE_PAUSED' : 'OBS_MEDIA_STATE_PLAYING';
    if (mediaState === 'OBS_MEDIA_STATE_PLAYING' && pendingCursor !== undefined) {
      mediaCursor = pendingCursor; pendingCursor = undefined;
    }
  };
  const client = {
    call: (requestType: string, requestData?: unknown) => { calls.push({ requestType, requestData }); apply(requestData); return Promise.resolve(responses.get(requestType) ?? (requestType === 'GetMediaInputStatus' ? { mediaState, mediaCursor, mediaDuration: 5000 } : {})); },
    callBatch: (batch: Array<{ requestType: string; requestData?: unknown }>) => {
      if (batch.some((entry) => entry.requestType === 'SetCurrentProgramScene')) sceneSwitches += 1;
      if (resetOnSceneSwitch && sceneSwitches === 2) responses.set('GetMediaInputStatus', { mediaState: 'OBS_MEDIA_STATE_PLAYING', mediaCursor: 0 });
      calls.push(...batch); batch.forEach((entry) => apply(entry.requestData)); return Promise.resolve(batch.map(({ requestType }) => ({ requestType, requestStatus: { result: true, code: 100 } })));
    }
  };
  return { calls, responses, setMediaState, deferSeek: () => { deferSeek = true; }, deferPause: () => { deferPause = true; }, scenes: new ObsMediaScenes(client as unknown as OBSWebSocket, (operation) => operation(), (operation) => operation()) };
}

describe('素材独立场景播放', () => {
  it('近期复用的素材只暂停、静音和隐藏；正式清理仍发送停止', async () => {
    const { scenes, calls } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    calls.length = 0;
    await scenes.execute({ ...event, phase: 'stop' }, 'C:/dance.mp4', undefined, 'pause');
    expect(calls).toEqual([
      { requestType: 'TriggerMediaInputAction', requestData: { inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' } },
      { requestType: 'SetInputMute', requestData: { inputName: names.sourceName, inputMuted: true } },
      { requestType: 'SetSceneItemEnabled', requestData: { sceneName: names.sceneName, sceneItemId: 1, sceneItemEnabled: false } }
    ]);
    calls.length = 0;
    await scenes.execute({ ...event, phase: 'stop' }, 'C:/dance.mp4');
    expect(calls[0]).toEqual({ requestType: 'TriggerMediaInputAction', requestData: { inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' } });
  });
  it('预备来源复制画面与滤镜，仅写同一素材的非活动解码器；碰撞拒绝覆盖', async () => {
    const { scenes, calls, responses } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    const standby = `${names.sourceName}·预备`;
    responses.set('GetInputSettings', { inputKind: 'ffmpeg_source', inputSettings: { local_file: 'C:/dance.mp4' } });
    responses.set('GetSceneItemList', { sceneItems: [] });
    responses.set('GetSourceFilterList', { filters: [{ filterName: '颜色', filterKind: 'color_filter_v2', filterIndex: 0, filterEnabled: true, filterSettings: { brightness: 0.1 } }] });
    calls.length = 0;
    await expect(scenes.prepareStandby(names.sourceName)).resolves.toBe(standby);
    expect(calls).toContainEqual({ requestType: 'SetSourceFilterSettings', requestData: { sourceName: standby, filterName: '颜色', filterSettings: { brightness: 0.1 }, overlay: false } });
    expect(calls.some(call => call.requestType === 'SetCurrentProgramScene')).toBe(false);
    expect(calls).toContainEqual({ requestType: 'SetInputMute', requestData: { inputName: standby, inputMuted: true } });
    responses.set('GetSceneItemList', { sceneItems: [{ sourceName: standby, sceneItemId: '无效' }] });
    calls.length = 0;
    await expect(scenes.prepareStandby(names.sourceName)).rejects.toThrow('身份无效');
    expect(calls.some(call => call.requestType.startsWith('Set') || call.requestType === 'CreateInput')).toBe(false);
  });

  it('预备必须完成原生定位与纹理读取，失败不能作为已就绪输入直接播放', async () => {
    const { scenes, responses, calls, setMediaState } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    responses.set('GetSourceScreenshot', { imageData: '' });
    await expect(scenes.prime(event, 'C:/dance.mp4', () => { setMediaState('OBS_MEDIA_STATE_PAUSED', 2300); return Promise.resolve(); })).rejects.toThrow('可用画面');
    calls.length = 0;
    await expect(scenes.execute(event, 'C:/dance.mp4')).rejects.toThrow('预热尚未完成');
    expect(calls).toEqual([]);
  });
  it('暂停指令返回但 OBS 仍播放时不能提前定位，也不重复发送暂停', async () => {
    vi.useFakeTimers();
    try {
      const { scenes, calls, setMediaState, deferPause } = fixture();
      await scenes.prepare('project', asset, 'C:/dance.mp4'); await scenes.execute(event, 'C:/dance.mp4');
      calls.length = 0; setMediaState('OBS_MEDIA_STATE_PLAYING', 50); deferPause();
      const execution = scenes.execute({ ...event, sourceOffsetMs: 100, deferSceneSwitch: true }, 'C:/dance.mp4');
      await vi.advanceTimersByTimeAsync(40);
      expect(calls.filter(call => call.requestType === 'SetMediaInputCursor')).toHaveLength(0);
      expect(calls.filter(call => call.requestType === 'TriggerMediaInputAction')).toHaveLength(1);
      setMediaState('OBS_MEDIA_STATE_PAUSED', 50);
      await vi.advanceTimersByTimeAsync(20); await execution;
      expect(calls.filter(call => call.requestType === 'SetMediaInputCursor')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('新片段的 100ms 起点不能被旧零点或异步定位应答冒充', async () => {
    vi.useFakeTimers();
    try {
      const { scenes, calls, setMediaState, deferSeek } = fixture();
      await scenes.prepare('project', asset, 'C:/dance.mp4');
      await scenes.execute(event, 'C:/dance.mp4');
      calls.length = 0; setMediaState('OBS_MEDIA_STATE_PLAYING', 50); deferSeek();
      let completed = false;
      const execution = scenes.execute({ ...event, clipId: 'next', sourceOffsetMs: 100, deferSceneSwitch: true }, 'C:/dance.mp4')
        .then(() => { completed = true; });
      await vi.advanceTimersByTimeAsync(20);
      expect(completed).toBe(false);
      expect(calls.filter(call => call.requestType === 'SetMediaInputCursor').map(call => call.requestData))
        .toEqual([{ inputName: names.sourceName, mediaCursor: 100 }]);
      setMediaState('OBS_MEDIA_STATE_PAUSED', 120);
      await vi.advanceTimersByTimeAsync(20); await execution;
      expect(completed).toBe(true);
      expect(calls.filter(call => call.requestType === 'SetMediaInputCursor')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('片尾游标先归零、状态后变 ENDED 时等重置结束才重播定位，不能把定位发给已失效解码器', async () => {
    vi.useFakeTimers();
    try {
      const { scenes, calls, setMediaState } = fixture();
      await scenes.prepare('project', asset, 'C:/dance.mp4'); await scenes.execute(event, 'C:/dance.mp4');
      calls.length = 0; setMediaState('OBS_MEDIA_STATE_PLAYING', 0);
      const execution = scenes.execute({ ...event, clipId: 'next', sourceOffsetMs: 100, deferSceneSwitch: true }, 'C:/dance.mp4');
      await vi.advanceTimersByTimeAsync(12);
      expect(calls.some(call => call.requestType === 'SetMediaInputCursor' || call.requestType === 'TriggerMediaInputAction')).toBe(false);
      setMediaState('OBS_MEDIA_STATE_ENDED', 0);
      await vi.advanceTimersByTimeAsync(4); await execution;
      expect(calls.filter(call => call.requestType === 'SetMediaInputCursor')).toHaveLength(1);
      expect(calls.filter(call => call.requestType === 'TriggerMediaInputAction').map(call => call.requestData))
        .toContainEqual({ inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
    } finally { vi.useRealTimers(); }
  });
  it('准备阶段建好后续机位，正式切换不再查询目录或创建来源', async () => {
    const { scenes, calls, responses } = fixture();
    responses.set('GetSceneList', { scenes: [{ sceneName: '机位1' }, { sceneName: '机位2' }, { sceneName: names.sceneName }] });
    responses.set('GetSceneItemList', { sceneItems: [] }); responses.set('CreateSceneItem', { sceneItemId: 3 });
    const output = '团播联动台·叠加·预备';
    await scenes.prepareComposition(output, [names.sceneName, '机位1'], ['机位1', '机位2']);
    expect(calls.filter(call => call.requestType === 'CreateSceneItem')).toHaveLength(3);
    calls.length = 0;
    await scenes.compose(output, [names.sceneName, '机位2']);
    expect(calls.some(call => ['GetSceneList', 'GetSceneItemList', 'CreateSceneItem'].includes(call.requestType))).toBe(false);
    expect(calls.filter(call => call.requestType === 'SetSceneItemEnabled')).toHaveLength(2);
    expect(calls.at(-1)?.requestType).toBe('SetCurrentProgramScene');
  });

  it('控台回报当前叠加场景后只更新图层，外部切场景或断线后重新发送切换', async () => {
    const { scenes, calls, responses } = fixture();
    responses.set('GetSceneList', { scenes: [{ sceneName: '机位1' }, { sceneName: '机位2' }] });
    responses.set('GetSceneItemList', { sceneItems: [] }); responses.set('CreateSceneItem', { sceneItemId: 3 });
    const output = '团播联动台·叠加·回读';
    await scenes.prepareComposition(output, ['机位1'], ['机位2']);
    scenes.observeProgramScene(output); calls.length = 0;
    await scenes.compose(output, ['机位2']);
    expect(calls.some(call => call.requestType === 'SetSceneItemEnabled')).toBe(true);
    expect(calls.some(call => call.requestType === 'SetCurrentProgramScene')).toBe(false);
    scenes.observeProgramScene('用户手动机位'); calls.length = 0;
    await scenes.compose(output, ['机位2']);
    expect(calls).toEqual([{ requestType: 'SetCurrentProgramScene', requestData: { sceneName: output } }]);
    scenes.observeProgramScene(output); scenes.clear(); calls.length = 0;
    await scenes.switchScene(output);
    expect(calls).toEqual([{ requestType: 'SetCurrentProgramScene', requestData: { sceneName: output } }]);
  });

  it('已经活动的同来源片段从零重用只定位，不停止或重建解码器', async () => {
    const { scenes, calls, setMediaState } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    await scenes.execute(event, 'C:/dance.mp4');
    calls.length = 0; setMediaState('OBS_MEDIA_STATE_PLAYING', 4500);
    await scenes.execute({ ...event, id: 'adjacent', clipId: 'next', sourceOffsetMs: 0, deferSceneSwitch: true }, 'C:/dance.mp4');
    expect(calls.some(call => call.requestType === 'SetMediaInputCursor')).toBe(true);
    expect(calls.filter(call => call.requestType === 'TriggerMediaInputAction').map(call => call.requestData))
      .not.toContainEqual({ inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
    expect(calls.filter(call => call.requestType === 'TriggerMediaInputAction').map(call => call.requestData))
      .not.toContainEqual({ inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' });
    expect(calls.filter(call => call.requestType === 'TriggerMediaInputAction').map(call => call.requestData))
      .toContainEqual({ inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' });
  });

  it('图片在节目准备时解码，节目释放后只卸载本次自有图片', async () => {
    const { scenes, calls } = fixture(), image = { ...asset, kind: 'image' as const, relativePath: 'assets/overlay.png' };
    const target = materialSceneNames('project', image);
    await scenes.prepare('project', image, 'C:/overlay.png');
    expect(calls.find(call => call.requestType === 'CreateInput')?.requestData).toMatchObject({ inputSettings: { unload: false } });
    calls.length = 0; await scenes.releaseImages([target.sourceName]);
    expect(calls).toEqual([
      { requestType: 'SetSceneItemEnabled', requestData: { sceneName: target.sceneName, sceneItemId: 1, sceneItemEnabled: false } },
      { requestType: 'SetInputSettings', requestData: { inputName: target.sourceName, inputSettings: { unload: true }, overlay: true } }
    ]);
    calls.length = 0; await scenes.releaseImages(['用户图片']); expect(calls).toEqual([]);
  });
  it('开场素材提前静音解码并停在零点，正式启动只继续且核对播放状态', async () => {
    const { scenes, calls, setMediaState } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    const opening = { ...event, sourceOffsetMs: 0, deferSceneSwitch: true };
    await scenes.prime(opening, 'C:/dance.mp4', () => { setMediaState('OBS_MEDIA_STATE_PAUSED', 0); return Promise.resolve(); });
    expect(calls.some(call => call.requestType === 'SetCurrentProgramScene')).toBe(false);
    calls.length = 0; await scenes.execute({ ...opening, sourceOffsetMs: 33 }, 'C:/dance.mp4');
    expect(calls.filter(call => call.requestType === 'TriggerMediaInputAction').map(call => call.requestData))
      .toEqual([{ inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' }]);
    expect(calls.some(call => call.requestType === 'SetMediaInputCursor')).toBe(false);
    expect(calls.at(-1)?.requestType).toBe('GetMediaInputStatus');
  });
  it('预热后外部更改位置，拒绝使用旧的准备结果，不自动重播', async () => {
    const { scenes, calls, setMediaState } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    const opening = { ...event, sourceOffsetMs: 0, deferSceneSwitch: true };
    await scenes.prime(opening, 'C:/dance.mp4', () => { setMediaState('OBS_MEDIA_STATE_PAUSED', 0); return Promise.resolve(); }); calls.length = 0;
    setMediaState('OBS_MEDIA_STATE_PAUSED', 2000);
    await expect(scenes.execute(opening, 'C:/dance.mp4')).rejects.toThrow('预热素材状态已变化');
    expect(calls.some(call => call.requestType === 'TriggerMediaInputAction')).toBe(false);
  });
  it('已成功停止的预备素材不在统一清理时再次停止，其他预备目标仍须清理', async () => {
    const { scenes, calls, setMediaState } = fixture();
    const second = { ...asset, id: 'next-video', name: '下一段' };
    const secondEvent = { ...event, ...materialSceneNames('project', second), assetId: second.id };
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    await scenes.prepare('project', second, 'C:/dance.mp4');
    for (const target of [event, secondEvent]) await scenes.prime(target, 'C:/dance.mp4', () => {
      setMediaState('OBS_MEDIA_STATE_PAUSED', target.sourceOffsetMs); return Promise.resolve();
    });
    calls.length = 0;
    await scenes.execute({ ...event, phase: 'stop' }, 'C:/dance.mp4');
    await scenes.releasePrimed();
    expect(calls.filter(call => call.requestType === 'TriggerMediaInputAction')).toEqual([
      { requestType: 'TriggerMediaInputAction', requestData: { inputName: event.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' } },
      { requestType: 'TriggerMediaInputAction', requestData: { inputName: secondEvent.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' } }
    ]);
  });
  it('预热失败仍保留待清理目标，取消后停止解码并静音，不切正式场景', async () => {
    const { scenes, calls, responses } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    responses.set('GetMediaInputStatus', { mediaState: 'OBS_MEDIA_STATE_ERROR', mediaCursor: 0 });
    await expect(scenes.prime({ ...event, sourceOffsetMs: 0 }, 'C:/dance.mp4', () => Promise.resolve())).rejects.toThrow('未完成画面定位');
    calls.length = 0; await scenes.releasePrimed();
    expect(calls).toEqual([
      { requestType: 'TriggerMediaInputAction', requestData: { inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' } },
      { requestType: 'SetInputMute', requestData: { inputName: names.sourceName, inputMuted: true } }
    ]);
    calls.length = 0; await scenes.releasePrimed(); expect(calls).toEqual([]);
  });
  it('开场结构在准备阶段建好但不切正式画面，正式触发不再创建图层', async () => {
    const { scenes, calls, responses } = fixture();
    responses.set('GetSceneList', { scenes: [{ sceneName: '机位' }, { sceneName: names.sceneName }] });
    responses.set('GetSceneItemList', { sceneItems: [] }); responses.set('CreateSceneItem', { sceneItemId: 3 });
    const output = '团播联动台·叠加·开场';
    await scenes.prepareComposition(output, [names.sceneName, '机位']);
    expect(calls.some(call => call.requestType === 'SetCurrentProgramScene')).toBe(false);
    expect(calls.filter(call => call.requestType === 'CreateSceneItem')).toHaveLength(2);
    calls.length = 0;
    await scenes.compose(output, [names.sceneName, '机位']);
    expect(calls.map(call => call.requestType)).toEqual(['SetCurrentProgramScene']);
  });
  it('叠加只在独立输出内排列嵌套场景，上轨道在上，重复布局不重新创建', async () => {
    const { scenes, calls, responses } = fixture();
    responses.set('GetSceneList', { scenes: [{ sceneName: '机位' }, { sceneName: names.sceneName }] });
    responses.set('GetSceneItemList', { sceneItems: [] });
    responses.set('CreateSceneItem', { sceneItemId: 3 });
    const output = '团播联动台·叠加·测试';
    await scenes.compose(output, [names.sceneName, '机位']);
    expect(calls.filter(call => call.requestType === 'SetSceneItemIndex').map(call => call.requestData)).toEqual([
      { sceneName: output, sceneItemId: 3, sceneItemIndex: 1 }, { sceneName: output, sceneItemId: 3, sceneItemIndex: 0 }
    ]);
    expect(calls.some(call => ['SetInputSettings', 'SetSceneItemTransform', 'RemoveScene', 'RemoveInput'].includes(call.requestType))).toBe(false);
    calls.length = 0;
    await scenes.compose(output, [names.sceneName, '机位']);
    expect(calls.map(call => call.requestType)).toEqual(['SetCurrentProgramScene']);
    await expect(scenes.compose('用户机位', [names.sceneName])).rejects.toThrow('独立');
  });
  it('叠加中的媒体启动与定位不抢走正式机位，也不静音同场其他层', async () => {
    const { scenes, calls, responses } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4'); calls.length = 0;
    await scenes.execute({ ...event, deferSceneSwitch: true }, 'C:/dance.mp4');
    responses.set('GetMediaInputStatus', { mediaState: 'OBS_MEDIA_STATE_PAUSED', mediaCursor: 2300 });
    await scenes.seek({ ...event, deferSceneSwitch: true }, 'C:/dance.mp4', () => Promise.resolve());
    expect(calls.some(call => call.requestType === 'SetCurrentProgramScene')).toBe(false);
  });
  it('拖动只定位已准备的自有素材，不重载来源或重新启动媒体', async () => {
    const { scenes, calls, responses } = fixture();
    const native = vi.fn(() => Promise.resolve());
    await expect(scenes.seek(event, 'C:/dance.mp4', native)).rejects.toThrow('未准备');
    await scenes.prepare('project', asset, 'C:/dance.mp4'); calls.length = 0;
    responses.set('GetMediaInputStatus', { mediaState: 'OBS_MEDIA_STATE_PAUSED', mediaCursor: 2300 });
    await scenes.seek(event, 'C:/dance.mp4', native);
    expect(native).toHaveBeenCalledWith(event.sourceName, 2300);
    expect(calls.some((call) => ['SetInputSettings', 'TriggerMediaInputAction', 'SetMediaInputCursor'].includes(call.requestType))).toBe(false);
    await expect(scenes.seek(event, 'C:/other.mp4', native)).rejects.toThrow('与工程不符');
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('结束片段使用停止，避免暂停在 EOF 后无法重新定位', async () => {
    const { scenes, calls } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4'); calls.length = 0;
    await scenes.execute({ ...event, phase: 'stop' }, 'C:/dance.mp4');
    expect(calls.find(call => call.requestType === 'TriggerMediaInputAction')?.requestData).toEqual({
      inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP'
    });
  });
  it('已有会话暂停在片尾，定位前结束旧解码会话；正常暂停不受影响', async () => {
    const { scenes, calls, setMediaState } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4'); calls.length = 0;
    setMediaState('OBS_MEDIA_STATE_PAUSED', 5000);
    const native = vi.fn(() => {
      expect(calls.find(call => call.requestType === 'TriggerMediaInputAction')?.requestData).toEqual({ inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
      setMediaState('OBS_MEDIA_STATE_PAUSED', 2300);
      return Promise.resolve();
    });
    await scenes.seek(event, 'C:/dance.mp4', native);
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('原生指令已返回但尚无解码画面，不能宣称定位成功或自动重试', async () => {
    vi.useFakeTimers();
    try {
      const { scenes, responses } = fixture();
      await scenes.prepare('project', asset, 'C:/dance.mp4');
      responses.set('GetMediaInputStatus', { mediaState: 'OBS_MEDIA_STATE_PAUSED', mediaCursor: 2300 });
      const native = vi.fn(() => {
        responses.set('GetSceneItemTransform', { sceneItemTransform: { sourceWidth: 0, sourceHeight: 0 } });
        return Promise.resolve();
      });
      const failure = expect(scenes.seek(event, 'C:/dance.mp4', native)).rejects.toThrow('未完成画面定位');
      await vi.advanceTimersByTimeAsync(2020); await failure;
      expect(native).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('暂停状态没有首帧时，等解码器真正输出后才进行一次定位', async () => {
    vi.useFakeTimers();
    try {
      const { scenes, responses, setMediaState, calls } = fixture();
      await scenes.prepare('project', asset, 'C:/dance.mp4'); calls.length = 0;
      setMediaState('OBS_MEDIA_STATE_PAUSED', 23);
      responses.set('GetSceneItemTransform', { sceneItemTransform: { sourceWidth: 0, sourceHeight: 0 } });
      const native = vi.fn(() => { setMediaState('OBS_MEDIA_STATE_PAUSED', 2300); return Promise.resolve(); });
      const seek = scenes.seek(event, 'C:/dance.mp4', native);
      await vi.advanceTimersByTimeAsync(120);
      expect(native).not.toHaveBeenCalled();
      responses.set('GetSceneItemTransform', { sceneItemTransform: { sourceWidth: 1080, sourceHeight: 1920 } });
      await vi.advanceTimersByTimeAsync(20); await seek;
      expect(native).toHaveBeenCalledTimes(1);
      expect(calls.filter(call => call.requestType === 'TriggerMediaInputAction')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('暂停完成精确定位后再继续，首次入场及机位返回每次只定位一次', async () => {
    const { scenes, calls } = fixture(false, true);
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    await scenes.execute(event, 'C:/dance.mp4');
    await scenes.switchScene('机位');
    await scenes.execute({ ...event, sourceOffsetMs: 6534 }, 'C:/dance.mp4');
    expect(calls.filter((entry) => entry.requestType === 'SetMediaInputCursor').map((entry) => entry.requestData))
      .toEqual([2300, 6534].map((mediaCursor) => ({ inputName: names.sourceName, mediaCursor })));
  });
  it('预检不重播未激活的来源，避免重播与暂停争用解码器', async () => {
    const { scenes, calls } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    expect(calls.some((entry) => entry.requestType === 'TriggerMediaInputAction')).toBe(false);
    expect(calls.some((entry) => entry.requestType === 'SetCurrentProgramScene')).toBe(false);
  });
  it('从零开始先激活素材场景再重播，避免未激活来源残留旧位置', async () => {
    const { scenes, calls, responses } = fixture();
    await scenes.prepare('project', asset, 'C:/dance.mp4'); calls.length = 0;
    responses.set('GetMediaInputStatus', { mediaState: 'OBS_MEDIA_STATE_PLAYING', mediaCursor: 0 });
    await scenes.execute({ ...event, sourceOffsetMs: 0 }, 'C:/dance.mp4');
    const sceneIndex = calls.findIndex((entry) => entry.requestType === 'SetCurrentProgramScene');
    const restartIndex = calls.findIndex((entry) => entry.requestType === 'TriggerMediaInputAction'
      && typeof entry.requestData === 'object' && entry.requestData !== null && 'mediaAction' in entry.requestData
      && entry.requestData.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART');
    expect(sceneIndex).toBeGreaterThanOrEqual(0);
    expect(restartIndex).toBeGreaterThan(sceneIndex);
  });
  it('切场景前位置正确、切场景后被 OBS 重置时不能报告成功', async () => {
    const { scenes } = fixture(true);
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    await expect(scenes.execute(event, 'C:/dance.mp4')).rejects.toThrow('切场景后素材位置不一致：舞蹈.mp4，目标 2300 ms，OBS 实际 0 ms');
  });
  it('播放时启动解码器并按位置切换，回读实际状态', async () => {
    const { scenes, calls } = fixture(); await scenes.prepare('project', asset, 'C:/dance.mp4'); calls.length = 0;
    await scenes.execute(event, 'C:/dance.mp4');
    expect(calls.slice(0, 4).map((call) => call.requestType)).toEqual(['SetInputMute', 'SetSceneItemEnabled', 'SetCurrentProgramScene', 'TriggerMediaInputAction']);
    expect(calls.find((call) => call.requestType === 'SetMediaInputCursor')?.requestData).toEqual({ inputName: names.sourceName, mediaCursor: 2300 });
    expect(calls[2]?.requestData).toEqual({ sceneName: names.sceneName });
  });
  it('机位插入只静音底层视频，切回对应位置不发重播或重新定位', async () => {
    const { scenes, calls, responses } = fixture(); await scenes.prepare('project', asset, 'C:/dance.mp4');
    await scenes.execute(event, 'C:/dance.mp4'); calls.length = 0;
    await scenes.switchScene('拉腿机位');
    expect(calls.map((call) => call.requestType)).toEqual(['SetCurrentProgramScene', 'SetInputMute']);
    responses.set('GetMediaInputStatus', { mediaState: 'OBS_MEDIA_STATE_PLAYING', mediaCursor: 7300 });
    calls.length = 0; await scenes.execute({ ...event, sourceOffsetMs: 7300 }, 'C:/dance.mp4');
    expect(calls.some((call) => call.requestType === 'SetMediaInputCursor')).toBe(false);
    expect(calls.filter((call) => call.requestType === 'TriggerMediaInputAction')).toHaveLength(0);
  });
  it('重新使用已有素材场景也关闭激活重播和隐藏卸载，保留其他来源设置', async () => {
    const { scenes, calls, responses } = fixture();
    responses.set('GetSceneList', { scenes: [{ sceneName: names.sceneName }] });
    responses.set('GetSceneItemList', { sceneItems: [{ sourceName: names.sourceName, sceneItemId: 1 }] });
    responses.set('GetInputSettings', { inputKind: 'ffmpeg_source', inputSettings: {
      local_file: 'C:/dance.mp4', restart_on_activate: true, close_when_inactive: true, looping: true, speed_percent: 100
    } });
    await scenes.prepare('project', asset, 'C:/dance.mp4');
    expect(calls.filter((call) => call.requestType === 'SetInputSettings')).toEqual([{
      requestType: 'SetInputSettings', requestData: { inputName: names.sourceName,
        inputSettings: { restart_on_activate: false, close_when_inactive: false, looping: false }, overlay: true }
    }]);
    expect(calls.some((call) => call.requestType === 'SetSceneItemTransform' || call.requestType.startsWith('Remove'))).toBe(false);
  });
  it('OBS 接受指令但未播放时必须报错，停止仍可清理该来源', async () => {
    const { scenes, responses, calls } = fixture(); await scenes.prepare('project', asset, 'C:/dance.mp4');
    responses.set('GetMediaInputStatus', { mediaState: 'OBS_MEDIA_STATE_ERROR', mediaCursor: 0 });
    await expect(scenes.execute(event, 'C:/dance.mp4')).rejects.toThrow('未进入');
    await scenes.execute({ ...event, phase: 'stop' }, 'C:/dance.mp4');
    expect(calls.at(-1)).toEqual({ requestType: 'SetSceneItemEnabled', requestData: { sceneName: names.sceneName, sceneItemId: 1, sceneItemEnabled: false } });
  });
  it('同名场景没有对应素材时拒绝覆盖，普通机位只切场景', async () => {
    const { scenes, responses, calls } = fixture();
    responses.set('GetSceneList', { scenes: [{ sceneName: names.sceneName }] });
    responses.set('GetSceneItemList', { sceneItems: [{ sourceName: '显示器采集', sceneItemId: 1 }] });
    await expect(scenes.prepare('project', asset, 'C:/dance.mp4')).rejects.toThrow('被占用');
    expect(calls.some((call) => call.requestType.startsWith('Set') || call.requestType.startsWith('Remove'))).toBe(false);
    calls.length = 0; await scenes.switchScene('拉腿机位');
    expect(calls).toEqual([{ requestType: 'SetCurrentProgramScene', requestData: { sceneName: '拉腿机位' } }]);
  });
});
