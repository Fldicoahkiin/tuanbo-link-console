import { describe, expect, it } from 'vitest';
import type { LinkObsInventory } from '@tb/core/link';
import { buildObsVisualResources, parseObsResource } from './resource-library-model';

describe('OBS 场景资源', () => {
  it('资源库只列 OBS 场景，拖放时只认场景', () => {
    const inventory: LinkObsInventory = {
      scenes: ['主场景', '备用场景'],
      inputs: ['主摄像头'],
      inputKinds: { 主摄像头: 'dshow_input' },
      inputAudioStates: {},
      sceneItems: { 主场景: ['主摄像头'] },
      filters: {},
      transitions: [],
      sourceSizes: {}
    };
    const resources = buildObsVisualResources(inventory);
    expect(resources).toEqual([{ id: 'scene:主场景', kind: 'scene', name: '主场景' }, { id: 'scene:备用场景', kind: 'scene', name: '备用场景' }]);
    expect(parseObsResource(JSON.stringify(resources[1]))).toEqual(resources[1]);
    expect(() => parseObsResource(JSON.stringify({ kind: 'sceneItem', name: '主摄像头' }))).toThrow('拖进来的不是 OBS 场景');
  });
});
