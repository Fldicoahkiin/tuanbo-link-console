import { expect, it, vi } from 'vitest';
import type { LinkAction } from '@tb/schema';
import type { LinkDesktopApi } from '@tb/core/link';
import { executeObsCueAction } from './obs-ipc-executor';

vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));

it('显示来源作用于当前播出场景，其他 OBS 动作按原样执行', async () => {
  const desktop = { executeObsAction: vi.fn<LinkDesktopApi['executeObsAction']>().mockResolvedValue(),
    setObsProgramSourceEnabled: vi.fn<LinkDesktopApi['setObsProgramSourceEnabled']>().mockResolvedValue() };
  const show: LinkAction = { id: 'show', label: '显示来源 · 显示器采集', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: '显示器采集', enabled: true };
  const scene: LinkAction = { id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景 2' };
  await executeObsCueAction(desktop, show);
  await executeObsCueAction(desktop, scene);
  expect(desktop.setObsProgramSourceEnabled).toHaveBeenCalledExactlyOnceWith('显示器采集', true);
  expect(desktop.executeObsAction).toHaveBeenCalledExactlyOnceWith(scene);
});
