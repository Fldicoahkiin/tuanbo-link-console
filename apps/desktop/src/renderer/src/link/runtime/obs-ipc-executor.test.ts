import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type LinkAction } from '@tb/schema';
import type { LinkDesktopApi } from '@tb/core/link';
import { executeObsCueAction } from './obs-ipc-executor';

vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));

it('完整场景模式下显示来源作用于当前播出场景，其他 OBS 动作与受管模式按原样执行', async () => {
  const desktop = { executeObsAction: vi.fn<LinkDesktopApi['executeObsAction']>().mockResolvedValue(),
    setObsProgramSourceEnabled: vi.fn<LinkDesktopApi['setObsProgramSourceEnabled']>().mockResolvedValue() };
  const show: LinkAction = { id: 'show', label: '显示来源 · 显示器采集', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: '显示器采集', enabled: true };
  const scene: LinkAction = { id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景 2' };
  const scenes = { ...createEmptyLinkProject('完整场景'), obsOutputMode: 'scenes' as const };
  await executeObsCueAction(desktop, scenes, show);
  await executeObsCueAction(desktop, scenes, scene);
  expect(desktop.setObsProgramSourceEnabled).toHaveBeenCalledExactlyOnceWith('显示器采集', true);
  expect(desktop.executeObsAction).toHaveBeenCalledExactlyOnceWith(scene);
  await executeObsCueAction(desktop, { ...scenes, obsOutputMode: 'managed' }, show);
  expect(desktop.executeObsAction).toHaveBeenLastCalledWith(show);
  expect(desktop.setObsProgramSourceEnabled).toHaveBeenCalledOnce();
});
