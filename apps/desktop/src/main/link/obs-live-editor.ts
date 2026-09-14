import { obsLiveItemSchema, type ObsLiveEdit, type ObsLiveScene } from '@tb/schema';
import type { OBSWebSocket } from 'obs-websocket-js';

export class ObsLiveEditor {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly client: OBSWebSocket, private readonly request: <T>(promise: Promise<T>, label: string) => Promise<T>) {
    for (const event of ['CurrentProgramSceneChanged', 'SceneItemTransformChanged', 'SceneItemEnableStateChanged', 'SceneItemLockStateChanged', 'SceneItemListReindexed', 'SceneItemCreated', 'SceneItemRemoved', 'InputNameChanged'] as const) {
      client.on(event, () => { for (const listener of this.listeners) listener(); });
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async read(): Promise<ObsLiveScene> {
    const scene = await this.request(this.client.call('GetCurrentProgramScene'), '读取 OBS 当前画面');
    const [items, video] = await Promise.all([
      this.request(this.client.call('GetSceneItemList', { sceneName: scene.sceneName }), '读取 OBS 画布来源'),
      this.request(this.client.call('GetVideoSettings'), '读取 OBS 画布尺寸')
    ]);
    return { sceneName: scene.sceneName, width: video.baseWidth, height: video.baseHeight, items: items.sceneItems.map((item) => obsLiveItemSchema.parse(item)) };
  }
  async edit(edit: ObsLiveEdit): Promise<void> {
    const scene = await this.request(this.client.call('GetCurrentProgramScene'), '确认 OBS 编辑场景');
    if (scene.sceneName !== edit.sceneName) throw new Error('OBS 场景已切换，本次编辑已停止');
    const target = { sceneName: edit.sceneName, sceneItemId: edit.sceneItemId };
    const locked = await this.request(this.client.call('GetSceneItemLocked', target), '确认来源锁定状态');
    if (locked.sceneItemLocked && (edit.transform || edit.enabled !== undefined)) throw new Error('OBS 来源已锁定');
    const transform: Record<string, number> = {};
    for (const [key, value] of Object.entries(edit.transform ?? {})) if (value !== undefined) transform[key] = value;
    if (edit.transform) await this.request(this.client.call('SetSceneItemTransform', { ...target, sceneItemTransform: transform }), '同步 OBS 来源变换');
    if (edit.locked !== undefined) await this.request(this.client.call('SetSceneItemLocked', { ...target, sceneItemLocked: edit.locked }), '同步 OBS 来源锁定');
    if (edit.enabled !== undefined) await this.request(this.client.call('SetSceneItemEnabled', { ...target, sceneItemEnabled: edit.enabled }), '同步 OBS 来源显隐');
  }
}
