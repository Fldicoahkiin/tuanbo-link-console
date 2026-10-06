import { expect, it, vi } from 'vitest';
import { OBSWebSocket } from 'obs-websocket-js';
import { ObsLiveEditor } from './obs-live-editor';

it('场景切换或来源锁定时拒绝写入', async () => {
  const client = new OBSWebSocket();
  const call = vi.spyOn(client, 'call');
  call.mockResolvedValue({ sceneName: '其他场景', sceneUuid: 'id', currentProgramSceneName: '其他场景', currentProgramSceneUuid: 'id' });
  const editor = new ObsLiveEditor(client, (operation) => operation(), (operation) => operation());
  await expect(editor.edit({ sceneName: '当前场景', sceneItemId: 1, transform: { positionX: 20 } })).rejects.toThrow('场景已切换');
  expect(call).toHaveBeenCalledTimes(1);
  call.mockReset();
  call.mockResolvedValueOnce({ sceneName: '当前场景', sceneUuid: 'id', currentProgramSceneName: '当前场景', currentProgramSceneUuid: 'id' }).mockResolvedValueOnce({ sceneItemLocked: true });
  await expect(editor.edit({ sceneName: '当前场景', sceneItemId: 1, transform: { positionX: 20 } })).rejects.toThrow('已锁定');
  expect(call).toHaveBeenCalledTimes(2);
});

it('只更新指定来源的指定属性', async () => {
  const client = new OBSWebSocket();
  const call = vi.spyOn(client, 'call').mockResolvedValueOnce({ sceneName: '当前场景', sceneUuid: 'id', currentProgramSceneName: '当前场景', currentProgramSceneUuid: 'id' }).mockResolvedValueOnce({ sceneItemLocked: false }).mockResolvedValueOnce(undefined);
  await new ObsLiveEditor(client, (operation) => operation(), (operation) => operation()).edit({ sceneName: '当前场景', sceneItemId: 7, transform: { positionX: 123 } });
  expect(call).toHaveBeenLastCalledWith('SetSceneItemTransform', { sceneName: '当前场景', sceneItemId: 7, sceneItemTransform: { positionX: 123 } });
});
