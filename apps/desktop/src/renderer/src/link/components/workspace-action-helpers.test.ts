import { describe, expect, it, vi } from 'vitest';

vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {}, linkFileViewModel: {} }));

import { actionsFromObsResource, resolveVisualLayer } from './workspace-action-helpers';

describe('workspace action helpers', () => {
  it('OBS 场景来源生成显示与可编辑画布变换两个有序动作', () => {
    const actions = actionsFromObsResource({ id: 'camera', kind: 'sceneItem', group: '摄像头', name: '机位一', sceneName: '场景', sourceName: '机位一', transform: { positionX: 320, positionY: 640, scaleX: 1, scaleY: 1, rotation: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, sourceWidth: 640, sourceHeight: 1280, outputWidth: 640, outputHeight: 1280, alignment: 0 } });

    expect(actions.map((action) => action.kind)).toEqual(['obs.setSceneItemEnabled', 'obs.setSceneItemTransform']);
    expect(actions[0]).toMatchObject({ sceneName: '团播联动台输出', sourceName: '机位一' });
    expect(actions[1]).toMatchObject({ transform: { positionX: 540, positionY: 960, scaleX: 1, scaleY: 1, alignment: 0 } });
  });

  it('OBS 未返回实际变换时不伪造画布参数', () => {
    const actions = actionsFromObsResource({ id: 'camera', kind: 'sceneItem', group: '摄像头', name: '机位一', sceneName: '场景', sourceName: '机位一' });

    expect(actions.map((action) => action.kind)).toEqual(['obs.setSceneItemEnabled']);
  });

  it('本地素材默认落在底层，OBS 默认落在顶层', () => {
    const layers = [
      { id: 'top', name: '图层 2', visible: true, locked: false },
      { id: 'bottom', name: '图层 1', visible: true, locked: false }
    ];

    expect(resolveVisualLayer(layers, undefined, 'top').id).toBe('top');
    expect(resolveVisualLayer(layers, undefined, 'bottom').id).toBe('bottom');
  });
});
