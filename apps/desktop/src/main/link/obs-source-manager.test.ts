import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OBSWebSocket } from 'obs-websocket-js';
import { obsSourceKinds, obsSourceSettingsSchema, type ObsSourceKind } from '@tb/schema';
import { ObsSourceManager } from './obs-source-manager';

function setup() {
  const calls: { method: string; data: Record<string, unknown> }[] = [];
  let settings: Record<string, unknown> = {};
  const client = { call(method: string, data: Record<string, unknown> = {}): Promise<unknown> {
    calls.push({ method, data });
    switch (method) {
      case 'GetInputKindList': return Promise.resolve({ inputKinds: Object.values(obsSourceKinds).map((kind) => kind.inputKind) });
      case 'CreateInput': return Promise.resolve({ sceneItemId: 42 });
      case 'GetInputPropertiesListPropertyItems': return Promise.resolve({ propertyItems: [{ itemName: '可用设备', itemValue: 'device-1', itemEnabled: true }, { itemName: '离线设备', itemValue: 'offline', itemEnabled: false }] });
      case 'SetInputSettings': settings = data.inputSettings as Record<string, unknown>; return Promise.resolve({});
      case 'GetInputSettings': return Promise.resolve({ inputSettings: settings });
      case 'GetSceneItemEnabled': return Promise.resolve({ sceneItemEnabled: true });
      default: return Promise.resolve({});
    }
  } };
  const manager = new ObsSourceManager(client as unknown as OBSWebSocket, (operation) => operation(), (operation) => operation());
  return { manager, calls, client };
}

describe('OBS 来源添加闭环', () => {
  it('图片只加入指定机位场景，不修改已有来源的滤镜、变换或显隐', async () => {
    const { manager, calls } = setup();
    const directory = await mkdtemp(join(tmpdir(), 'tblink-scene-image-')); const path = join(directory, 'image.png'); await writeFile(path, 'image-fixture');
    const draft = await manager.create({ kind: 'image', name: '背景', sceneName: '近景拉腿' });
    await manager.apply(draft.inputName, obsSourceSettingsSchema.parse({ path }));
    expect(calls.find((call) => call.method === 'CreateInput')?.data).toMatchObject({ sceneName: '近景拉腿', inputKind: 'image_source' });
    expect(calls.find((call) => call.method === 'SetInputSettings')?.data.inputSettings).toEqual({ file: path, unload: true });
    expect(calls.filter((call) => call.method === 'SetSceneItemEnabled')).toEqual([{ method: 'SetSceneItemEnabled', data: { sceneName: '近景拉腿', sceneItemId: draft.sceneItemId, sceneItemEnabled: true } }]);
    expect(calls.some((call) => /Transform|Filter|CurrentProgram/.test(call.method))).toBe(false);
  });
  it.each(Object.keys(obsSourceKinds) as ObsSourceKind[])('%s 创建真实类型，草稿不可见，取消只移除自有草稿', async (kind) => {
    const { manager, calls } = setup();
    const draft = await manager.create({ kind, name: '测试', sceneName: '拉腿场景' });
    expect(calls.find((call) => call.method === 'CreateInput')?.data).toMatchObject({ sceneName: '拉腿场景', inputKind: obsSourceKinds[kind].inputKind, sceneItemEnabled: false });
    await expect(manager.cancel('用户摄像头')).rejects.toThrow('不能覆盖或删除');
    await manager.cancel(draft.inputName);
    expect(calls.filter((call) => call.method === 'RemoveInput')).toEqual([{ method: 'RemoveInput', data: { inputName: draft.inputName } }]);
    expect(calls.some((call) => /Transform|Filter|CurrentProgram/.test(call.method))).toBe(false);
  });
  it.each(['camera', 'window', 'display', 'audioInput', 'audioOutput'] as const)('%s 验证设备仍在线，回读设置后才能启用', async (kind) => {
    const { manager, calls } = setup(); const draft = await manager.create({ kind, name: '测试', sceneName: '场景' });
    await expect(manager.apply(draft.inputName, obsSourceSettingsSchema.parse({ device: 'offline' }))).rejects.toThrow('可用');
    expect(calls.some((call) => call.method === 'SetInputSettings')).toBe(false);
    await manager.apply(draft.inputName, obsSourceSettingsSchema.parse({ device: 'device-1' }));
    expect(calls.find((call) => call.method === 'SetInputSettings')?.data.inputSettings).toEqual({ [obsSourceKinds[kind].property]: 'device-1' });
    expect(calls.findIndex((call) => call.method === 'GetInputSettings')).toBeLessThan(calls.findIndex((call) => call.method === 'SetSceneItemEnabled'));
    await expect(manager.cancel(draft.inputName)).rejects.toThrow('不能覆盖或删除');
  });
  it('文本与浏览器保存内容及尺寸，不能提交脚本地址', async () => {
    const { manager, calls } = setup(); const draft = await manager.create({ kind: 'browser', name: '网页', sceneName: '场景' });
    await expect(manager.apply(draft.inputName, obsSourceSettingsSchema.parse({ url: 'javascript:alert(1)' }))).rejects.toThrow('http');
    await manager.apply(draft.inputName, obsSourceSettingsSchema.parse({ url: 'https://example.com', width: 720, height: 1280 }));
    expect(calls.find((call) => call.method === 'SetInputSettings')?.data.inputSettings).toEqual({ url: 'https://example.com/', width: 720, height: 1280 });
    const text = await manager.create({ kind: 'text', name: '字幕', sceneName: '场景' });
    await manager.apply(text.inputName, obsSourceSettingsSchema.parse({ text: '你好', fontSize: 80 }));
    expect(calls.filter((call) => call.method === 'SetInputSettings').at(-1)?.data.inputSettings).toMatchObject({ text: '你好', font: { size: 80 } });
  });
  it('媒体文件写入 OBS，并在刷新时只清理未完成来源', async () => {
    const { manager, calls } = setup();
    const directory = await mkdtemp(join(tmpdir(), 'tb-source-'));
    const path = join(directory, 'test.wav'); await writeFile(path, 'fixture');
    const media = await manager.create({ kind: 'media', name: '视频', sceneName: '场景' });
    await manager.apply(media.inputName, obsSourceSettingsSchema.parse({ path, looping: true }));
    expect(calls.find((call) => call.method === 'SetInputSettings')?.data.inputSettings).toMatchObject({ local_file: path, looping: true, is_local_file: true });
    const unfinished = await manager.create({ kind: 'text', name: '未完成', sceneName: '场景' });
    await manager.discardPending();
    expect(calls.filter((call) => call.method === 'RemoveInput')).toEqual([{ method: 'RemoveInput', data: { inputName: unfinished.inputName } }]);
  });
  it('OBS 回读不一致时不能显示来源' , async () => {
    const { manager, calls, client } = setup(); const call = client.call.bind(client);
    client.call = (method, data) => method === 'GetInputSettings' ? Promise.resolve({ inputSettings: {} }) : call(method, data);
    const draft = await manager.create({ kind: 'text', name: '字幕', sceneName: '场景' });
    await expect(manager.apply(draft.inputName, obsSourceSettingsSchema.parse({ text: '测试' }))).rejects.toThrow('没有确认');
    expect(calls.some((entry) => entry.method === 'SetSceneItemEnabled')).toBe(false);
  });
});
