import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OBSWebSocket } from 'obs-websocket-js';
import type { ManagedMediaEvent } from '@tb/core/link';
import { describe, expect, it } from 'vitest';
import { ObsWebSocketAdapter } from './obs-websocket-adapter';
import type { ObsEditorPreview } from './obs-editor-preview';

describe('ObsWebSocketAdapter', () => {
  it('完整场景模式的显示来源作用于当前播出场景；场景中没有或有多个同名来源时明确报错（操作员决定 2026-10-19）', async () => {
    const client = fakeObsClient(); const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    client.responses.set('GetCurrentProgramScene', { currentProgramSceneName: '场景 2' });
    client.responses.set('GetSceneItemList', { sceneItems: [{ sourceName: '显示器采集', sceneItemId: 7 }, { sourceName: '扑克牌特效.mov', sceneItemId: 3 }] });
    client.calls.length = 0;
    await adapter.setSourceEnabledInProgramScene('显示器采集', true);
    expect(client.calls).toEqual([['GetCurrentProgramScene', undefined], ['GetSceneItemList', { sceneName: '场景 2' }],
      ['SetSceneItemEnabled', { sceneName: '场景 2', sceneItemId: 7, sceneItemEnabled: true }]]);
    await expect(adapter.setSourceEnabledInProgramScene('显示器采集 3', true)).rejects.toThrow('当前播出场景“场景 2”中没有来源“显示器采集 3”');
    client.responses.set('GetSceneItemList', { sceneItems: [{ sourceName: '扑克牌特效.mov', sceneItemId: 3 }, { sourceName: '扑克牌特效.mov', sceneItemId: 4 }] });
    await expect(adapter.setSourceEnabledInProgramScene('扑克牌特效.mov', true)).rejects.toThrow('有多个来源“扑克牌特效.mov”');
  });
  it('显示来源后播出场景已切换，隐藏仍作用于当初显示它的场景，不在新播出场景里找', async () => {
    const client = fakeObsClient(); const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    client.responses.set('GetCurrentProgramScene', { currentProgramSceneName: '场景 2' });
    client.responses.set('GetSceneItemList', { sceneItems: [{ sourceName: '扑克牌特效.mov', sceneItemId: 3 }] });
    await adapter.setSourceEnabledInProgramScene('扑克牌特效.mov', true);
    client.responses.set('GetCurrentProgramScene', { currentProgramSceneName: '团播联动台·素材·387..MP4' });
    client.responses.set('GetSceneItemList', { sceneItems: [{ sourceName: '387..MP4·来源', sceneItemId: 1 }] });
    client.calls.length = 0;
    await adapter.setSourceEnabledInProgramScene('扑克牌特效.mov', false);
    expect(client.calls).toEqual([['SetSceneItemEnabled', { sceneName: '场景 2', sceneItemId: 3, sceneItemEnabled: false }]]);
    await expect(adapter.setSourceEnabledInProgramScene('扑克牌特效.mov', false)).rejects.toThrow('中没有来源“扑克牌特效.mov”');
  });
  it('监听拒绝被桌面音频或模糊进程采集，仅核对专用音频来源且不修改 OBS', async () => {
    const client = fakeObsClient(); const adapter = new ObsWebSocketAdapter(tmpdir(),client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455','password');
    client.responses.set('GetInputList',{inputs:[{inputName:'正式音频',inputKind:'wasapi_process_output_capture'},...Array.from({length:2000},(_,index)=>({inputName:`视频${index}`,inputKind:'ffmpeg_source'}))]});
    client.responses.set('GetSpecialInputs',{});client.responses.set('GetInputMute',{inputMuted:false});
    client.responses.set('GetInputSettings',{inputKind:'wasapi_output_capture',inputSettings:{device_id:'headphones'}});
    const identity={executable:'tblink-playback.exe',title:'Monitor-1',windowClass:'TBLINK',ownerExecutable:'electron.exe'};
    await expect(adapter.assertMusicMonitorIsolation('headphones',false,identity)).rejects.toThrow('被 OBS');
    client.responses.set('GetInputSettings',{inputKind:'wasapi_process_output_capture',inputSettings:{window:'Music:TBLINK:tblink-playback.exe',priority:1}});
    await expect(adapter.assertMusicMonitorIsolation('headphones',false,identity)).rejects.toThrow('可能采集');
    client.responses.set('GetInputSettings',{inputKind:'wasapi_process_output_capture',inputSettings:{window:'Music:TBLINK:tblink-playback.exe',priority:0}}); client.calls.length=0;
    await adapter.assertMusicMonitorIsolation('headphones',false,identity);
    expect(client.calls.map(([request])=>request)).toEqual(['GetInputList','GetSpecialInputs','GetInputSettings','GetInputMute']);
    client.responses.set('GetInputSettings',{inputKind:'wasapi_process_output_capture',inputSettings:{window:'联动台:Chrome:electron.exe',priority:0}});await expect(adapter.assertMusicMonitorIsolation('headphones',false,identity)).rejects.toThrow('子进程');
    let stopped=0;const unsubscribe=adapter.subscribeMusicMonitorRouteChange(()=>{stopped++;});client.emit('InputSettingsChanged',{});expect(stopped).toBe(1);unsubscribe();client.emit('InputSettingsChanged',{});expect(stopped).toBe(1);
  });
  it('旧场景回报不能吞掉下一次开场 Cue，连续两次明确动作均发送', async () => {
    const client = fakeObsClient(); const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password'); client.calls.length = 0;
    const action = { id: 'opening', label: '开场', kind: 'obs.setProgramScene' as const, sceneName: 'Camera' };
    client.emit('CurrentProgramSceneChanged', { sceneName: 'Camera' });
    // Another operator has switched OBS, but its asynchronous event is delayed.
    await adapter.execute(action); await adapter.execute(action);
    expect(client.calls).toEqual([['SetCurrentProgramScene', { sceneName: 'Camera' }], ['SetCurrentProgramScene', { sceneName: 'Camera' }]]);
  });
  it('播放预检保留完整名称索引，只读取当前目标详情，不随历史节目累积全扫', async () => {
    const client = fakeObsClient();
    client.responses.set('GetInputList', { inputs: Array.from({ length: 2000 }, (_, index) => ({ inputName: `素材${index}`, inputKind: 'ffmpeg_source' })) });
    client.responses.set('GetSceneList', { scenes: Array.from({ length: 2000 }, (_, index) => ({ sceneName: `场景${index}` })) });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password'); client.calls.length = 0;
    const inventory = await adapter.readInventory({ scenes: new Set(['场景8']), inputs: new Set(['素材7']) });
    expect(inventory.inputs).toHaveLength(2000); expect(inventory.scenes).toHaveLength(2000);
    expect(Object.keys(inventory.filters)).toEqual(['素材7']);
    expect(Object.keys(inventory.sceneItems)).toEqual(['场景8']);
    expect(client.calls.filter(([request]) => request === 'GetSceneItemList')).toEqual([['GetSceneItemList', { sceneName: '场景8' }]]);
    expect(client.calls.filter(([request]) => request === 'GetSourceFilterList')).toEqual([['GetSourceFilterList', { sourceName: '素材7' }]]);
    expect(client.calls).toHaveLength(7);
  });
  it('2000 个素材目录按有界请求读取，不一次发出全部查询', async () => {
    const client = fakeObsClient();
    client.responses.set('GetInputList', { inputs: Array.from({ length: 2000 }, (_, index) => ({ inputName: `素材${index}`, inputKind: 'ffmpeg_source' })) });
    const call = client.call.bind(client);
    let active = 0, maximum = 0;
    client.call = async (request, data) => {
      active++; maximum = Math.max(maximum, active);
      try { return await call(request, data); } finally { active--; }
    };
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    const inventory = await adapter.readInventory();
    expect(inventory.inputs).toHaveLength(2000);
    expect(Object.keys(inventory.filters)).toHaveLength(2000);
    expect(maximum).toBeLessThanOrEqual(3);
  });

  it('已连接但不响应的 OBS 超时后变为错误，不能继续发送下一动作', async () => {
    const client = fakeObsClient();
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket, 20);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    client.pendingRequests.add('SetCurrentProgramScene');
    await expect(adapter.execute({ id: 'first', label: '切换', kind: 'obs.setProgramScene', sceneName: '近景' })).rejects.toThrow('执行结果不明');
    expect(adapter.getSnapshot().status).toBe('error');
    const count = client.calls.length;
    await expect(adapter.execute({ id: 'second', label: '不得自动重发', kind: 'obs.setProgramScene', sceneName: '全景' })).rejects.toThrow('尚未连接');
    expect(client.calls).toHaveLength(count);
  });

  it('场景预览保持可见采集来源，跳过隐藏项且不切换正式场景', async () => {
    const client = fakeObsClient();
    client.responses.set('GetSceneItemList', { sceneItems: [
      { sourceName: 'Camera', sceneItemEnabled: true },
      { sourceName: 'Hidden', sceneItemEnabled: false },
      { sourceName: 'Group', sceneItemEnabled: true, isGroup: true }
    ] });
    client.responses.set('GetGroupSceneItemList', { sceneItems: [{ sourceName: 'Screen', sceneItemEnabled: true }] });
    const touched: string[] = [];
    const preview = { configure: () => undefined, touch: (name: string) => { touched.push(name); return Promise.resolve(); } };
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket, 2000, preview as unknown as ObsEditorPreview);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    client.calls.length = 0;
    await adapter.getSourceScreenshot('Program');
    expect(touched).toEqual(['Camera', 'Screen']);
    expect(client.calls.some(([request]) => request.startsWith('Set'))).toBe(false);
  });
  it.each([false, true])('Cue 先设置转场再切机位，固定转场不写时长：%s', async (fixed) => {
    const client = fakeObsClient();
    client.responses.set('GetCurrentSceneTransition', { transitionFixed: fixed });
    client.responses.set('GetSceneSceneTransitionOverride', { transitionName: null, transitionDuration: null });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password'); client.calls.length = 0;
    await adapter.execute({ id: 'cue-transition', label: '切机位', kind: 'obs.setProgramScene', sceneName: '近景', transition: { name: 'Fade', durationMs: 650 } });
    expect(client.calls).toEqual([
      ['SetCurrentSceneTransition', { transitionName: 'Fade' }], ['GetCurrentSceneTransition', undefined],
      ...(!fixed ? [['SetCurrentSceneTransitionDuration', { transitionDuration: 650 }]] : []),
      ['GetSceneSceneTransitionOverride', { sceneName: '近景' }],
      ['SetCurrentProgramScene', { sceneName: '近景' }]
    ]);
  });
  it('Cue 转场暂时绕过场景自身覆盖，切换后恢复原覆盖', async () => {
    const client = fakeObsClient();
    client.responses.set('GetCurrentSceneTransition', { transitionFixed: false });
    client.responses.set('GetSceneSceneTransitionOverride', { transitionName: 'Cut', transitionDuration: 0 });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password'); client.calls.length = 0;
    await adapter.execute({ id: 'a', label: '切换', kind: 'obs.setProgramScene', sceneName: '近景', transition: { name: 'Fade', durationMs: 650 } });
    expect(client.calls.slice(-3)).toEqual([
      ['SetSceneSceneTransitionOverride', { sceneName: '近景', transitionName: '', transitionDuration: 0 }],
      ['SetCurrentProgramScene', { sceneName: '近景' }],
      ['SetSceneSceneTransitionOverride', { sceneName: '近景', transitionName: 'Cut', transitionDuration: 0 }]
    ]);
  });
  it('OBS 场景变化通知订阅者，取消订阅后不再通知', () => {
    const client = fakeObsClient(); const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    let notifications = 0; const unsubscribe = adapter.subscribeInventoryChanges(() => { notifications++; });
    client.emit('SceneCreated', { sceneName: '机位 2' }); client.emit('SceneNameChanged', { sceneName: '机位 3' });
    expect(notifications).toBe(2); unsubscribe(); client.emit('SceneRemoved', { sceneName: '机位 3' }); expect(notifications).toBe(2);
  });
  it('切换机位只切换 OBS 场景，不改变任何来源显隐、滤镜或变换', async () => {
    const client = fakeObsClient(); const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password'); client.calls.length = 0;
    await adapter.execute({ id: 'camera', label: '切机位', kind: 'obs.setProgramScene', sceneName: '近景拉腿' });
    expect(client.calls).toEqual([['SetCurrentProgramScene', { sceneName: '近景拉腿' }]]);
  });
  it('完整场景只添加自有音频项，保留用户视觉源、滤镜和变换', async () => {
    const client = fakeObsClient();
    client.responses.set('GetInputList', { inputs: [{ inputName: '团播联动台·内部正式音频', inputKind: 'wasapi_process_output_capture' }] });
    client.responses.set('GetInputPropertiesListPropertyItems', { propertyItems: [{ itemValue: 'app:Chrome_WidgetWin_1:app.exe' }] });
    client.responses.set('GetCurrentProgramScene', { currentProgramSceneName: '全景拉腿' });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket); await adapter.connect('ws://127.0.0.1:4455', 'password');
    await adapter.setInternalAudioCapture(true, 'app.exe', 'app', 'default', ['近景拉腿', '近景拉腿']);
    const created = client.calls.filter(([method]) => method === 'CreateSceneItem');
    expect(created).toContainEqual(['CreateSceneItem', { sceneName: '全景拉腿', sourceName: '团播联动台·内部正式音频', sceneItemEnabled: true }]);
    expect(created.filter(([, data]) => typeof data === 'object' && data !== null && 'sceneName' in data && data.sceneName === '近景拉腿')).toHaveLength(1);
    expect(client.calls.some(([method]) => ['SetSceneItemTransform', 'SetSourceFilterSettings', 'SetSourceFilterEnabled', 'SetCurrentProgramScene'].includes(method))).toBe(false);
  });
  it('默认桌面音频已采集音乐时复用该通路，不能再创建第二路', async () => {
    const client = fakeObsClient();
    client.responses.set('GetSpecialInputs', { desktop1: '桌面音频', desktop2: null });
    client.responses.set('GetInputVolume', { inputVolumeMul: 1 });
    client.responses.set('GetInputSettings', { inputSettings: { device_id: 'default' } });
    client.responses.set('GetInputAudioTracks', { inputAudioTracks: { '1': true } });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket); await adapter.connect('ws://127.0.0.1:4455', 'password');
    await adapter.setInternalAudioCapture(true, 'app.exe', 'app');
    expect(client.calls.some(([method]) => method === 'CreateInput')).toBe(false);
    expect(client.calls.some(([method]) => method === 'SetInputMute')).toBe(false);
    client.responses.set('GetSpecialInputs', { desktop1: '桌面音频', desktop2: '桌面音频 2' });
    await expect(adapter.setInternalAudioCapture(true, 'app.exe', 'app')).rejects.toThrow('两路桌面音频');
  });
  it('原生音频首次创建就带精确窗口，重复准备不重置已就绪的采集目标', async () => {
    const client = fakeObsClient(), name = '团播联动台·内部正式音频';
    const window = 'TBLINK Audio 123:Static:tblink-playback.exe';
    client.responses.set('GetInputKindList', { inputKinds: ['wasapi_process_output_capture'] });
    client.responses.set('GetInputPropertiesListPropertyItems', { propertyItems: [{ itemValue: window, itemEnabled: true }] });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password'); client.calls.length = 0;
    await adapter.setInternalAudioCapture(true, 'tblink-playback.exe', 'TBLINK Audio 123', 'default', undefined, 'Static');
    expect(client.calls).toContainEqual(['CreateInput', { sceneName: '团播联动台输出', inputName: name,
      inputKind: 'wasapi_process_output_capture', inputSettings: { window, priority: 0 }, sceneItemEnabled: false }]);
    expect(client.calls.some(([method]) => method === 'SetInputSettings')).toBe(false);
    client.responses.set('GetInputList', { inputs: [{ inputName: name, inputKind: 'wasapi_process_output_capture' }] });
    client.responses.set('GetInputSettings', { inputSettings: { window, priority: 0 } }); client.calls.length = 0;
    await adapter.setInternalAudioCapture(true, 'tblink-playback.exe', 'TBLINK Audio 123', 'default', undefined, 'Static');
    expect(client.calls.some(([method]) => method === 'CreateInput' || method === 'SetInputSettings')).toBe(false);
    client.responses.set('GetInputPropertiesListPropertyItems', { propertyItems: [{ itemValue: 'TBLINK Audio 123:Other:tblink-playback.exe' }] });
    await expect(adapter.setInternalAudioCapture(true, 'tblink-playback.exe', 'TBLINK Audio 123', 'default', undefined, 'Static')).rejects.toThrow('身份不一致');
  });
  it('正式音乐仅绑定本软件窗口并关闭 OBS 监听，停止时静音隐藏', async () => {
    const client = fakeObsClient();
    const name = '团播联动台·内部正式音频';
    client.responses.set('GetInputList', { inputs: [{ inputName: name, inputKind: 'wasapi_process_output_capture' }] });
    client.responses.set('GetInputPropertiesListPropertyItems', { propertyItems: [
      { itemValue: '团播联动台:Chrome_WidgetWin_1:团播联动台.exe' },
      { itemValue: '其他应用:Chrome_WidgetWin_1:团播联动台.exe' }
    ] });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    await adapter.setInternalAudioCapture(true, '团播联动台.exe', '团播联动台');
    await adapter.setInternalAudioCapture(false, '团播联动台.exe', '团播联动台');
    expect(client.calls).toContainEqual(['SetInputAudioMonitorType', { inputName: name, monitorType: 'OBS_MONITORING_TYPE_NONE' }]);
    expect(client.calls).toContainEqual(['SetInputMute', { inputName: name, inputMuted: true }]);
    expect(client.calls).toContainEqual(['SetInputSettings', { inputName: name, inputSettings: { window: '团播联动台:Chrome_WidgetWin_1:团播联动台.exe', priority: 0 }, overlay: false }]);
  });
  it('同名其他类型的来源不得覆盖', async () => {
    const client = fakeObsClient(); client.responses.set('GetInputList', { inputs: [{ inputName: '团播联动台·内部正式音频', inputKind: 'dshow_input' }] });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket); await adapter.connect('ws://127.0.0.1:4455', 'password');
    await expect(adapter.setInternalAudioCapture(true, 'app.exe', 'app')).rejects.toThrow('名称被其他类型');
    expect(client.calls.some(([method]) => method === 'SetInputSettings')).toBe(false);
  });
  it('认证后执行官方 5.x 请求并解析库存', async () => {
    const client = fakeObsClient();
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    await adapter.execute({ id: 'scene', label: '切场景', kind: 'obs.setProgramScene', sceneName: 'Program' });
    await adapter.execute({
      id: 'item',
      label: '显示来源',
      kind: 'obs.setSceneItemEnabled',
      sceneName: 'Program',
      sourceName: 'Camera',
      enabled: true
    });
    await adapter.execute({ id: 'transform', label: '变换', kind: 'obs.setSceneItemTransform', sceneName: 'Program', sourceName: 'Camera', transform: { positionX: 1, positionY: 2, scaleX: 1, scaleY: 1, rotation: 3, cropTop: 4, cropRight: 5, cropBottom: 6, cropLeft: 7 } });
    await adapter.execute({ id: 'filter', label: '滤镜', kind: 'obs.setSourceFilterEnabled', sourceName: 'Camera', filterName: 'Color', enabled: false });
    await adapter.execute({ id: 'mute', label: '静音', kind: 'obs.setInputMute', inputName: 'Camera', muted: true });
    await adapter.execute({ id: 'volume', label: '音量', kind: 'obs.setInputVolume', inputName: 'Camera', volumeDb: -6 });
    await adapter.execute({ id: 'media', label: '媒体', kind: 'obs.mediaAction', inputName: 'Camera', action: 'restart' });
    await adapter.execute({ id: 'transition', label: '转场', kind: 'obs.setTransition', transitionName: 'Cut', durationMs: 250 });
    await adapter.execute({ id: 'screenshot', label: '截图', kind: 'obs.saveSourceScreenshot', sourceName: 'Camera', fileName: 'capture.png' });
    const inventory = await adapter.readInventory();
    const preview = await adapter.getSourceScreenshot('Camera', 720, 1280);
    const nativePreview = await adapter.getSourceScreenshot('Camera');

    expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', obsVersion: '32.2.2' });
    expect(client.calls).toEqual(expect.arrayContaining([
      ['SetCurrentProgramScene', { sceneName: 'Program' }],
      ['GetSceneItemId', { sceneName: 'Program', sourceName: 'Camera' }],
      ['SetSceneItemEnabled', { sceneName: 'Program', sceneItemId: 7, sceneItemEnabled: true }],
      ['SetSourceFilterEnabled', { sourceName: 'Camera', filterName: 'Color', filterEnabled: false }],
      ['SetInputMute', { inputName: 'Camera', inputMuted: true }],
      ['SetInputVolume', { inputName: 'Camera', inputVolumeDb: -6 }],
      ['TriggerMediaInputAction', { inputName: 'Camera', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }],
      ['SetCurrentSceneTransition', { transitionName: 'Cut' }],
      ['SetCurrentSceneTransitionDuration', { transitionDuration: 250 }],
      ['SaveSourceScreenshot', { sourceName: 'Camera', imageFormat: 'png', imageFilePath: join(tmpdir(), 'capture.png') }],
      ['GetSourceScreenshot', { sourceName: 'Camera', imageFormat: 'png', imageWidth: 720, imageHeight: 1280 }],
      ['GetSourceScreenshot', { sourceName: 'Camera', imageFormat: 'png' }]
    ]));
    expect(preview).toBe('data:image/png;base64,preview');
    expect(nativePreview).toBe('data:image/png;base64,preview');
    expect(inventory).toEqual({
      scenes: ['Program'],
      inputs: ['Camera'],
      inputKinds: { Camera: 'dshow_input' },
      inputAudioStates: { Camera: { supported: true, muted: false, error: null } },
      sceneItems: { Program: ['Camera'] },
      filters: { Camera: ['Color'] },
      transitions: ['Cut'],
      videoSettings: { baseWidth: 1080, baseHeight: 1920 },
      sourceSizes: {},
      sourceSizeErrors: {},
      sceneItemTransforms: { Program: { Camera: { positionX: 540, positionY: 960, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, sourceWidth: 1080, sourceHeight: 1920, outputWidth: 1080, outputHeight: 1920, alignment: 0 } } }
    });
  });

  it('显示器采集隐藏时仍从正式 OBS 显示器绑定解析原始尺寸', async () => {
    const client = fakeObsClient();
    client.responses.set('GetInputList', { inputs: [{ inputName: '显示器采集', inputKind: 'monitor_capture' }] });
    client.responses.set('GetSceneItemList', { sceneItems: [{
      sourceName: '显示器采集',
      sceneItemTransform: { positionX: 540, positionY: 960, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, sourceWidth: 0, sourceHeight: 0, width: 0, height: 0, alignment: 0 }
    }] });
    client.responses.set('GetInputSettings', { inputKind: 'monitor_capture', inputSettings: { monitor_id: 'display-primary' } });
    client.responses.set('GetInputPropertiesListPropertyItems', { propertyItems: [{ itemName: 'Display: 1920x1080 @ 0,0 (Primary)', itemValue: 'display-primary', itemEnabled: true }] });
    client.responses.set('GetMonitorList', { monitors: [{ monitorWidth: 1920, monitorHeight: 1080, monitorPositionX: 0, monitorPositionY: 0, monitorIndex: 0, monitorName: 'Display' }] });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');

    await expect(adapter.readInventory()).resolves.toMatchObject({ sourceSizes: { 显示器采集: { width: 1920, height: 1080 } } });
    expect(client.calls).toEqual(expect.arrayContaining([
      ['GetMonitorList', undefined],
      ['GetInputSettings', { inputName: '显示器采集' }],
      ['GetInputPropertiesListPropertyItems', { inputName: '显示器采集', propertyName: 'monitor_id' }]
    ]));
  });

  it('失效显示器不清空场景目录，不伪造尺寸，网络读取失败仍明确报错', async () => {
    const client = fakeObsClient();
    client.responses.set('GetInputList', { inputs: [{ inputName: '已拔出的显示器', inputKind: 'monitor_capture' }] });
    client.responses.set('GetInputSettings', { inputKind: 'monitor_capture', inputSettings: { monitor_id: 'missing' } });
    client.responses.set('GetInputPropertiesListPropertyItems', { propertyItems: [] });
    client.responses.set('GetMonitorList', { monitors: [] });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket, 10);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    const inventory = await adapter.readInventory();
    expect(inventory.scenes).toEqual(['Program']);
    expect(inventory.sourceSizes).toEqual({});
    expect(inventory.sourceSizeErrors?.['已拔出的显示器']).toContain('显示器绑定');
    expect(adapter.getSnapshot().status).toBe('connected');
    client.pendingRequests.add('GetInputSettings');
    await expect(adapter.readInventory()).rejects.toThrow('GetInputSettings');
  });

  it('鉴权失败明确进入 error，不吞错', async () => {
    const client = fakeObsClient();
    client.connectError = new Error('Authentication failed');
    const adapter = new ObsWebSocketAdapter('C:\\Screenshots', client as unknown as OBSWebSocket);
    await expect(adapter.connect('ws://127.0.0.1:4455', 'bad')).rejects.toThrow('Authentication failed');
    expect(adapter.getSnapshot()).toMatchObject({ status: 'error', error: 'Authentication failed' });
  });

  it('连接超时明确失败，断线事件更新状态', async () => {
    const client = fakeObsClient();
    client.connectPending = true;
    const adapter = new ObsWebSocketAdapter('C:\\Screenshots', client as unknown as OBSWebSocket);
    await expect(adapter.connect('ws://127.0.0.1:4455', 'password', 1)).rejects.toThrow('超过 1ms');
    expect(adapter.getSnapshot().status).toBe('error');

    const connectedClient = fakeObsClient();
    const connectedAdapter = new ObsWebSocketAdapter('C:\\Screenshots', connectedClient as unknown as OBSWebSocket);
    await connectedAdapter.connect('ws://127.0.0.1:4455', 'password');
    connectedClient.emit('ConnectionClosed', new Error('socket closed'));
    expect(connectedAdapter.getSnapshot()).toMatchObject({ status: 'disconnected', error: 'socket closed' });
    await expect(connectedAdapter.connect('ws://127.0.0.1:4455', 'password')).resolves.toMatchObject({ status: 'connected' });
  });

  it('库存和动作等直接 OBS 请求同样使用默认请求超时', async () => {
    const inventoryClient = fakeObsClient();
    const inventoryAdapter = new ObsWebSocketAdapter('C:\\Screenshots', inventoryClient as unknown as OBSWebSocket, 1);
    await inventoryAdapter.connect('ws://127.0.0.1:4455', 'password');
    inventoryClient.pendingRequests.add('GetSceneList');
    await expect(inventoryAdapter.readInventory()).rejects.toThrow('OBS GetSceneList 请求超过 1ms');

    const actionClient = fakeObsClient();
    const actionAdapter = new ObsWebSocketAdapter('C:\\Screenshots', actionClient as unknown as OBSWebSocket, 1);
    await actionAdapter.connect('ws://127.0.0.1:4455', 'password');
    actionClient.pendingRequests.add('SetCurrentProgramScene');
    await expect(actionAdapter.execute({
      id: 'scene',
      label: '切场景',
      kind: 'obs.setProgramScene',
      sceneName: 'Program'
    })).rejects.toThrow('OBS SetCurrentProgramScene 请求超过 1ms');
  });

  it('递归读取场景来源组中的摄像头', async () => {
    const client = fakeObsClient();
    client.responses.set('GetSceneItemList', { sceneItems: [{ sourceName: '机位组', isGroup: true }] });
    client.responses.set('GetGroupSceneItemList', { sceneItems: [{ sourceName: 'Camera', isGroup: false }] });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');

    await expect(adapter.readInventory()).resolves.toMatchObject({
      sceneItems: { Program: ['机位组'], 机位组: ['Camera'] }
    });
    expect(client.calls).toContainEqual(['GetGroupSceneItemList', { sceneName: '机位组' }]);
  });

  it('启动联动时切换到受管输出并读取当前 Program 场景确认', async () => {
    const client = fakeObsClient();
    client.responses.set('GetCurrentProgramScene', { currentProgramSceneName: '团播联动台输出' });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');

    await expect(adapter.activateManagedOutput()).resolves.toBeUndefined();
    expect(client.calls).toEqual(expect.arrayContaining([
      ['CreateScene', { sceneName: '团播联动台输出' }],
      ['SetCurrentProgramScene', { sceneName: '团播联动台输出' }],
      ['GetCurrentProgramScene', undefined]
    ]));
  });

  it('OBS 没有实际切换到受管输出时明确报错', async () => {
    const client = fakeObsClient();
    client.responses.set('GetCurrentProgramScene', { currentProgramSceneName: '原场景' });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');

    await expect(adapter.activateManagedOutput()).rejects.toThrow('OBS 未切换到受管输出场景：当前为 原场景');
  });

  it('在受管 OBS 场景中播放视频内嵌音频并按图层结束', async () => {
    const client = fakeObsClient();
    client.responses.set('CreateInput', { inputUuid: 'managed-input', sceneItemId: 21 });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    const start = managedMediaEvent('start');
    await adapter.executeManagedMediaEvent(start, 'C:\\Show\\clip.mp4');
    await adapter.executeManagedMediaEvent({ ...start, id: 'managed-media:clip:stop', phase: 'stop', frameNumber: 150 }, 'C:\\Show\\clip.mp4');

    expect(client.calls).toEqual(expect.arrayContaining([
      ['CreateScene', { sceneName: '团播联动台输出' }],
      ['CreateInput', {
        sceneName: '团播联动台输出',
        inputName: start.sourceName,
        inputKind: 'ffmpeg_source',
        inputSettings: {
          is_local_file: true,
          local_file: 'C:\\Show\\clip.mp4',
          looping: false,
          restart_on_activate: false,
          close_when_inactive: true,
          clear_on_media_end: true
        },
        sceneItemEnabled: false
      }],
      ['SetSceneItemTransform', {
        sceneName: '团播联动台输出',
        sceneItemId: 21,
        sceneItemTransform: { positionX: 540, positionY: 960, scaleX: 1, scaleY: 1, rotation: 0, alignment: 0 }
      }],
      ['SetSceneItemIndex', { sceneName: '团播联动台输出', sceneItemId: 21, sceneItemIndex: 1 }],
      ['SetInputMute', { inputName: start.sourceName, inputMuted: false }],
      ['TriggerMediaInputAction', { inputName: start.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }],
      ['SetMediaInputCursor', { inputName: start.sourceName, mediaCursor: 500 }],
      ['TriggerMediaInputAction', { inputName: start.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }]
    ]));
  });

  it('受管视频启动失败时立即停止媒体并隐藏场景项', async () => {
    const client = fakeObsClient();
    client.responses.set('CreateInput', { inputUuid: 'managed-input', sceneItemId: 21 });
    client.requestErrors.set('SetMediaInputCursor', new Error('seek failed'));
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    const start = managedMediaEvent('start');

    await expect(adapter.executeManagedMediaEvent(start, 'C:\\Show\\clip.mp4')).rejects.toThrow('seek failed');

    expect(client.calls.slice(-2)).toEqual([
      ['TriggerMediaInputAction', { inputName: start.sourceName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }],
      ['SetSceneItemEnabled', { sceneName: '团播联动台输出', sceneItemId: 21, sceneItemEnabled: false }]
    ]);
  });

  it('停止媒体失败时仍继续隐藏场景项并报告不完整停止', async () => {
    const client = fakeObsClient();
    client.responses.set('GetSceneItemId', { sceneItemId: 21 });
    client.requestErrors.set('TriggerMediaInputAction', new Error('stop failed'));
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    const stop = managedMediaEvent('stop');

    await expect(adapter.executeManagedMediaEvent(stop, 'C:\\Show\\clip.mp4'))
      .rejects.toThrow('OBS 受管素材停止不完整：stop failed');
    expect(client.calls.slice(-2)).toEqual([
      ['GetSceneItemId', { sceneName: '团播联动台输出', sourceName: stop.sourceName }],
      ['SetSceneItemEnabled', { sceneName: '团播联动台输出', sceneItemId: 21, sceneItemEnabled: false }]
    ]);
  });

  it('关闭非活动解码的视频先激活，再等待播放状态后定位入点', async () => {
    const client = fakeObsClient();
    client.responses.set('CreateInput', { inputUuid: 'managed-input', sceneItemId: 21 });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    const start = managedMediaEvent('start');

    await adapter.executeManagedMediaEvent(start, 'C:\\Show\\clip.mp4');
    const requests = client.calls.map(([request]) => request);
    expect(requests.indexOf('SetSceneItemEnabled')).toBeLessThan(requests.indexOf('TriggerMediaInputAction'));
    expect(requests.indexOf('TriggerMediaInputAction')).toBeLessThan(requests.indexOf('SetMediaInputCursor'));
    expect(requests.indexOf('GetMediaInputStatus')).toBeLessThan(requests.indexOf('SetMediaInputCursor'));
  });

  it('受管来源同名但类型不符时阻断，不覆盖用户来源', async () => {
    const client = fakeObsClient();
    client.responses.set('GetSceneList', { scenes: [{ sceneName: '团播联动台输出' }] });
    client.responses.set('GetInputList', { inputs: [{ inputName: managedMediaEvent('start').sourceName, inputKind: 'dshow_input' }] });
    const adapter = new ObsWebSocketAdapter(tmpdir(), client as unknown as OBSWebSocket);
    await adapter.connect('ws://127.0.0.1:4455', 'password');
    await expect(adapter.executeManagedMediaEvent(managedMediaEvent('start'), 'C:\\Show\\clip.mp4'))
      .rejects.toThrow('OBS 受管来源名称冲突');
    expect(client.calls.some(([request]) => request === 'SetInputSettings')).toBe(false);
  });
});

