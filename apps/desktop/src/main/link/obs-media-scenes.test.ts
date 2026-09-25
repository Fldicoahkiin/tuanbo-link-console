import type { OBSWebSocket } from 'obs-websocket-js';
import { describe, expect, it, vi } from 'vitest';
import { materialSceneNames, type ManagedMediaEvent } from '@tb/core/link';
import type { LinkMediaAsset } from '@tb/schema';
import { ObsMediaScenes } from './obs-media-scenes';

const asset: LinkMediaAsset = { id: 'clip', name: '舞蹈.mp4', kind: 'video', folderId: null, relativePath: 'assets/dance.mp4', sha256: 'a'.repeat(64), byteLength: 10 };
const names = materialSceneNames('project', asset);
const event: ManagedMediaEvent = { ...names, id: 'start', phase: 'start', frameNumber: 194, itemId: 'song', clipId: 'clip', layerId: 'layer', layerIndex: 0, layerCount: 1, assetId: asset.id, assetName: asset.name, assetKind: 'video', relativePath: asset.relativePath, sourceOffsetMs: 2300, embeddedAudioEnabled: false, transform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } };

function fixture(resetOnSceneSwitch = false, seekNeedsPlayback = false) {
  const calls: Array<{ requestType: string; requestData?: unknown }> = [];
  const responses = new Map<string, unknown>([
    ['GetSceneList', { scenes: [] }], ['CreateInput', { sceneItemId: 1 }],
    ['GetVideoSettings', { baseWidth: 1080, baseHeight: 1920 }],
    ['GetSceneItemTransform', { sceneItemTransform: { sourceWidth: 1080, sourceHeight: 1920 } }],

  ]);
  let mediaState = 'OBS_MEDIA_STATE_STOPPED';
  let sceneSwitches = 0;
  let mediaCursor = seekNeedsPlayback ? 33 : 2300;
  let pendingCursor: number | undefined;
  const setMediaState = (state: string, cursor: number): void => { mediaState = state; mediaCursor = cursor; };
  const apply = (data: unknown): void => {
    if (typeof data !== 'object' || data === null) return;
    if ('mediaCursor' in data && typeof data.mediaCursor === 'number') pendingCursor = data.mediaCursor;
    if (!('mediaAction' in data)) return;
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
  return { calls, responses, setMediaState, scenes: new ObsMediaScenes(client as unknown as OBSWebSocket, (promise) => promise) };
}

describe('素材独立场景播放', () => {
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
  it('暂停定位的时钟需继续播放才能更新，首次入场及机位返回均应完成定位', async () => {
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
    expect(calls.filter((call) => call.requestType === 'TriggerMediaInputAction').map((call) => call.requestData)).toEqual([{ inputName: names.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' }]);
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
