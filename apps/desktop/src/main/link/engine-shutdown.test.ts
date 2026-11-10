import { expect, it, vi } from 'vitest';
import { closeEngineOutputs } from './engine-shutdown';
import type { ClosedProgramFaults } from './main-process-errors';

function faults() {
  const closeFailed = vi.fn<ClosedProgramFaults['closeFailed']>();
  return { closeFailed };
}

// 修复前：退出或界面重新加载时，画面、提前准备的画面或独立监听有一样没关掉，就整个算关闭失败：音频引擎从此不能再开，
// 之后的歌都放不了，也退不出软件。现在只有音频引擎自己关不掉才算失败（它占着声卡，新的不能再开）。
it('画面、提前准备的画面、独立监听没关掉：各说一次、记一次，关闭照常完成；只有音频引擎关不掉时才失败', async () => {
  const f = faults();
  await expect(closeEngineOutputs({ engine: Promise.resolve(), picture: Promise.reject(new Error('画面没有清理干净：Error: OBS 无响应（RemoveSceneItem 开场.mp4）')),
    preload: Promise.reject(new Error('画面没有清理干净：清理准备好的素材失败：OBS 素材场景批量控制 请求超时（2000 ms）')),
    monitor: Promise.reject(new Error('监听进程没有退出')) }, f)).resolves.toBeUndefined();
  expect(f.closeFailed.mock.calls).toEqual([
    ['画面没有清理干净，不影响之后播放。原因：OBS 无响应（RemoveSceneItem 开场.mp4）。请检查 OBS 节目画面上是否还留着刚才的素材',
      { level: 'error', category: 'device', device: '后台画面', message: '画面没有清理干净：OBS 无响应（RemoveSceneItem 开场.mp4）', result: 'failed' }],
    ['提前准备的画面没有清理干净，不影响播放。原因：清理准备好的素材失败：OBS 素材场景批量控制 请求超时（2000 ms）',
      { level: 'error', category: 'device', device: '后台画面', message: '提前准备的画面没有清理干净，不影响播放。原因：清理准备好的素材失败：OBS 素材场景批量控制 请求超时（2000 ms）', result: 'failed' }],
    // The monitor logged its failure itself.
    ['独立监听没能完全关掉，不影响之后播放。原因：监听进程没有退出', null]
  ]);
  const g = faults();
  await expect(closeEngineOutputs({ engine: Promise.reject(new Error('音频引擎没有响应')), picture: Promise.resolve(), preload: undefined, monitor: undefined }, g))
    .rejects.toThrow('音频引擎没有响应');
  expect(g.closeFailed).not.toHaveBeenCalled();
  await expect(closeEngineOutputs({ engine: undefined, picture: undefined, preload: undefined, monitor: undefined }, g)).resolves.toBeUndefined();
});

it('音频引擎关不掉时也等其他几样关完，它们没关掉的照样各说一次', async () => {
  const f = faults();
  let finish: () => void = () => { throw new Error('还没开始关画面'); };
  const picture = new Promise<void>(resolve => { finish = resolve; });
  const closing = closeEngineOutputs({ engine: Promise.reject(new Error('音频引擎没有响应')), picture, preload: Promise.reject(new Error('OBS 无响应')), monitor: undefined }, f);
  let settled = false; void closing.catch(() => undefined).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  finish();
  await expect(closing).rejects.toThrow('音频引擎没有响应');
  expect(f.closeFailed).toHaveBeenCalledOnce();
});