function managedMediaEvent(phase: ManagedMediaEvent['phase']): ManagedMediaEvent {
  return {
    id: `managed-media:clip:${phase}`,
    phase,
    frameNumber: phase === 'start' ? 0 : 150,
    itemId: 'item',
    clipId: 'clip',
    layerId: 'layer-top',
    layerIndex: 0,
    layerCount: 2,
    sourceName: '团播联动台·project·layer-top',
    assetId: 'asset',
    assetName: 'clip.mp4',
    assetKind: 'video',
    relativePath: 'assets/reference-media/clip.mp4',
    sourceOffsetMs: 500,
    embeddedAudioEnabled: true,
    transform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }
  };
}

type FakeObsClient = EventEmitter & {
  calls: Array<[string, unknown]>;
  connectError: Error | null;
  connectPending: boolean;
  pendingRequests: Set<string>;
  requestErrors: Map<string, Error>;
  responses: Map<string, unknown>;
  connect(url: string, password: string): Promise<unknown>;
  disconnect(): Promise<void>;
  call(request: string, data?: unknown): Promise<unknown>;
};

function fakeObsClient(): FakeObsClient {
  const client = Object.assign(new EventEmitter(), {
    calls: [] as Array<[string, unknown]>,
    connectError: null as Error | null,
    connectPending: false,
    pendingRequests: new Set<string>(),
    requestErrors: new Map<string, Error>(),
    responses: new Map<string, unknown>(),
    async connect(): Promise<unknown> {
      if (client.connectPending) return new Promise(() => undefined);
      if (client.connectError) throw client.connectError;
      return {};
    },
    disconnect(): Promise<void> {
      return Promise.resolve();
    },
    call(request: string, data?: unknown): Promise<unknown> {
      client.calls.push([request, data]);
      if (client.pendingRequests.has(request)) return new Promise(() => undefined);
      const requestError = client.requestErrors.get(request);
      if (requestError !== undefined) return Promise.reject(requestError);
      if (client.responses.has(request)) return Promise.resolve(client.responses.get(request));
      return Promise.resolve(responseFor(request));
    }
  });
  return client;
}

function responseFor(request: string): unknown {
  const responses: Record<string, unknown> = {
    GetSpecialInputs: { desktop1: null, desktop2: null },
    CreateSceneItem: { sceneItemId: 7 },
    GetVersion: { obsVersion: '32.2.2', obsWebSocketVersion: '5.6.3' },
    GetSceneItemId: { sceneItemId: 7 },
    GetSceneList: { scenes: [{ sceneName: 'Program' }] },
    GetInputList: { inputs: [{ inputName: 'Camera', inputKind: 'dshow_input' }] },
    GetSceneTransitionList: { transitions: [{ transitionName: 'Cut' }] },
    GetSceneItemList: { sceneItems: [{ sourceName: 'Camera', sceneItemTransform: { positionX: 540, positionY: 960, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, sourceWidth: 1080, sourceHeight: 1920, width: 1080, height: 1920, alignment: 0 } }] },
    GetVideoSettings: { baseWidth: 1080, baseHeight: 1920 },
    GetMediaInputStatus: { mediaState: 'OBS_MEDIA_STATE_PLAYING', mediaDuration: 10_000, mediaCursor: 0 },
    GetSourceFilterList: { filters: [{ filterName: 'Color' }] },
    GetInputMute: { inputMuted: false },
    GetInputSettings: { inputSettings: {} },
    GetStreamStatus: { outputActive: false },
    GetRecordStatus: { outputActive: false },
    GetSourceScreenshot: { imageData: 'data:image/png;base64,preview' }
  };
  return responses[request] ?? undefined;
}
